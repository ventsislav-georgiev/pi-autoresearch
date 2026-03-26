import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";

import type {
  AutoresearchConfig,
  AutoresearchRuntime,
  ExperimentResult,
  ExperimentState,
  MetricDef,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_BYTES = 32 * 1024;
export const DEFAULT_MAX_LINES = 200;

/** Prefix for structured metric output lines: `METRIC name=value` */
export const METRIC_LINE_PREFIX = "METRIC";

/** Metric names that could cause prototype pollution if used as object keys */
export const DENIED_METRIC_NAMES = new Set(["__proto__", "constructor", "prototype"]);

// ---------------------------------------------------------------------------
// truncateTail — local implementation (was OMP import)
// ---------------------------------------------------------------------------

export interface TruncateResult {
  content: string;
  truncated: boolean;
  truncatedBy?: "lines" | "bytes";
  totalLines?: number;
  outputLines?: number;
}

export function truncateTail(
  text: string,
  opts: { maxLines: number; maxBytes: number }
): TruncateResult {
  const lines = text.split("\n");
  if (lines.length <= opts.maxLines && Buffer.byteLength(text) <= opts.maxBytes) {
    return { content: text, truncated: false };
  }
  // Truncate by lines first
  if (lines.length > opts.maxLines) {
    const tail = lines.slice(-opts.maxLines);
    return {
      content: tail.join("\n"),
      truncated: true,
      truncatedBy: "lines",
      totalLines: lines.length,
      outputLines: opts.maxLines,
    };
  }
  // Then by bytes
  let result = text;
  while (Buffer.byteLength(result) > opts.maxBytes) {
    const idx = result.indexOf("\n");
    if (idx === -1) {
      result = result.slice(-opts.maxBytes);
      break;
    }
    result = result.slice(idx + 1);
  }
  const outputLines = result.split("\n").length;
  return {
    content: result,
    truncated: true,
    truncatedBy: "bytes",
    totalLines: lines.length,
    outputLines,
  };
}

// ---------------------------------------------------------------------------
// formatSize — local implementation (was OMP import)
// ---------------------------------------------------------------------------

export function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + "B";
  return (bytes / 1024).toFixed(1) + "KB";
}

// ---------------------------------------------------------------------------
// Metric parsing
// ---------------------------------------------------------------------------

/**
 * Parse structured METRIC lines from command output.
 * Format: METRIC name=value (one per line)
 * Example:
 *   METRIC total_µs=15200
 *   METRIC compile_µs=4200
 *
 * Names must be word chars, dots, or µ (rejects `=` and other specials).
 * Values must be finite numbers (rejects Infinity, NaN, hex, etc.).
 * Duplicate names: last occurrence wins (allows scripts to refine values).
 * Returns a Map preserving insertion order of first occurrence per key.
 */
export function parseMetricLines(output: string): Map<string, number> {
  const metrics = new Map<string, number>();
  const regex = new RegExp(
    `^${METRIC_LINE_PREFIX}\\s+([\\w.µ]+)=(\\S+)\\s*$`,
    "gm"
  );
  let match;
  while ((match = regex.exec(output)) !== null) {
    const name = match[1];
    if (DENIED_METRIC_NAMES.has(name)) continue;
    const value = Number(match[2]);
    if (Number.isFinite(value)) {
      metrics.set(name, value);
    }
  }
  return metrics;
}

// ---------------------------------------------------------------------------
// Number formatting
// ---------------------------------------------------------------------------

/** Format a number with comma-separated thousands: 15586 → "15,586" */
export function commas(n: number): string {
  const s = String(Math.round(n));
  const parts: string[] = [];
  for (let i = s.length; i > 0; i -= 3) {
    parts.unshift(s.slice(Math.max(0, i - 3), i));
  }
  return parts.join(",");
}

/** Format number with commas, preserving one decimal for fractional values */
export function fmtNum(n: number, decimals: number = 0): string {
  if (decimals > 0) {
    const int = Math.floor(Math.abs(n));
    const frac = (Math.abs(n) - int).toFixed(decimals).slice(1); // ".3"
    return (n < 0 ? "-" : "") + commas(int) + frac;
  }
  return commas(n);
}

export function formatNum(value: number | null, unit: string): string {
  if (value === null) return "—";
  const u = unit || "";
  // Integers: no decimals
  if (value === Math.round(value)) return fmtNum(value) + u;
  // Fractional: 2 decimal places
  return fmtNum(value, 2) + u;
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/** Lazy temp file allocator — returns the same path on subsequent calls */
export function createTempFileAllocator(): () => string {
  let p: string | undefined;
  return () => {
    if (!p) {
      const id = randomBytes(8).toString("hex");
      p = path.join(tmpdir(), `pi-experiment-${id}.log`);
    }
    return p;
  };
}

/** Format elapsed milliseconds as "Xm XXs" or "XXs" */
export function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/** Kill a process tree (best effort, tries process group first) */
export function killTree(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process may have already exited
    }
  }
}

// ---------------------------------------------------------------------------
// Command validation
// ---------------------------------------------------------------------------

/**
 * Check if a command's primary purpose is running autoresearch.sh.
 *
 * Strategy: strip common harmless prefixes (env vars, env/time/nice wrappers)
 * then check that the core command is autoresearch.sh invoked via a known
 * pattern. Rejects chaining tricks like "evil.py; autoresearch.sh" because
 * we require autoresearch.sh to be the *first* real command.
 */
export function isAutoresearchShCommand(command: string): boolean {
  let cmd = command.trim();

  // Strip leading env variable assignments: FOO=bar BAZ="qux" ...
  cmd = cmd.replace(/^(?:\w+=\S*\s+)+/, "");

  // Strip known harmless command wrappers (env, time, nice, nohup) repeatedly
  // Allows flags and their numeric values: e.g. "nice -n 10 time env ..."
  let prev: string;
  do {
    prev = cmd;
    cmd = cmd.replace(
      /^(?:env|time|nice|nohup)(?:\s+-\S+(?:\s+\d+)?)*\s+/,
      ""
    );
  } while (cmd !== prev);

  // Now the core command must be autoresearch.sh via a known invocation:
  //   autoresearch.sh
  //   ./autoresearch.sh
  //   /path/to/autoresearch.sh
  //   bash [-flags] autoresearch.sh
  //   bash [-flags] ./autoresearch.sh
  //   bash [-flags] /path/to/autoresearch.sh
  return /^(?:(?:bash|sh|source)\s+(?:-\w+\s+)*)?(?:\.\/|\/[\w/.-]*\/)?autoresearch\.sh(?:\s|$)/.test(
    cmd
  );
}

// ---------------------------------------------------------------------------
// Metric comparison & statistics
// ---------------------------------------------------------------------------

export function isBetter(
  current: number,
  best: number,
  direction: "lower" | "higher"
): boolean {
  return direction === "lower" ? current < best : current > best;
}

/** Compute the median of a numeric array (returns 0 for empty arrays) */
export function sortedMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** Get results in the current segment only */
export function currentResults(
  results: ExperimentResult[],
  segment: number
): ExperimentResult[] {
  return results.filter((r) => r.segment === segment);
}

/**
 * Compute confidence score for the best improvement vs. session noise floor.
 *
 * Uses Median Absolute Deviation (MAD) of all metric values in the current
 * segment as a robust noise estimator. Returns `|best_delta| / MAD`, where
 * best_delta is the improvement of the best kept metric over baseline.
 *
 * Returns null when there are fewer than 3 data points (insufficient data)
 * or when MAD is 0 (all values identical — no measurable noise).
 */
export function computeConfidence(
  results: ExperimentResult[],
  segment: number,
  direction: "lower" | "higher"
): number | null {
  const cur = currentResults(results, segment).filter((r) => r.metric > 0);
  if (cur.length < 3) return null;

  const values = cur.map((r) => r.metric);
  const median = sortedMedian(values);
  const deviations = values.map((v) => Math.abs(v - median));
  const mad = sortedMedian(deviations);

  if (mad === 0) return null;

  const baseline = findBaselineMetric(results, segment);
  if (baseline === null) return null;

  // Find best kept metric in current segment
  let bestKept: number | null = null;
  for (const r of cur) {
    if (r.status === "keep" && r.metric > 0) {
      if (bestKept === null || isBetter(r.metric, bestKept, direction)) {
        bestKept = r.metric;
      }
    }
  }
  if (bestKept === null || bestKept === baseline) return null;

  const delta = Math.abs(bestKept - baseline);
  return delta / mad;
}

// ---------------------------------------------------------------------------
// Config reading
// ---------------------------------------------------------------------------

/** Read autoresearch.config.json from the given directory */
export function readConfig(cwd: string): AutoresearchConfig {
  try {
    const configPath = path.join(cwd, "autoresearch.config.json");
    if (!fs.existsSync(configPath)) return {};
    return JSON.parse(fs.readFileSync(configPath, "utf-8")) as AutoresearchConfig;
  } catch {
    return {};
  }
}

/** Read maxExperiments from autoresearch.config.json (if it exists) */
export function readMaxExperiments(cwd: string): number | null {
  const config = readConfig(cwd);
  return typeof config.maxIterations === "number" && config.maxIterations > 0
    ? Math.floor(config.maxIterations)
    : null;
}

/**
 * Resolve the effective working directory.
 * Reads workingDir from autoresearch.config.json in ctxCwd.
 * Returns ctxCwd if not set. Supports relative (resolved against ctxCwd) and absolute paths.
 */
export function resolveWorkDir(ctxCwd: string): string {
  const config = readConfig(ctxCwd);
  if (!config.workingDir) return ctxCwd;
  return path.isAbsolute(config.workingDir)
    ? config.workingDir
    : path.resolve(ctxCwd, config.workingDir);
}

/**
 * Validate that the resolved working directory exists.
 * Returns an error message if it doesn't exist, or null if OK.
 */
export function validateWorkDir(ctxCwd: string): string | null {
  const workDir = resolveWorkDir(ctxCwd);
  if (workDir === ctxCwd) return null;
  try {
    const stat = fs.statSync(workDir);
    if (!stat.isDirectory()) {
      return `workingDir "${workDir}" (from autoresearch.config.json) is not a directory.`;
    }
  } catch {
    return `workingDir "${workDir}" (from autoresearch.config.json) does not exist.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Baseline helpers
// ---------------------------------------------------------------------------

/** Baseline = first experiment in current segment */
export function findBaselineMetric(
  results: ExperimentResult[],
  segment: number
): number | null {
  const cur = currentResults(results, segment);
  return cur.length > 0 ? cur[0].metric : null;
}

export function findBaselineRunNumber(
  results: ExperimentResult[],
  segment: number
): number | null {
  const index = results.findIndex((result) => result.segment === segment);
  return index >= 0 ? index + 1 : null;
}

/**
 * Find secondary metric baselines from the first experiment in current segment.
 * For metrics that didn't exist at baseline time, falls back to the first
 * occurrence of that metric in the current segment.
 */
export function findBaselineSecondary(
  results: ExperimentResult[],
  segment: number,
  knownMetrics?: MetricDef[]
): Record<string, number> {
  const cur = currentResults(results, segment);
  const base: Record<string, number> =
    cur.length > 0 ? { ...(cur[0].metrics ?? {}) } : {};

  // Fill in any known metrics missing from baseline with their first occurrence
  if (knownMetrics) {
    for (const sm of knownMetrics) {
      if (base[sm.name] === undefined) {
        for (const r of cur) {
          const val = (r.metrics ?? {})[sm.name];
          if (val !== undefined) {
            base[sm.name] = val;
            break;
          }
        }
      }
    }
  }

  return base;
}

// ---------------------------------------------------------------------------
// State factories
// ---------------------------------------------------------------------------

export function cloneExperimentState(state: ExperimentState): ExperimentState {
  return {
    ...state,
    results: state.results.map((result) => ({
      ...result,
      metrics: { ...result.metrics },
    })),
    secondaryMetrics: state.secondaryMetrics.map((metric) => ({ ...metric })),
  };
}

export function createExperimentState(): ExperimentState {
  return {
    results: [],
    bestMetric: null,
    bestDirection: "lower",
    metricName: "metric",
    metricUnit: "",
    secondaryMetrics: [],
    name: null,
    currentSegment: 0,
    maxExperiments: null,
    confidence: null,
  };
}

export function createSessionRuntime(): AutoresearchRuntime {
  return {
    autoresearchMode: false,
    experimentsThisSession: 0,
    lastRunChecks: null,
    lastRunDuration: null,
    runningExperiment: null,
    state: createExperimentState(),
  };
}

export function createRuntimeStore() {
  const runtimes = new Map<string, AutoresearchRuntime>();

  return {
    ensure(sessionKey: string): AutoresearchRuntime {
      let runtime = runtimes.get(sessionKey);
      if (!runtime) {
        runtime = createSessionRuntime();
        runtimes.set(sessionKey, runtime);
      }
      return runtime;
    },

    get(sessionKey: string): AutoresearchRuntime | undefined {
      return runtimes.get(sessionKey);
    },

    clear(sessionKey: string): void {
      runtimes.delete(sessionKey);
    },

    /** Iterate all runtimes (for event handlers that don't have sessionID) */
    entries(): IterableIterator<[string, AutoresearchRuntime]> {
      return runtimes.entries();
    },
  };
}
