import { describe, expect, it } from "vitest";

import { buildCodexArgs } from "../../src/codex/args.js";

describe("buildCodexArgs", () => {
  it("returns codex args unchanged when instructions_file is not configured", () => {
    const args = ["app-server", "--stdio"];

    const builtArgs = buildCodexArgs({ args });

    expect(builtArgs).toBe(args);
  });

  it("prepends the model_instructions_file override before app-server", () => {
    const builtArgs = buildCodexArgs({
      args: ["app-server", "--stdio"],
      instructionsFile: "/abs/persona.md"
    });

    expect(builtArgs).toEqual([
      "-c",
      "model_instructions_file=/abs/persona.md",
      "app-server",
      "--stdio"
    ]);
    expect(builtArgs.indexOf("-c")).toBeLessThan(
      builtArgs.indexOf("app-server")
    );
  });
});
