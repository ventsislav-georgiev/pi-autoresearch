import { describe, it, expect } from "bun:test";

import { AutoresearchPlugin } from "../src/plugin.ts";

describe("AutoresearchPlugin", () => {
  it("is a function", () => {
    expect(typeof AutoresearchPlugin).toBe("function");
  });

  it("returns hooks with all 3 tools", async () => {
    const mockInput = {
      client: {} as never,
      project: "" as never,
      directory: "/tmp",
      worktree: "/tmp",
      serverUrl: new URL("http://localhost"),
      $: (() => ({
        cwd: () => ({
          nothrow: () =>
            Promise.resolve({
              exitCode: 0,
              stdout: Buffer.from(""),
              stderr: Buffer.from(""),
            }),
        }),
      })) as never,
    };

    const hooks = await AutoresearchPlugin(mockInput);

    expect(hooks.tool).toBeDefined();
    expect(hooks.tool!.init_experiment).toBeDefined();
    expect(hooks.tool!.run_experiment).toBeDefined();
    expect(hooks.tool!.log_experiment).toBeDefined();
  });

  it("has event hook", async () => {
    const mockInput = {
      client: {} as never,
      project: "" as never,
      directory: "/tmp",
      worktree: "/tmp",
      serverUrl: new URL("http://localhost"),
      $: (() => ({})) as never,
    };

    const hooks = await AutoresearchPlugin(mockInput);
    expect(hooks.event).toBeDefined();
    expect(typeof hooks.event).toBe("function");
  });

  it("has system transform hook", async () => {
    const mockInput = {
      client: {} as never,
      project: "" as never,
      directory: "/tmp",
      worktree: "/tmp",
      serverUrl: new URL("http://localhost"),
      $: (() => ({})) as never,
    };

    const hooks = await AutoresearchPlugin(mockInput);
    expect(hooks["experimental.chat.system.transform"]).toBeDefined();
    expect(typeof hooks["experimental.chat.system.transform"]).toBe(
      "function"
    );
  });
});
