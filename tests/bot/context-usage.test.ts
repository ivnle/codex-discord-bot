import { describe, expect, it } from "vitest";

import {
  abbreviateTokens,
  formatContextUsage
} from "../../src/bot/context-usage.js";

describe("context usage formatting", () => {
  it.each([
    [0, "0"],
    [999, "999"],
    [1000, "1K"],
    [45_200, "45K"],
    [999_999, "999K"],
    [1_000_000, "1M"],
    [1_200_000, "1.2M"],
    [1_250_000, "1.3M"]
  ])("abbreviates %i tokens as %s", (tokens, expected) => {
    expect(abbreviateTokens(tokens)).toBe(expected);
  });

  it("formats window fullness and cumulative session total", () => {
    expect(
      formatContextUsage({
        total: tokenBreakdown({ totalTokens: 1_200_000 }),
        last: tokenBreakdown({ inputTokens: 45_000 }),
        modelContextWindow: 272_000
      })
    ).toBe("Context: ~45K / 272K (17% of window)\nSession total: 1.2M tokens");
  });

  it("formats usage when the model context window is unknown", () => {
    expect(
      formatContextUsage({
        total: tokenBreakdown({ totalTokens: 1_200_000 }),
        last: tokenBreakdown({ inputTokens: 45_000 }),
        modelContextWindow: null
      })
    ).toBe("Context: ~45K used (window size unknown)\nSession total: 1.2M tokens");
  });
});

function tokenBreakdown(
  overrides: Partial<{
    totalTokens: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
  }>
): {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
} {
  return {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    ...overrides
  };
}
