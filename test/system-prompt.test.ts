import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { buildSystemPromptExtra } from "../src/system-prompt.ts";

describe("buildSystemPromptExtra", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "autoresearch-sysprompt-test-")
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when not in autoresearch mode", () => {
    expect(buildSystemPromptExtra(tmpDir, false)).toBeNull();
  });

  it("returns prompt when in autoresearch mode", () => {
    fs.writeFileSync(path.join(tmpDir, "autoresearch.md"), "# Test");
    const result = buildSystemPromptExtra(tmpDir, true);
    expect(result).not.toBeNull();
    expect(result).toContain("Autoresearch Mode (ACTIVE)");
    expect(result).toContain("NEVER STOP");
  });

  it("includes checks info when autoresearch.checks.sh exists", () => {
    fs.writeFileSync(path.join(tmpDir, "autoresearch.md"), "# Test");
    fs.writeFileSync(
      path.join(tmpDir, "autoresearch.checks.sh"),
      "#!/bin/bash\nexit 0"
    );

    const result = buildSystemPromptExtra(tmpDir, true);
    expect(result).toContain("Backpressure Checks (ACTIVE)");
    expect(result).toContain("checks_failed");
  });

  it("includes ideas info when autoresearch.ideas.md exists", () => {
    fs.writeFileSync(path.join(tmpDir, "autoresearch.md"), "# Test");
    fs.writeFileSync(
      path.join(tmpDir, "autoresearch.ideas.md"),
      "- idea 1"
    );

    const result = buildSystemPromptExtra(tmpDir, true);
    expect(result).toContain("Ideas backlog exists");
  });

  it("includes both checks and ideas when both exist", () => {
    fs.writeFileSync(path.join(tmpDir, "autoresearch.md"), "# Test");
    fs.writeFileSync(
      path.join(tmpDir, "autoresearch.checks.sh"),
      "#!/bin/bash\nexit 0"
    );
    fs.writeFileSync(
      path.join(tmpDir, "autoresearch.ideas.md"),
      "- idea 1"
    );

    const result = buildSystemPromptExtra(tmpDir, true);
    expect(result).toContain("Backpressure Checks (ACTIVE)");
    expect(result).toContain("Ideas backlog exists");
  });
});
