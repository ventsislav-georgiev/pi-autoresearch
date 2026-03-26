import * as fs from "node:fs";
import * as path from "node:path";

import type { AutoresearchRuntime } from "./types.ts";
import {
  computeConfidence,
  createExperimentState,
  findBaselineMetric,
  readMaxExperiments,
  resolveWorkDir,
} from "./helpers.ts";

// ---------------------------------------------------------------------------
// State reconstruction from autoresearch.jsonl
// ---------------------------------------------------------------------------

/**
 * Reconstruct experiment state from autoresearch.jsonl.
 *
 * Reads the JSONL file from the effective working directory, parses config
 * headers and experiment results, and sets autoresearchMode if the file exists.
 *
 * @param directory - The base directory (plugin directory / session cwd)
 * @param runtime - The runtime to populate
 */
export function reconstructState(
  directory: string,
  runtime: AutoresearchRuntime
): void {
  runtime.lastRunChecks = null;
  runtime.lastRunDuration = null;
  runtime.runningExperiment = null;
  runtime.experimentsThisSession = 0;
  runtime.state = createExperimentState();

  const state = runtime.state;

  // Resolve effective working directory (config stays in directory, files in workDir)
  const workDir = resolveWorkDir(directory);

  // Read from autoresearch.jsonl (alongside autoresearch.md/sh)
  const jsonlPath = path.join(workDir, "autoresearch.jsonl");
  try {
    if (fs.existsSync(jsonlPath)) {
      let segment = 0;
      const lines = fs
        .readFileSync(jsonlPath, "utf-8")
        .trim()
        .split("\n")
        .filter(Boolean);

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;

          // Config header line — each header starts a new segment
          if (entry.type === "config") {
            if (entry.name) state.name = entry.name as string;
            if (entry.metricName)
              state.metricName = entry.metricName as string;
            if (entry.metricUnit !== undefined)
              state.metricUnit = entry.metricUnit as string;
            if (entry.bestDirection)
              state.bestDirection = entry.bestDirection as "lower" | "higher";
            // Increment segment (first config = 0, second = 1, etc.)
            if (state.results.length > 0) {
              segment++;
              // Reset per-segment tracking (mirrors live reinit behavior)
              state.secondaryMetrics = [];
            }
            state.currentSegment = segment;
            continue;
          }

          // Experiment result line
          state.results.push({
            commit: (entry.commit as string) ?? "",
            metric: (entry.metric as number) ?? 0,
            metrics: (entry.metrics as Record<string, number>) ?? {},
            status:
              (entry.status as
                | "keep"
                | "discard"
                | "crash"
                | "checks_failed") ?? "keep",
            description: (entry.description as string) ?? "",
            timestamp: (entry.timestamp as number) ?? 0,
            segment,
            confidence: (entry.confidence as number | null) ?? null,
            asi: entry.asi as Record<string, unknown> | undefined,
          });

          // Register secondary metrics
          const metrics = (entry.metrics as Record<string, number>) ?? {};
          for (const name of Object.keys(metrics)) {
            if (!state.secondaryMetrics.find((m) => m.name === name)) {
              let unit = "";
              if (name.endsWith("µs")) unit = "µs";
              else if (name.endsWith("_ms")) unit = "ms";
              else if (name.endsWith("_s") || name.endsWith("_sec")) unit = "s";
              else if (name.endsWith("_kb")) unit = "kb";
              else if (name.endsWith("_mb")) unit = "mb";
              state.secondaryMetrics.push({ name, unit });
            }
          }
        } catch {
          // Skip malformed lines
        }
      }

      if (state.results.length > 0) {
        state.bestMetric = findBaselineMetric(
          state.results,
          state.currentSegment
        );
        state.confidence = computeConfidence(
          state.results,
          state.currentSegment,
          state.bestDirection
        );
      }
    }
  } catch {
    // File read error — start fresh
  }

  // Read max experiments from config file
  state.maxExperiments = readMaxExperiments(directory);

  // Auto-enter autoresearch mode only when a persisted experiment log exists
  runtime.autoresearchMode = fs.existsSync(
    path.join(workDir, "autoresearch.jsonl")
  );
}
