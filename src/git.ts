import * as path from "node:path";
import type { BunShell } from "./types.ts";

// ---------------------------------------------------------------------------
// Git operations using BunShell ($)
// ---------------------------------------------------------------------------

export interface CommitResult {
  success: boolean;
  message: string;
  newSha?: string;
}

/**
 * Auto-commit all changes with a structured commit message.
 *
 * @param $ - BunShell tagged template
 * @param workDir - Working directory for git commands
 * @param description - Short description of the experiment
 * @param metricName - Name of the primary metric
 * @param metric - Primary metric value
 * @param secondaryMetrics - Additional metrics as { name: value }
 */
export async function autoCommit(
  $: BunShell,
  workDir: string,
  description: string,
  metricName: string,
  metric: number,
  secondaryMetrics: Record<string, number>
): Promise<CommitResult> {
  try {
    const resultData: Record<string, unknown> = {
      status: "keep",
      [metricName || "metric"]: metric,
      ...secondaryMetrics,
    };
    const trailerJson = JSON.stringify(resultData);
    const commitMsg = `${description}\n\nResult: ${trailerJson}`;

    // git add -A
    const addResult = await $`git add -A`.cwd(workDir).quiet().nothrow();
    if (addResult.exitCode !== 0) {
      const addErr = (
        addResult.stdout.toString() + addResult.stderr.toString()
      ).trim();
      return {
        success: false,
        message: `git add failed (exit ${addResult.exitCode}): ${addErr.slice(0, 200)}`,
      };
    }

    // Check if there are staged changes
    const diffResult = await $`git diff --cached --quiet`.cwd(workDir).quiet().nothrow();
    if (diffResult.exitCode === 0) {
      return {
        success: true,
        message: "nothing to commit (working tree clean)",
      };
    }

    // git commit
    const gitResult = await $`git commit -m ${commitMsg}`.cwd(workDir).quiet().nothrow();
    const gitOutput = (
      gitResult.stdout.toString() + gitResult.stderr.toString()
    ).trim();

    if (gitResult.exitCode !== 0) {
      return {
        success: false,
        message: `Git commit failed (exit ${gitResult.exitCode}): ${gitOutput.slice(0, 200)}`,
      };
    }

    const firstLine = gitOutput.split("\n")[0] || "";

    // Get the new commit SHA
    let newSha: string | undefined;
    try {
      const shaResult = await $`git rev-parse --short=7 HEAD`
        .cwd(workDir)
        .nothrow();
      const sha = shaResult.stdout.toString().trim();
      if (sha && sha.length >= 7) {
        newSha = sha;
      }
    } catch {
      // Keep the original commit hash if rev-parse fails
    }

    return {
      success: true,
      message: `committed — ${firstLine}`,
      newSha,
    };
  } catch (e) {
    return {
      success: false,
      message: `Git commit error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export interface RevertResult {
  success: boolean;
  message: string;
}

/**
 * Auto-revert all changes except protected autoresearch files.
 *
 * @param $ - BunShell tagged template
 * @param workDir - Working directory for git commands
 * @param protectedFiles - Files to preserve during revert
 */
export async function autoRevert(
  $: BunShell,
  workDir: string,
  protectedFiles: string[] = [
    "autoresearch.jsonl",
    "autoresearch.md",
    "autoresearch.ideas.md",
    "autoresearch.sh",
    "autoresearch.checks.sh",
  ]
): Promise<RevertResult> {
  try {
    // Stage protected files first, then revert everything else
    const stageCmd = protectedFiles
      .map((f) => `git add "${path.join(workDir, f)}" 2>/dev/null || true`)
      .join("; ");
    const revertResult = await $`bash -c ${stageCmd + "; git checkout -- .; git clean -fd 2>/dev/null"}`
      .cwd(workDir)
      .quiet()
      .nothrow();

    if (revertResult.exitCode !== 0) {
      const err = (
        revertResult.stdout.toString() + revertResult.stderr.toString()
      ).trim();
      return {
        success: false,
        message: `Git revert failed: ${err.slice(0, 200)}`,
      };
    }

    return {
      success: true,
      message: "reverted changes — autoresearch files preserved",
    };
  } catch (e) {
    return {
      success: false,
      message: `Git revert failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
