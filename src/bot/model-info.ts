import { readFile } from "node:fs/promises";

import {
  codexSessionsDir,
  findRolloutForThread
} from "./codex-session.js";

export interface ModelInfo {
  model?: string;
  effort?: string;
  source: "session" | "config" | "unknown";
}

// Pull the model + reasoning effort from the most recent `turn_context` record.
function lastTurnContext(
  contents: string
): { model?: string; effort?: string } | undefined {
  let found: { model?: string; effort?: string } | undefined;
  for (const line of contents.split("\n")) {
    if (line.length === 0 || !line.includes('"turn_context"')) {
      continue;
    }
    try {
      const record = JSON.parse(line) as {
        type?: string;
        payload?: {
          model?: string;
          effort?: string;
          collaboration_mode?: { settings?: { reasoning_effort?: string } };
        };
      };
      if (record.type !== "turn_context" || !record.payload) {
        continue;
      }
      const p = record.payload;
      found = {
        model: p.model,
        effort: p.effort ?? p.collaboration_mode?.settings?.reasoning_effort
      };
    } catch {
      // skip malformed lines
    }
  }
  return found;
}

// Resolve the runtime model + effort for the active thread, reading codex's own
// session rollout (runtime truth). Falls back to the configured model.
export async function readModelInfo(
  threadId: string | undefined,
  fallbackModel: string | undefined,
  sessionsDir: string = codexSessionsDir()
): Promise<ModelInfo> {
  if (threadId) {
    const rollout = await findRolloutForThread(threadId, sessionsDir);
    if (rollout) {
      try {
        const ctx = lastTurnContext(await readFile(rollout, "utf8"));
        if (ctx?.model || ctx?.effort) {
          return { model: ctx.model, effort: ctx.effort, source: "session" };
        }
      } catch {
        // fall through to config
      }
    }
  }
  if (fallbackModel) {
    return { model: fallbackModel, source: "config" };
  }
  return { source: "unknown" };
}

export function formatModelInfo(info: ModelInfo): string {
  if (info.source === "unknown" || (!info.model && !info.effort)) {
    return "Couldn't determine the model in use.";
  }
  const model = info.model ?? "unknown model";
  const effort = info.effort ? ` · effort ${info.effort}` : "";
  const note =
    info.source === "config"
      ? " _(from config; no live session yet)_"
      : "";
  return `**${model}**${effort}${note}`;
}
