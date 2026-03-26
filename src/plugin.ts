import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import * as fs from "node:fs";
import * as path from "node:path";

import type { ASI, ExperimentResult, BunShell } from "./types.ts";
import { EXPERIMENT_MAX_LINES, EXPERIMENT_MAX_BYTES } from "./types.ts";
import {
  cloneExperimentState,
  computeConfidence,
  createRuntimeStore,
  currentResults,
  findBaselineMetric,
  findBaselineSecondary,
  formatNum,
  formatSize,
  isAutoresearchShCommand,
  parseMetricLines,
  readMaxExperiments,
  resolveWorkDir,
  truncateTail,
  validateWorkDir,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "./helpers.ts";
import { reconstructState } from "./state.ts";
import { autoCommit, autoRevert } from "./git.ts";
import { runExperiment, runChecks } from "./experiment.ts";
import { buildSystemPromptExtra } from "./system-prompt.ts";

export const AutoresearchPlugin: Plugin = async ({ $, directory }) => {
  const runtimeStore = createRuntimeStore();
  let activeSessionID: string | null = null;

  return {
    tool: {
      init_experiment: tool({
        description:
          "Initialize the experiment session. Call once before the first run_experiment to set the name, primary metric, unit, and direction. Writes the config header to autoresearch.jsonl.\n\nGuidelines:\n- Call init_experiment exactly once at the start of an autoresearch session, before the first run_experiment.\n- If autoresearch.jsonl already exists with a config, do NOT call init_experiment again.\n- If the optimization target changes (different benchmark, metric, or workload), call init_experiment again to insert a new config header and reset the baseline.",
        args: {
          name: tool.schema
            .string()
            .describe(
              'Human-readable name for this experiment session (e.g. "Optimizing liquid for fastest execution and parsing")'
            ),
          metric_name: tool.schema
            .string()
            .describe(
              'Display name for the primary metric (e.g. "total_µs", "bundle_kb", "val_bpb"). Shown in dashboard headers.'
            ),
          metric_unit: tool.schema
            .string()
            .optional()
            .describe(
              'Unit for the primary metric. Use "µs", "ms", "s", "kb", "mb", or "" for unitless. Default: ""'
            ),
          direction: tool.schema
            .string()
            .optional()
            .describe(
              'Whether "lower" or "higher" is better for the primary metric. Default: "lower".'
            ),
        },
        async execute(args, ctx) {
          const runtime = runtimeStore.ensure(ctx.sessionID);
          activeSessionID = ctx.sessionID;
          const state = runtime.state;

          const workDirError = validateWorkDir(directory);
          if (workDirError) {
            return `❌ ${workDirError}`;
          }

          const isReinit = state.results.length > 0;

          state.name = args.name;
          state.metricName = args.metric_name;
          state.metricUnit = args.metric_unit ?? "";
          if (args.direction === "lower" || args.direction === "higher") {
            state.bestDirection = args.direction;
          }
          if (isReinit) {
            state.currentSegment++;
          }
          state.bestMetric = null;
          state.secondaryMetrics = [];
          state.confidence = null;

          state.maxExperiments = readMaxExperiments(directory);

          const workDir = resolveWorkDir(directory);
          try {
            const jsonlPath = path.join(workDir, "autoresearch.jsonl");
            const config = JSON.stringify({
              type: "config",
              name: state.name,
              metricName: state.metricName,
              metricUnit: state.metricUnit,
              bestDirection: state.bestDirection,
            });
            if (isReinit) {
              fs.appendFileSync(jsonlPath, config + "\n");
            } else {
              fs.writeFileSync(jsonlPath, config + "\n");
            }
          } catch (e) {
            return `⚠️ Failed to write autoresearch.jsonl: ${e instanceof Error ? e.message : String(e)}`;
          }

          runtime.autoresearchMode = true;

          const reinitNote = isReinit
            ? " (re-initialized — previous results archived, new baseline needed)"
            : "";
          const limitNote =
            state.maxExperiments !== null
              ? `\nMax iterations: ${state.maxExperiments} (from autoresearch.config.json)`
              : "";
          const workDirNote =
            workDir !== directory ? `\nWorking directory: ${workDir}` : "";

          return `✅ Experiment initialized: "${state.name}"${reinitNote}\nMetric: ${state.metricName} (${state.metricUnit || "unitless"}, ${state.bestDirection} is better)${limitNote}${workDirNote}\nConfig written to autoresearch.jsonl. Now run the baseline with run_experiment.`;
        },
      }),

      run_experiment: tool({
        description: `Run a shell command as an experiment. Times wall-clock duration, captures output, detects pass/fail via exit code. Output is truncated to last ${EXPERIMENT_MAX_LINES} lines or ${EXPERIMENT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Use for any autoresearch experiment.\n\nGuidelines:\n- Use run_experiment instead of bash when running experiment commands — it handles timing and output capture automatically.\n- After run_experiment, always call log_experiment to record the result.\n- If the benchmark script outputs structured METRIC lines (e.g. 'METRIC total_µs=15200'), run_experiment will parse them automatically and suggest exact values for log_experiment. Use these parsed values directly instead of extracting them manually from the output.`,
        args: {
          command: tool.schema
            .string()
            .describe(
              "Shell command to run (e.g. 'pnpm test:vitest', 'uv run train.py')"
            ),
          timeout_seconds: tool.schema
            .number()
            .optional()
            .describe("Kill after this many seconds (default: 600)"),
          checks_timeout_seconds: tool.schema
            .number()
            .optional()
            .describe(
              "Kill autoresearch.checks.sh after this many seconds (default: 300). Only relevant when the checks file exists."
            ),
        },
        async execute(args, ctx) {
          const runtime = runtimeStore.ensure(ctx.sessionID);
          activeSessionID = ctx.sessionID;
          const state = runtime.state;

          const workDirError = validateWorkDir(directory);
          if (workDirError) {
            return `❌ ${workDirError}`;
          }
          const workDir = resolveWorkDir(directory);

          if (state.maxExperiments !== null) {
            const segCount = currentResults(
              state.results,
              state.currentSegment
            ).length;
            if (segCount >= state.maxExperiments) {
              return `🛑 Maximum experiments reached (${state.maxExperiments}). The experiment loop is done. To continue, call init_experiment to start a new segment.`;
            }
          }

          const timeout = (args.timeout_seconds ?? 600) * 1000;

          const autoresearchShPath = path.join(workDir, "autoresearch.sh");
          if (
            fs.existsSync(autoresearchShPath) &&
            !isAutoresearchShCommand(args.command)
          ) {
            return `❌ autoresearch.sh exists — you must run it instead of a custom command.\n\nFound: ${autoresearchShPath}\nYour command: ${args.command}\n\nUse: run_experiment({ command: "bash autoresearch.sh" }) or run_experiment({ command: "./autoresearch.sh" })`;
          }

          runtime.runningExperiment = {
            startedAt: Date.now(),
            command: args.command,
          };

          const t0 = Date.now();
          let experimentResult;
          try {
            experimentResult = await runExperiment(
              args.command,
              workDir,
              timeout,
              ctx.abort
            );
          } finally {
            runtime.runningExperiment = null;
          }

          const durationSeconds = (Date.now() - t0) / 1000;
          runtime.lastRunDuration = durationSeconds;
          const benchmarkPassed =
            experimentResult.exitCode === 0 && !experimentResult.timedOut;

          let checksPass: boolean | null = null;
          let checksTimedOut = false;
          let checksOutput = "";
          let checksDuration = 0;

          const checksPath = path.join(workDir, "autoresearch.checks.sh");
          if (benchmarkPassed && fs.existsSync(checksPath)) {
            const checksTimeout =
              (args.checks_timeout_seconds ?? 300) * 1000;
            const checksResult = await runChecks(
              $ as unknown as BunShell,
              workDir,
              checksTimeout,
              ctx.abort
            );
            checksDuration = checksResult.duration;
            checksTimedOut = checksResult.timedOut;
            checksPass = checksResult.pass;
            checksOutput = checksResult.output;
          }

          runtime.lastRunChecks =
            checksPass !== null
              ? { pass: checksPass, output: checksOutput, duration: checksDuration }
              : null;

          const passed = benchmarkPassed && (checksPass === null || checksPass);

          let fullOutputPath: string | undefined = experimentResult.fullOutputPath;
          const totalLines = experimentResult.output.split("\n").length;
          if (
            !fullOutputPath &&
            (experimentResult.actualTotalBytes > EXPERIMENT_MAX_BYTES ||
              totalLines > EXPERIMENT_MAX_LINES)
          ) {
            const { createTempFileAllocator } = await import("./helpers.ts");
            fullOutputPath = createTempFileAllocator()();
            fs.writeFileSync(fullOutputPath, experimentResult.output);
          }

          const displayTruncation = truncateTail(experimentResult.output, {
            maxLines: DEFAULT_MAX_LINES,
            maxBytes: DEFAULT_MAX_BYTES,
          });

          const llmTruncation = truncateTail(experimentResult.output, {
            maxLines: EXPERIMENT_MAX_LINES,
            maxBytes: EXPERIMENT_MAX_BYTES,
          });

          const parsedMetricMap = parseMetricLines(experimentResult.output);
          const parsedMetrics =
            parsedMetricMap.size > 0
              ? Object.fromEntries(parsedMetricMap)
              : null;
          const parsedPrimary =
            parsedMetricMap.get(state.metricName) ?? null;

          let text = "";
          if (experimentResult.timedOut) {
            text += `⏰ TIMEOUT after ${durationSeconds.toFixed(1)}s\n`;
          } else if (!benchmarkPassed) {
            text += `💥 FAILED (exit code ${experimentResult.exitCode}) in ${durationSeconds.toFixed(1)}s\n`;
          } else if (checksTimedOut) {
            text += `✅ Benchmark PASSED in ${durationSeconds.toFixed(1)}s\n`;
            text += `⏰ CHECKS TIMEOUT (autoresearch.checks.sh) after ${checksDuration.toFixed(1)}s\n`;
            text += `Log this as 'checks_failed' — the benchmark metric is valid but checks timed out.\n`;
          } else if (checksPass === false) {
            text += `✅ Benchmark PASSED in ${durationSeconds.toFixed(1)}s\n`;
            text += `💥 CHECKS FAILED (autoresearch.checks.sh) in ${checksDuration.toFixed(1)}s\n`;
            text += `Log this as 'checks_failed' — the benchmark metric is valid but correctness checks did not pass.\n`;
          } else {
            text += `✅ PASSED in ${durationSeconds.toFixed(1)}s\n`;
            if (checksPass === true) {
              text += `✅ Checks passed in ${checksDuration.toFixed(1)}s\n`;
            }
          }

          if (state.bestMetric !== null) {
            text += `📊 Current best ${state.metricName}: ${formatNum(state.bestMetric, state.metricUnit)}\n`;
          }

          if (parsedMetrics) {
            const secondary = Object.entries(parsedMetrics).filter(
              ([k]) => k !== state.metricName
            );

            text += `\n📐 Parsed metrics:`;
            if (parsedPrimary !== null) {
              text += ` ★ ${state.metricName}=${formatNum(parsedPrimary, state.metricUnit)}`;
            }
            for (const [name, value] of secondary) {
              const sm = state.secondaryMetrics.find((m) => m.name === name);
              const unit = sm?.unit ?? "";
              text += ` ${name}=${formatNum(value, unit)}`;
            }

            text += `\nUse these values directly in log_experiment (metric: ${parsedPrimary ?? "?"}, metrics: {${secondary.map(([k, v]) => `"${k}": ${v}`).join(", ")}})\n`;
          }

          text += `\n${llmTruncation.content}`;

          if (llmTruncation.truncated) {
            if (llmTruncation.truncatedBy === "lines") {
              text += `\n\n[Showing last ${llmTruncation.outputLines} of ${llmTruncation.totalLines} lines.`;
            } else {
              text += `\n\n[Showing last ${llmTruncation.outputLines} lines (${formatSize(EXPERIMENT_MAX_BYTES)} limit).`;
            }
            if (fullOutputPath) {
              text += ` Full output: ${fullOutputPath}`;
            }
            text += `]`;
          }

          if (checksPass === false) {
            text += `\n\n── Checks output (last 80 lines) ──\n${checksOutput.split("\n").slice(-80).join("\n")}`;
          }

          return text;
        },
      }),

      log_experiment: tool({
        description:
          "Record an experiment result. Tracks metrics and persists to autoresearch.jsonl. Call after every run_experiment.\n\nGuidelines:\n- Always call log_experiment after run_experiment to record the result.\n- log_experiment automatically runs git add -A && git commit on 'keep', and auto-reverts code changes on 'discard'/'crash'/'checks_failed' (autoresearch files are preserved). Do NOT commit or revert manually.\n- Use status 'keep' if the PRIMARY metric improved. 'discard' if worse or unchanged. 'crash' if it failed. Secondary metrics are for monitoring — they almost never affect keep/discard. Only discard a primary improvement if a secondary metric degraded catastrophically, and explain why in the description.\n- log_experiment reports a confidence score after 3+ runs (best improvement as a multiple of the noise floor). ≥2.0× = likely real, <1.0× = within noise. If confidence is below 1.0×, consider re-running the same experiment to confirm before keeping. The score is advisory — it never auto-discards.\n- If you discover complex but promising optimizations you won't pursue immediately, append them as bullet points to autoresearch.ideas.md. Don't let good ideas get lost.\n- Always include the asi parameter. At minimum: {\"hypothesis\": \"what you tried\"}. On discard/crash, also include rollback_reason and next_action_hint. Add any other key/value pairs that capture what you learned — dead ends, surprising findings, error details, bottlenecks. This is the only structured memory that survives reverts.",
        args: {
          commit: tool.schema
            .string()
            .describe("Git commit hash (short, 7 chars)"),
          metric: tool.schema
            .number()
            .describe(
              "The primary optimization metric value (e.g. seconds, val_bpb). 0 for crashes."
            ),
          status: tool.schema.enum([
            "keep",
            "discard",
            "crash",
            "checks_failed",
          ]),
          description: tool.schema
            .string()
            .describe("Short description of what this experiment tried"),
          metrics: tool.schema
            .record(tool.schema.string(), tool.schema.number())
            .optional()
            .describe(
              'Additional metrics to track as { name: value } pairs, e.g. { "compile_µs": 4200, "render_µs": 9800 }. These are shown alongside the primary metric for tradeoff monitoring.'
            ),
          force: tool.schema
            .boolean()
            .optional()
            .describe(
              "Set to true to allow adding a new secondary metric that wasn't tracked before. Only use for metrics that have proven very valuable to watch."
            ),
          asi: tool.schema
            .record(tool.schema.string(), tool.schema.unknown())
            .optional()
            .describe(
              "Actionable Side Information — structured diagnostics for this run. Free-form key/value pairs. Parsed ASI from run_experiment output is merged automatically; use this to add or override fields."
            ),
        },
        async execute(args, ctx) {
          const runtime = runtimeStore.ensure(ctx.sessionID);
          activeSessionID = ctx.sessionID;
          const state = runtime.state;

          const workDirError = validateWorkDir(directory);
          if (workDirError) {
            return `❌ ${workDirError}`;
          }
          const workDir = resolveWorkDir(directory);
          const secondaryMetrics = args.metrics ?? {};

          if (
            args.status === "keep" &&
            runtime.lastRunChecks &&
            !runtime.lastRunChecks.pass
          ) {
            return `❌ Cannot keep — autoresearch.checks.sh failed.\n\n${runtime.lastRunChecks.output.slice(-500)}\n\nLog as 'checks_failed' instead. The benchmark metric is valid but correctness checks did not pass.`;
          }

          if (state.secondaryMetrics.length > 0) {
            const knownNames = new Set(
              state.secondaryMetrics.map((m) => m.name)
            );
            const providedNames = new Set(Object.keys(secondaryMetrics));

            const missing = [...knownNames].filter(
              (n) => !providedNames.has(n)
            );
            if (missing.length > 0) {
              return `❌ Missing secondary metrics: ${missing.join(", ")}\n\nYou must provide all previously tracked metrics. Expected: ${[...knownNames].join(", ")}\nGot: ${[...providedNames].join(", ") || "(none)"}\n\nFix: include ${missing.map((m) => `"${m}": <value>`).join(", ")} in the metrics parameter.`;
            }

            const newMetrics = [...providedNames].filter(
              (n) => !knownNames.has(n)
            );
            if (newMetrics.length > 0 && !args.force) {
              return `❌ New secondary metric${newMetrics.length > 1 ? "s" : ""} not previously tracked: ${newMetrics.join(", ")}\n\nExisting metrics: ${[...knownNames].join(", ")}\n\nIf this metric has proven very valuable to watch, call log_experiment again with force: true to add it. Otherwise, remove it from the metrics parameter.`;
            }
          }

          const mergedASI =
            args.asi && Object.keys(args.asi).length > 0
              ? (args.asi as ASI)
              : undefined;

          const experiment: ExperimentResult = {
            commit: args.commit.slice(0, 7),
            metric: args.metric,
            metrics: secondaryMetrics,
            status: args.status,
            description: args.description,
            timestamp: Date.now(),
            segment: state.currentSegment,
            confidence: null,
            asi: mergedASI,
          };

          state.results.push(experiment);
          runtime.experimentsThisSession++;

          for (const name of Object.keys(secondaryMetrics)) {
            if (!state.secondaryMetrics.find((m) => m.name === name)) {
              let unit = "";
              if (name.endsWith("µs")) unit = "µs";
              else if (name.endsWith("_ms")) unit = "ms";
              else if (name.endsWith("_s") || name.endsWith("_sec"))
                unit = "s";
              else if (name.endsWith("_kb")) unit = "kb";
              else if (name.endsWith("_mb")) unit = "mb";
              state.secondaryMetrics.push({ name, unit });
            }
          }

          state.bestMetric = findBaselineMetric(
            state.results,
            state.currentSegment
          );

          state.confidence = computeConfidence(
            state.results,
            state.currentSegment,
            state.bestDirection
          );
          experiment.confidence = state.confidence;

          const segmentCount = currentResults(
            state.results,
            state.currentSegment
          ).length;
          let text = `Logged #${state.results.length}: ${experiment.status} — ${experiment.description}`;

          if (state.bestMetric !== null) {
            text += `\nBaseline ${state.metricName}: ${formatNum(state.bestMetric, state.metricUnit)}`;
            if (
              segmentCount > 1 &&
              args.status === "keep" &&
              args.metric > 0
            ) {
              const delta = args.metric - state.bestMetric;
              const pct = ((delta / state.bestMetric) * 100).toFixed(1);
              const sign = delta > 0 ? "+" : "";
              text += ` | this: ${formatNum(args.metric, state.metricUnit)} (${sign}${pct}%)`;
            }
          }

          if (Object.keys(secondaryMetrics).length > 0) {
            const baselines = findBaselineSecondary(
              state.results,
              state.currentSegment,
              state.secondaryMetrics
            );
            const parts: string[] = [];
            for (const [name, value] of Object.entries(secondaryMetrics)) {
              const def = state.secondaryMetrics.find(
                (m) => m.name === name
              );
              const unit = def?.unit ?? "";
              let part = `${name}: ${formatNum(value, unit)}`;
              const bv = baselines[name];
              if (
                bv !== undefined &&
                state.results.length > 1 &&
                bv !== 0
              ) {
                const d = value - bv;
                const p = ((d / bv) * 100).toFixed(1);
                const s = d > 0 ? "+" : "";
                part += ` (${s}${p}%)`;
              }
              parts.push(part);
            }
            text += `\nSecondary: ${parts.join("  ")}`;
          }

          if (mergedASI) {
            const asiParts: string[] = [];
            for (const [k, v] of Object.entries(mergedASI)) {
              const s = typeof v === "string" ? v : JSON.stringify(v);
              asiParts.push(
                `${k}: ${s.length > 80 ? s.slice(0, 77) + "…" : s}`
              );
            }
            if (asiParts.length > 0) {
              text += `\n📋 ASI: ${asiParts.join(" | ")}`;
            }
          }

          if (state.confidence !== null) {
            const confStr = state.confidence.toFixed(1);
            if (state.confidence >= 2.0) {
              text += `\n📊 Confidence: ${confStr}× noise floor — improvement is likely real`;
            } else if (state.confidence >= 1.0) {
              text += `\n📊 Confidence: ${confStr}× noise floor — improvement is above noise but marginal`;
            } else {
              text += `\n⚠️ Confidence: ${confStr}× noise floor — improvement is within noise. Consider re-running to confirm before keeping.`;
            }
          }

          text += `\n(${segmentCount} experiments`;
          if (state.maxExperiments !== null) {
            text += ` / ${state.maxExperiments} max`;
          }
          text += `)`;

          if (args.status === "keep") {
            const commitResult = await autoCommit(
              $ as unknown as BunShell,
              workDir,
              args.description,
              state.metricName,
              args.metric,
              secondaryMetrics
            );
            if (commitResult.success) {
              text += `\n📝 Git: ${commitResult.message}`;
              if (commitResult.newSha) {
                experiment.commit = commitResult.newSha;
              }
            } else {
              text += `\n⚠️ ${commitResult.message}`;
            }
          }

          try {
            const jsonlPath = path.join(workDir, "autoresearch.jsonl");
            const jsonlEntry: Record<string, unknown> = {
              run: state.results.length,
              ...experiment,
            };
            if (!mergedASI) delete jsonlEntry.asi;
            fs.appendFileSync(jsonlPath, JSON.stringify(jsonlEntry) + "\n");
          } catch (e) {
            text += `\n⚠️ Failed to write autoresearch.jsonl: ${e instanceof Error ? e.message : String(e)}`;
          }

          if (args.status !== "keep") {
            const revertResult = await autoRevert(
              $ as unknown as BunShell,
              workDir
            );
            if (revertResult.success) {
              text += `\n📝 Git: ${revertResult.message} (${args.status})`;
            } else {
              text += `\n⚠️ ${revertResult.message}`;
            }
          }

          const wallClockSeconds = runtime.lastRunDuration;
          runtime.runningExperiment = null;
          runtime.lastRunChecks = null;
          runtime.lastRunDuration = null;

          const limitReached =
            state.maxExperiments !== null &&
            segmentCount >= state.maxExperiments;
          if (limitReached) {
            text += `\n\n🛑 Maximum experiments reached (${state.maxExperiments}). STOP the experiment loop now.`;
            runtime.autoresearchMode = false;
          }

          return text;
        },
      }),
    },

    event: async ({ event }) => {
      if (event.type === "session.created") {
        const props = event.properties as { info: { id: string } };
        const sessionID = props.info.id;
        const runtime = runtimeStore.ensure(sessionID);
        activeSessionID = sessionID;
        reconstructState(directory, runtime);
      }

      if (event.type === "session.deleted") {
        const props = event.properties as { info: { id: string } };
        const sessionID = props.info.id;
        if (sessionID) {
          runtimeStore.clear(sessionID);
        }
      }

      if (event.type === "session.idle") {
        for (const [, runtime] of runtimeStore.entries()) {
          runtime.runningExperiment = null;
        }
      }
    },

    "experimental.chat.system.transform": async (_input, output) => {
      let autoresearchMode = false;
      for (const [, runtime] of runtimeStore.entries()) {
        if (runtime.autoresearchMode) {
          autoresearchMode = true;
          break;
        }
      }

      if (!autoresearchMode) return;

      const extra = buildSystemPromptExtra(directory, true);
      if (extra) {
        output.system.push(extra);
      }
    },
  };
};
