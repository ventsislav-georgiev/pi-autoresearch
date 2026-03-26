import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import * as fs from "node:fs";

import type { BunShell } from "./types.ts";
import {
  createTempFileAllocator,
  DEFAULT_MAX_BYTES,
  killTree,
  truncateTail,
} from "./helpers.ts";

// ---------------------------------------------------------------------------
// Run experiment — process spawning with rolling buffer
// ---------------------------------------------------------------------------

export interface ExperimentRunResult {
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  fullOutputPath?: string;
  actualTotalBytes: number;
}

/**
 * Run a shell command as an experiment.
 *
 * Spawns the command via bash, captures output with a rolling buffer,
 * writes full output to a temp file when it exceeds the threshold.
 *
 * @param command - Shell command to run
 * @param workDir - Working directory
 * @param timeout - Timeout in milliseconds
 * @param signal - Optional abort signal
 */
export async function runExperiment(
  command: string,
  workDir: string,
  timeout: number,
  signal?: AbortSignal
): Promise<ExperimentRunResult> {
  const getTempFile = createTempFileAllocator();

  const result = await new Promise<{
    exitCode: number | null;
    killed: boolean;
    output: string;
    tempFilePath: string | undefined;
    actualTotalBytes: number;
  }>((resolve, reject) => {
    let processTimedOut = false;

    const child = spawn("bash", ["-c", command], {
      cwd: workDir,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Rolling buffer for tail truncation (keep 2x what we need)
    const chunks: Buffer[] = [];
    let chunksBytes = 0;
    const maxChunksBytes = DEFAULT_MAX_BYTES * 2;

    // Temp file for full output when it overflows
    let tempFilePath: string | undefined;
    let tempFileStream: ReturnType<typeof createWriteStream> | undefined;
    let totalBytes = 0;

    const handleData = (data: Buffer) => {
      totalBytes += data.length;

      // Start writing to temp file once we exceed the threshold
      if (totalBytes > DEFAULT_MAX_BYTES && !tempFilePath) {
        tempFilePath = getTempFile();
        tempFileStream = createWriteStream(tempFilePath);
        for (const chunk of chunks) {
          tempFileStream.write(chunk);
        }
      }

      if (tempFileStream) {
        tempFileStream.write(data);
      }

      // Keep rolling buffer of recent data
      chunks.push(data);
      chunksBytes += data.length;

      // Evict old chunks, then trim the first surviving chunk to a line
      // boundary. This avoids splitting multi-byte UTF-8 characters that
      // straddle chunk boundaries (which would produce U+FFFD on decode).
      while (chunksBytes > maxChunksBytes && chunks.length > 1) {
        const removed = chunks.shift()!;
        chunksBytes -= removed.length;
      }
      // Trim first surviving chunk to a newline boundary
      if (chunks.length > 0 && chunksBytes > maxChunksBytes) {
        const buf = chunks[0];
        const nlIdx = buf.indexOf(0x0a); // '\n'
        if (nlIdx !== -1 && nlIdx < buf.length - 1) {
          chunks[0] = buf.subarray(nlIdx + 1);
          chunksBytes -= nlIdx + 1;
        }
      }
    };

    if (child.stdout) child.stdout.on("data", handleData);
    if (child.stderr) child.stderr.on("data", handleData);

    // Timeout
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    if (timeout > 0) {
      timeoutHandle = setTimeout(() => {
        processTimedOut = true;
        if (child.pid) killTree(child.pid);
      }, timeout);
    }

    // Abort signal — kill immediately if pid exists, otherwise queue for spawn.
    const onAbort = () => {
      if (child.pid) killTree(child.pid);
      else {
        child.kill();
        child.once("spawn", () => {
          if (child.pid) killTree(child.pid);
        });
      }
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.on("error", (err) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (tempFileStream) tempFileStream.end();
      reject(err);
    });

    child.on("close", (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (tempFileStream) tempFileStream.end();

      if (signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }

      const fullBuffer = Buffer.concat(chunks);
      resolve({
        exitCode: code,
        killed: processTimedOut,
        output: fullBuffer.toString("utf-8"),
        tempFilePath,
        actualTotalBytes: totalBytes,
      });
    });
  });

  return {
    exitCode: result.exitCode,
    timedOut: result.killed,
    output: result.output,
    fullOutputPath: result.tempFilePath,
    actualTotalBytes: result.actualTotalBytes,
  };
}

// ---------------------------------------------------------------------------
// Run checks — backpressure/correctness checks via BunShell
// ---------------------------------------------------------------------------

export interface ChecksRunResult {
  pass: boolean;
  timedOut: boolean;
  output: string;
  duration: number;
}

/**
 * Run autoresearch.checks.sh using BunShell.
 *
 * @param $ - BunShell tagged template
 * @param workDir - Working directory
 * @param checksTimeout - Timeout in milliseconds
 * @param signal - Optional abort signal (not directly supported by BunShell, but kept for API consistency)
 */
export async function runChecks(
  $: BunShell,
  workDir: string,
  checksTimeout: number,
  _signal?: AbortSignal
): Promise<ChecksRunResult> {
  const checksPath = `${workDir}/autoresearch.checks.sh`;
  if (!fs.existsSync(checksPath)) {
    return { pass: true, timedOut: false, output: "", duration: 0 };
  }

  const ct0 = Date.now();
  try {
    // Use timeout command to enforce the timeout
    const timeoutSec = Math.ceil(checksTimeout / 1000);
    const checksResult = await $`timeout ${String(timeoutSec)} bash ${checksPath}`
      .cwd(workDir)
      .quiet()
      .nothrow();
    const duration = (Date.now() - ct0) / 1000;
    const output = (
      checksResult.stdout.toString() +
      "\n" +
      checksResult.stderr.toString()
    ).trim();

    // Exit code 124 = timeout killed it
    const timedOut = checksResult.exitCode === 124;
    const pass = checksResult.exitCode === 0;

    // Truncate checks output to last 80 lines
    const truncatedOutput = truncateTail(output, {
      maxLines: 80,
      maxBytes: 32 * 1024,
    });

    return {
      pass,
      timedOut,
      output: truncatedOutput.content,
      duration,
    };
  } catch (e) {
    const duration = (Date.now() - ct0) / 1000;
    return {
      pass: false,
      timedOut: false,
      output: e instanceof Error ? e.message : String(e),
      duration,
    };
  }
}
