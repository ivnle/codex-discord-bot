import { readFile } from "node:fs/promises";

import { findRolloutForThread } from "./codex-session.js";

export interface TurnStatus {
  found: boolean;
  running: boolean;
  startedAt?: number; // ms epoch of the latest task_started
  finishedAt?: number; // ms epoch of the latest task_complete (if any)
  toolCalls: number; // function_calls since the latest task_started
  lastAction?: string; // most recent tool call, summarized
  replyChars?: number; // length of the latest assistant message in the turn
}

function parseTs(ts: unknown): number | undefined {
  if (typeof ts !== "string") {
    return undefined;
  }
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? undefined : ms;
}

// Summarize a function_call into "name `command`" for display.
function summarizeCall(name: string | undefined, args: unknown): string {
  const label = name ?? "tool";
  if (typeof args !== "string") {
    return label;
  }
  let detail = args;
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    const cmd = parsed.command ?? parsed.cmd;
    if (Array.isArray(cmd)) {
      detail = cmd.map((c) => String(c)).join(" ");
    } else if (typeof cmd === "string") {
      detail = cmd;
    }
  } catch {
    // leave detail as the raw argument string
  }
  detail = detail.replace(/\s+/g, " ").trim();
  if (detail.length > 70) {
    detail = `${detail.slice(0, 67)}...`;
  }
  return detail ? `${label} \`${detail}\`` : label;
}

// Walk the rollout and summarize the most recent turn.
function readLatestTurn(contents: string): Omit<TurnStatus, "running"> {
  let startedAt: number | undefined;
  let finishedAt: number | undefined;
  let toolCalls = 0;
  let lastAction: string | undefined;
  let replyChars: number | undefined;

  for (const line of contents.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    let record: {
      timestamp?: string;
      type?: string;
      payload?: Record<string, unknown>;
    };
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const p = record.payload;
    if (!p) {
      continue;
    }
    const pt = p.type;

    if (record.type === "event_msg" && pt === "task_started") {
      // New turn: reset counters.
      startedAt = parseTs(record.timestamp) ?? startedAt;
      finishedAt = undefined;
      toolCalls = 0;
      lastAction = undefined;
      replyChars = undefined;
    } else if (record.type === "event_msg" && pt === "task_complete") {
      finishedAt = parseTs(record.timestamp) ?? finishedAt;
    } else if (record.type === "response_item" && pt === "function_call") {
      toolCalls += 1;
      lastAction = summarizeCall(p.name as string | undefined, p.arguments);
    } else if (
      record.type === "response_item" &&
      pt === "message" &&
      p.role === "assistant"
    ) {
      const content = Array.isArray(p.content) ? p.content : [];
      const text = content
        .map((c) =>
          c && typeof c === "object" && "text" in c
            ? String((c as { text?: unknown }).text ?? "")
            : ""
        )
        .join("");
      if (text.length > 0) {
        replyChars = text.length;
      }
    }
  }

  return { found: true, startedAt, finishedAt, toolCalls, lastAction, replyChars };
}

export async function readTurnStatus(
  threadId: string | undefined,
  running: boolean,
  sessionsDir?: string
): Promise<TurnStatus> {
  const empty: TurnStatus = { found: false, running, toolCalls: 0 };
  if (!threadId) {
    return empty;
  }
  const rollout = await findRolloutForThread(threadId, sessionsDir);
  if (!rollout) {
    return empty;
  }
  try {
    const turn = readLatestTurn(await readFile(rollout, "utf8"));
    return { ...turn, running };
  } catch {
    return empty;
  }
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  if (mins === 0) {
    return `${secs}s`;
  }
  if (secs === 0) {
    return `${mins}m`;
  }
  return `${mins}m${secs}s`;
}

export function formatTurnStatus(status: TurnStatus, now: number): string {
  if (status.running) {
    const elapsed =
      status.startedAt !== undefined
        ? ` ${formatDuration(now - status.startedAt)}`
        : "";
    const calls = ` · ${status.toolCalls} tool call${status.toolCalls === 1 ? "" : "s"}`;
    const last = status.lastAction ? ` · last: ${status.lastAction}` : "";
    return `🟢 Running${elapsed}${calls}${last}`;
  }

  if (!status.found || status.startedAt === undefined) {
    return "⚪ Idle · no turns this session yet.";
  }

  const ago =
    status.finishedAt !== undefined
      ? ` · last turn finished ${formatDuration(now - status.finishedAt)} ago`
      : "";
  const calls = ` · ${status.toolCalls} tool call${status.toolCalls === 1 ? "" : "s"}`;
  const reply =
    status.replyChars !== undefined
      ? ` · ${status.replyChars.toLocaleString()}-char reply`
      : "";
  return `⚪ Idle${ago}${calls}${reply}`;
}
