import { describe, expect, it } from "vitest";

import { parseConfigPathArg } from "../src/main.js";

describe("parseConfigPathArg", () => {
  it("reads the single config file path for one bot process", () => {
    expect(parseConfigPathArg(["node", "codex-discord-bot", "bot.yaml"])).toBe(
      "bot.yaml"
    );
  });

  it("rejects missing or extra config paths", () => {
    expect(() => parseConfigPathArg(["node", "codex-discord-bot"])).toThrow(
      /Usage/
    );
    expect(() =>
      parseConfigPathArg(["node", "codex-discord-bot", "a.yaml", "b.yaml"])
    ).toThrow(/one config file/);
  });
});
