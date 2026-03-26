import { describe, it, expect } from "bun:test";

import { runExperiment } from "../src/experiment.ts";

describe("runExperiment", () => {
  it("runs a successful command", async () => {
    const result = await runExperiment("echo hello", "/tmp", 10000);

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.output.trim()).toBe("hello");
  });

  it("captures non-zero exit code as crash", async () => {
    const result = await runExperiment("exit 1", "/tmp", 10000);

    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(false);
  });

  it("times out long-running commands", async () => {
    const result = await runExperiment("sleep 60", "/tmp", 500);

    expect(result.timedOut).toBe(true);
  }, 10000);

  it("handles abort signal", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);

    await expect(
      runExperiment("sleep 60", "/tmp", 30000, controller.signal)
    ).rejects.toThrow("aborted");
  }, 10000);

  it("captures stderr output", async () => {
    const result = await runExperiment(
      "echo error >&2",
      "/tmp",
      10000
    );

    expect(result.exitCode).toBe(0);
    expect(result.output.trim()).toBe("error");
  });
});
