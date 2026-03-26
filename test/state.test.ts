import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { reconstructState } from "../src/state.ts";
import { createSessionRuntime } from "../src/helpers.ts";
import type { AutoresearchRuntime } from "../src/types.ts";

describe("reconstructState", () => {
  let tmpDir: string;
  let runtime: AutoresearchRuntime;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "autoresearch-test-"));
    runtime = createSessionRuntime();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("starts fresh when no JSONL exists", () => {
    reconstructState(tmpDir, runtime);
    expect(runtime.autoresearchMode).toBe(false);
    expect(runtime.state.results.length).toBe(0);
    expect(runtime.state.name).toBeNull();
  });

  it("loads single config + results from JSONL", () => {
    const jsonlPath = path.join(tmpDir, "autoresearch.jsonl");
    const lines = [
      JSON.stringify({
        type: "config",
        name: "Test Session",
        metricName: "total_µs",
        metricUnit: "µs",
        bestDirection: "lower",
      }),
      JSON.stringify({
        run: 1,
        commit: "abc1234",
        metric: 15000,
        metrics: { compile_µs: 4200 },
        status: "keep",
        description: "baseline",
        timestamp: Date.now(),
        segment: 0,
        confidence: null,
      }),
      JSON.stringify({
        run: 2,
        commit: "def5678",
        metric: 14000,
        metrics: { compile_µs: 4100 },
        status: "keep",
        description: "optimize loop",
        timestamp: Date.now(),
        segment: 0,
        confidence: null,
      }),
    ];
    fs.writeFileSync(jsonlPath, lines.join("\n") + "\n");

    reconstructState(tmpDir, runtime);

    expect(runtime.autoresearchMode).toBe(true);
    expect(runtime.state.name).toBe("Test Session");
    expect(runtime.state.metricName).toBe("total_µs");
    expect(runtime.state.metricUnit).toBe("µs");
    expect(runtime.state.bestDirection).toBe("lower");
    expect(runtime.state.results.length).toBe(2);
    expect(runtime.state.bestMetric).toBe(15000);
    expect(runtime.state.currentSegment).toBe(0);
    expect(runtime.state.secondaryMetrics.length).toBe(1);
    expect(runtime.state.secondaryMetrics[0].name).toBe("compile_µs");
  });

  it("handles re-init (multiple configs) with segment increment", () => {
    const jsonlPath = path.join(tmpDir, "autoresearch.jsonl");
    const lines = [
      JSON.stringify({
        type: "config",
        name: "Session 1",
        metricName: "time_s",
        metricUnit: "s",
        bestDirection: "lower",
      }),
      JSON.stringify({
        run: 1,
        commit: "aaa1111",
        metric: 10,
        metrics: {},
        status: "keep",
        description: "baseline",
        timestamp: Date.now(),
        segment: 0,
        confidence: null,
      }),
      JSON.stringify({
        type: "config",
        name: "Session 2",
        metricName: "time_ms",
        metricUnit: "ms",
        bestDirection: "lower",
      }),
      JSON.stringify({
        run: 2,
        commit: "bbb2222",
        metric: 500,
        metrics: {},
        status: "keep",
        description: "new baseline",
        timestamp: Date.now(),
        segment: 1,
        confidence: null,
      }),
    ];
    fs.writeFileSync(jsonlPath, lines.join("\n") + "\n");

    reconstructState(tmpDir, runtime);

    expect(runtime.state.name).toBe("Session 2");
    expect(runtime.state.metricName).toBe("time_ms");
    expect(runtime.state.currentSegment).toBe(1);
    expect(runtime.state.results.length).toBe(2);
    expect(runtime.state.bestMetric).toBe(500);
  });

  it("skips malformed lines gracefully", () => {
    const jsonlPath = path.join(tmpDir, "autoresearch.jsonl");
    const lines = [
      JSON.stringify({
        type: "config",
        name: "Test",
        metricName: "m",
        metricUnit: "",
        bestDirection: "lower",
      }),
      "this is not valid json {{{",
      JSON.stringify({
        run: 1,
        commit: "abc1234",
        metric: 100,
        metrics: {},
        status: "keep",
        description: "test",
        timestamp: Date.now(),
        segment: 0,
        confidence: null,
      }),
    ];
    fs.writeFileSync(jsonlPath, lines.join("\n") + "\n");

    reconstructState(tmpDir, runtime);

    expect(runtime.state.results.length).toBe(1);
    expect(runtime.state.name).toBe("Test");
  });

  it("reads maxExperiments from config file", () => {
    const configPath = path.join(tmpDir, "autoresearch.config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ maxIterations: 25 })
    );

    const jsonlPath = path.join(tmpDir, "autoresearch.jsonl");
    fs.writeFileSync(
      jsonlPath,
      JSON.stringify({
        type: "config",
        name: "Test",
        metricName: "m",
        metricUnit: "",
        bestDirection: "lower",
      }) + "\n"
    );

    reconstructState(tmpDir, runtime);
    expect(runtime.state.maxExperiments).toBe(25);
  });

  it("resets runtime fields on reconstruct", () => {
    runtime.lastRunChecks = {
      pass: true,
      output: "ok",
      duration: 1,
    };
    runtime.lastRunDuration = 5;
    runtime.runningExperiment = {
      startedAt: Date.now(),
      command: "test",
    };
    runtime.experimentsThisSession = 10;

    reconstructState(tmpDir, runtime);

    expect(runtime.lastRunChecks).toBeNull();
    expect(runtime.lastRunDuration).toBeNull();
    expect(runtime.runningExperiment).toBeNull();
    expect(runtime.experimentsThisSession).toBe(0);
  });

  it("infers secondary metric units from name suffixes", () => {
    const jsonlPath = path.join(tmpDir, "autoresearch.jsonl");
    const lines = [
      JSON.stringify({
        type: "config",
        name: "Test",
        metricName: "total_µs",
        metricUnit: "µs",
        bestDirection: "lower",
      }),
      JSON.stringify({
        run: 1,
        commit: "abc1234",
        metric: 100,
        metrics: {
          compile_µs: 50,
          render_ms: 10,
          total_kb: 200,
        },
        status: "keep",
        description: "test",
        timestamp: Date.now(),
        segment: 0,
        confidence: null,
      }),
    ];
    fs.writeFileSync(jsonlPath, lines.join("\n") + "\n");

    reconstructState(tmpDir, runtime);

    const sm = runtime.state.secondaryMetrics;
    expect(sm.find((m) => m.name === "compile_µs")?.unit).toBe("µs");
    expect(sm.find((m) => m.name === "render_ms")?.unit).toBe("ms");
    expect(sm.find((m) => m.name === "total_kb")?.unit).toBe("kb");
  });
});
