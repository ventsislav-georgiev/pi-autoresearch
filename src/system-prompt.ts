import * as fs from "node:fs";
import * as path from "node:path";

import { resolveWorkDir } from "./helpers.ts";

// ---------------------------------------------------------------------------
// System prompt injection
// ---------------------------------------------------------------------------

const BENCHMARK_GUARDRAIL =
  "Be careful not to overfit to the benchmarks and do not cheat on the benchmarks.";

/**
 * Build extra system prompt text for autoresearch mode.
 *
 * Returns the extra text to append to the system prompt, or null if not
 * in autoresearch mode.
 *
 * @param directory - The base directory (plugin directory / session cwd)
 * @param autoresearchMode - Whether autoresearch mode is active
 */
export function buildSystemPromptExtra(
  directory: string,
  autoresearchMode: boolean
): string | null {
  if (!autoresearchMode) return null;

  const workDir = resolveWorkDir(directory);
  const mdPath = path.join(workDir, "autoresearch.md");
  const ideasPath = path.join(workDir, "autoresearch.ideas.md");
  const hasIdeas = fs.existsSync(ideasPath);

  const checksPath = path.join(workDir, "autoresearch.checks.sh");
  const hasChecks = fs.existsSync(checksPath);

  let extra =
    "\n\n## Autoresearch Mode (ACTIVE)" +
    "\nYou are in autoresearch mode. Optimize the primary metric through an autonomous experiment loop." +
    "\nUse init_experiment, run_experiment, and log_experiment tools. NEVER STOP until interrupted." +
    `\nExperiment rules: ${mdPath} — read this file at the start of every session and after compaction.` +
    "\nWrite promising but deferred optimizations as bullet points to autoresearch.ideas.md — don't let good ideas get lost." +
    `\n${BENCHMARK_GUARDRAIL}` +
    "\nIf the user sends a follow-on message while an experiment is running, finish the current run_experiment + log_experiment cycle first, then address their message in the next iteration.";

  if (hasChecks) {
    extra +=
      "\n\n## Backpressure Checks (ACTIVE)" +
      `\n${checksPath} exists and runs automatically after every passing benchmark in run_experiment.` +
      "\nIf the benchmark passes but checks fail, run_experiment will report it clearly." +
      "\nUse status 'checks_failed' in log_experiment when this happens — it behaves like a crash (no commit, changes auto-reverted)." +
      "\nYou cannot use status 'keep' when checks have failed." +
      "\nThe checks execution time does NOT affect the primary metric.";
  }

  if (hasIdeas) {
    extra += `\n\n💡 Ideas backlog exists at ${ideasPath} — check it for promising experiment paths. Prune stale entries.`;
  }

  return extra;
}
