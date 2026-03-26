import { describe, it, expect } from "bun:test";
import {
  parseMetricLines,
  isAutoresearchShCommand,
  computeConfidence,
  isBetter,
  truncateTail,
  formatElapsed,
  formatNum,
  commas,
  fmtNum,
  sortedMedian,
  formatSize,
} from "../src/helpers.ts";
import type { ExperimentResult } from "../src/types.ts";

describe("parseMetricLines", () => {
  it("parses valid METRIC lines", () => {
    const output = "METRIC total_µs=15200\nMETRIC compile_µs=4200\n";
    const result = parseMetricLines(output);
    expect(result.get("total_µs")).toBe(15200);
    expect(result.get("compile_µs")).toBe(4200);
    expect(result.size).toBe(2);
  });

  it("rejects invalid values (NaN, Infinity)", () => {
    const output = "METRIC foo=NaN\nMETRIC bar=Infinity\nMETRIC baz=hello\n";
    const result = parseMetricLines(output);
    expect(result.size).toBe(0);
  });

  it("last occurrence wins for duplicate names", () => {
    const output = "METRIC x=1\nMETRIC x=2\n";
    const result = parseMetricLines(output);
    expect(result.get("x")).toBe(2);
    expect(result.size).toBe(1);
  });

  it("rejects denied names (__proto__, constructor, prototype)", () => {
    const output =
      "METRIC __proto__=1\nMETRIC constructor=2\nMETRIC prototype=3\n";
    const result = parseMetricLines(output);
    expect(result.size).toBe(0);
  });

  it("returns empty map for empty input", () => {
    const result = parseMetricLines("");
    expect(result.size).toBe(0);
  });

  it("returns empty map for no METRIC lines", () => {
    const result = parseMetricLines("some random output\nno metrics here\n");
    expect(result.size).toBe(0);
  });

  it("handles negative and fractional values", () => {
    const output = "METRIC neg=-3.14\nMETRIC frac=0.001\n";
    const result = parseMetricLines(output);
    expect(result.get("neg")).toBe(-3.14);
    expect(result.get("frac")).toBe(0.001);
  });
});

describe("isAutoresearchShCommand", () => {
  it("accepts ./autoresearch.sh", () => {
    expect(isAutoresearchShCommand("./autoresearch.sh")).toBe(true);
  });

  it("accepts bash autoresearch.sh", () => {
    expect(isAutoresearchShCommand("bash autoresearch.sh")).toBe(true);
  });

  it("accepts with env vars prefix", () => {
    expect(isAutoresearchShCommand("FOO=bar ./autoresearch.sh")).toBe(true);
  });

  it("accepts with time wrapper", () => {
    expect(isAutoresearchShCommand("time ./autoresearch.sh")).toBe(true);
  });

  it("accepts with nice wrapper", () => {
    expect(isAutoresearchShCommand("nice -n 10 bash autoresearch.sh")).toBe(
      true
    );
  });

  it("accepts bare autoresearch.sh", () => {
    expect(isAutoresearchShCommand("autoresearch.sh")).toBe(true);
  });

  it("accepts with absolute path", () => {
    expect(isAutoresearchShCommand("/home/user/autoresearch.sh")).toBe(true);
  });

  it("accepts bash -x autoresearch.sh", () => {
    expect(isAutoresearchShCommand("bash -x autoresearch.sh")).toBe(true);
  });

  it("rejects evil chaining", () => {
    expect(
      isAutoresearchShCommand("evil.py; autoresearch.sh")
    ).toBe(false);
  });

  it("rejects completely different command", () => {
    expect(isAutoresearchShCommand("pnpm test")).toBe(false);
  });

  it("rejects autoresearch.sh not as first command", () => {
    expect(
      isAutoresearchShCommand("echo hello && autoresearch.sh")
    ).toBe(false);
  });
});

describe("computeConfidence", () => {
  function makeResult(
    metric: number,
    status: "keep" | "discard" = "keep",
    segment: number = 0
  ): ExperimentResult {
    return {
      commit: "abc1234",
      metric,
      metrics: {},
      status,
      description: "test",
      timestamp: Date.now(),
      segment,
      confidence: null,
    };
  }

  it("returns null for < 3 data points", () => {
    const results = [makeResult(100), makeResult(95)];
    expect(computeConfidence(results, 0, "lower")).toBeNull();
  });

  it("returns null for MAD=0 (all values identical)", () => {
    const results = [makeResult(100), makeResult(100), makeResult(100)];
    expect(computeConfidence(results, 0, "lower")).toBeNull();
  });

  it("returns a positive number for valid data", () => {
    const results = [
      makeResult(100),
      makeResult(98),
      makeResult(95),
      makeResult(90),
    ];
    const conf = computeConfidence(results, 0, "lower");
    expect(conf).not.toBeNull();
    expect(conf!).toBeGreaterThan(0);
  });

  it("returns null when no kept results improve over baseline", () => {
    const results = [
      makeResult(100),
      makeResult(105, "discard"),
      makeResult(110, "discard"),
    ];
    expect(computeConfidence(results, 0, "lower")).toBeNull();
  });

  it("filters by segment", () => {
    const results = [
      makeResult(100, "keep", 0),
      makeResult(90, "keep", 0),
      makeResult(85, "keep", 0),
      makeResult(200, "keep", 1),
    ];
    const conf = computeConfidence(results, 0, "lower");
    expect(conf).not.toBeNull();
  });
});

describe("isBetter", () => {
  it("lower direction: smaller is better", () => {
    expect(isBetter(90, 100, "lower")).toBe(true);
    expect(isBetter(110, 100, "lower")).toBe(false);
  });

  it("higher direction: larger is better", () => {
    expect(isBetter(110, 100, "higher")).toBe(true);
    expect(isBetter(90, 100, "higher")).toBe(false);
  });

  it("equal values are not better", () => {
    expect(isBetter(100, 100, "lower")).toBe(false);
    expect(isBetter(100, 100, "higher")).toBe(false);
  });
});

describe("truncateTail", () => {
  it("returns full content when under limits", () => {
    const result = truncateTail("line1\nline2\nline3", {
      maxLines: 10,
      maxBytes: 1024,
    });
    expect(result.truncated).toBe(false);
    expect(result.content).toBe("line1\nline2\nline3");
  });

  it("truncates by lines", () => {
    const input = Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n");
    const result = truncateTail(input, { maxLines: 5, maxBytes: 1024 * 1024 });
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe("lines");
    expect(result.outputLines).toBe(5);
    expect(result.totalLines).toBe(20);
    expect(result.content).toContain("line19");
    expect(result.content).not.toContain("line0");
  });

  it("truncates by bytes", () => {
    const input = "a".repeat(100);
    const result = truncateTail(input, { maxLines: 1000, maxBytes: 50 });
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe("bytes");
    expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(50);
  });
});

describe("formatElapsed", () => {
  it("formats seconds only", () => {
    expect(formatElapsed(5000)).toBe("5s");
    expect(formatElapsed(45000)).toBe("45s");
  });

  it("formats minutes and seconds", () => {
    expect(formatElapsed(65000)).toBe("1m 05s");
    expect(formatElapsed(125000)).toBe("2m 05s");
  });

  it("formats zero", () => {
    expect(formatElapsed(0)).toBe("0s");
  });
});

describe("formatNum", () => {
  it("returns dash for null", () => {
    expect(formatNum(null, "")).toBe("—");
  });

  it("formats integer without decimals", () => {
    expect(formatNum(15000, "µs")).toBe("15,000µs");
  });

  it("formats fractional with 2 decimals", () => {
    expect(formatNum(3.14, "s")).toBe("3.14s");
  });

  it("handles zero", () => {
    expect(formatNum(0, "")).toBe("0");
  });

  it("handles no unit", () => {
    expect(formatNum(42, "")).toBe("42");
  });
});

describe("commas", () => {
  it("formats thousands", () => {
    expect(commas(15586)).toBe("15,586");
    expect(commas(1000000)).toBe("1,000,000");
    expect(commas(999)).toBe("999");
    expect(commas(0)).toBe("0");
  });
});

describe("fmtNum", () => {
  it("formats with no decimals", () => {
    expect(fmtNum(1234)).toBe("1,234");
  });

  it("formats with decimals", () => {
    expect(fmtNum(1234.5, 2)).toBe("1,234.50");
  });

  it("handles negative numbers with decimals", () => {
    expect(fmtNum(-1234.5, 1)).toBe("-1,234.5");
  });
});

describe("sortedMedian", () => {
  it("returns 0 for empty array", () => {
    expect(sortedMedian([])).toBe(0);
  });

  it("returns middle value for odd length", () => {
    expect(sortedMedian([1, 3, 2])).toBe(2);
  });

  it("returns average of middle two for even length", () => {
    expect(sortedMedian([1, 2, 3, 4])).toBe(2.5);
  });
});

describe("formatSize", () => {
  it("formats bytes", () => {
    expect(formatSize(500)).toBe("500B");
  });

  it("formats kilobytes", () => {
    expect(formatSize(4096)).toBe("4.0KB");
  });
});
