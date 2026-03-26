import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { autoCommit, autoRevert } from "../src/git.ts";
import type { BunShell } from "../src/types.ts";

function createMockShell(
  responses: Array<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>
): BunShell {
  let callIndex = 0;
  const mock = (() => {
    const response = responses[callIndex] ?? {
      exitCode: 0,
      stdout: "",
      stderr: "",
    };
    callIndex++;
    const result = {
      exitCode: response.exitCode,
      stdout: Buffer.from(response.stdout),
      stderr: Buffer.from(response.stderr),
    };
    const chainable = {
      cwd(_dir: string) { return chainable; },
      quiet() { return chainable; },
      nothrow: () => Promise.resolve(result),
      then: (resolve: (val: typeof result) => void) => resolve(result),
    };
    return chainable;
  }) as unknown as BunShell;
  return mock;
}

describe("autoCommit", () => {
  it("returns success on successful commit", async () => {
    const $ = createMockShell([
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 1, stdout: "", stderr: "" },
      {
        exitCode: 0,
        stdout: "[main abc1234] test commit\n 1 file changed",
        stderr: "",
      },
      { exitCode: 0, stdout: "abc1234", stderr: "" },
    ]);

    const result = await autoCommit(
      $,
      "/tmp/test",
      "test description",
      "metric",
      100,
      {}
    );

    expect(result.success).toBe(true);
    expect(result.message).toContain("committed");
  });

  it("reports nothing to commit for clean tree", async () => {
    const $ = createMockShell([
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
    ]);

    const result = await autoCommit(
      $,
      "/tmp/test",
      "test",
      "metric",
      100,
      {}
    );

    expect(result.success).toBe(true);
    expect(result.message).toContain("nothing to commit");
  });

  it("reports failure on git add error", async () => {
    const $ = createMockShell([
      {
        exitCode: 128,
        stdout: "",
        stderr: "fatal: not a git repository",
      },
    ]);

    const result = await autoCommit(
      $,
      "/tmp/test",
      "test",
      "metric",
      100,
      {}
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain("git add failed");
  });
});

describe("autoRevert", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "autoresearch-git-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns success on successful revert", async () => {
    const $ = createMockShell([
      { exitCode: 0, stdout: "", stderr: "" },
    ]);

    const result = await autoRevert($, tmpDir);

    expect(result.success).toBe(true);
    expect(result.message).toContain("reverted");
    expect(result.message).toContain("autoresearch files preserved");
  });
});
