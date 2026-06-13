import type { ThreadTokenUsage } from "../codex/client.js";

export const NO_CONTEXT_USAGE_MESSAGE =
  "No usage data yet — send a message first.";

export function formatContextUsage(
  usage: ThreadTokenUsage | undefined
): string {
  if (!usage) {
    return NO_CONTEXT_USAGE_MESSAGE;
  }

  const contextTokens = abbreviateTokens(usage.last.inputTokens);
  const sessionTokens = abbreviateTokens(usage.total.totalTokens);
  if (usage.modelContextWindow === null || usage.modelContextWindow <= 0) {
    return [
      `Context: ~${contextTokens} used (window size unknown)`,
      `Session total: ${sessionTokens} tokens`
    ].join("\n");
  }

  const windowTokens = abbreviateTokens(usage.modelContextWindow);
  const percent = Math.round(
    (usage.last.inputTokens / usage.modelContextWindow) * 100
  );
  return [
    `Context: ~${contextTokens} / ${windowTokens} (${percent}% of window)`,
    `Session total: ${sessionTokens} tokens`
  ].join("\n");
}

export function abbreviateTokens(tokens: number): string {
  if (tokens < 1000) {
    return `${tokens}`;
  }
  if (tokens < 1_000_000) {
    return `${Math.floor(tokens / 1000)}K`;
  }

  const millions = Math.round((tokens / 1_000_000) * 10) / 10;
  return `${millions.toFixed(1).replace(/\.0$/, "")}M`;
}
