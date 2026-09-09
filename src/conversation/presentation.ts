import type { TaskCard } from "../discord/gateway.js";
import type { Job } from "./store.js";

const titles = {
  received: "📨 Received", queued: "📨 Up next", working: "🟡 Working",
  waiting: "💬 Needs your answer", stopping: "⏸ Stopping",
  done: "✅ Done · Ready for your next idea", stopped: "⏹ Stopped",
  checking:"🔎 Checking", publishing:"🚀 Publishing", verifying:"🔎 Checking live game", rolling_back:"↩️ Restoring previous version", review:"💬 Needs Ivan’s review",
  interrupted: "⚠️ Interrupted"
};

export function taskCard(job: Job, now: number, connected: boolean): TaskCard {
  const age = Math.max(0, Math.floor((now - job.created) / 1000));
  const active = ["checking", "publishing", "verifying", "rolling_back"].includes(job.phase) || (["working", "stopping", "waiting"].includes(job.phase) && !job.result);
  const freshness = active ? `\n${Math.floor(age / 60)}m ${age % 60}s elapsed · Last activity <t:${Math.floor(job.activity / 1000)}:R>\n${connected ? "Codex connected" : "Checking connection"}` : "";
  const actions: TaskCard["actions"] = [];
  if (["received", "queued", "working", "waiting", "checking", "publishing", "verifying"].includes(job.phase)) actions.push({ id: `stop:${job.id}`, label: "Stop" });
  if (job.phase === "interrupted") actions.push({ id: `retry:${job.id}`, label: "Retry" });
  if(job.releaseId && job.phase === "done") actions.push({id:`undo:${job.id}`,label:"Undo this change"});
  return { content: `**${titles[job.phase]}**\n${job.detail.slice(0, 1100)}${freshness}`, actions };
}

export const FAMILY_INSTRUCTIONS = `You help a parent change a game for their child through Discord.
Use warm, concise everyday language. Treat ordinary messages as conversation;
answer questions directly and carry out requested changes. Do not expose terminal
commands, model settings, branches, or context-management chores in normal replies.
Read the project's README and applicable instructions. For ispy read docs/s-tier.md
and the relevant game spec; preserve offline play and the child's saved creations.
Work only in the configured project workspace. Never discard existing work.
Send brief commentary at meaningful milestones, describing actual activity, not plans
as accomplishments. The bridge handles acknowledgment and elapsed-time updates.
If you need a clarification, prefer ending with needs_reply and one short question.
You may also use request_user_input. Never request passwords or tokens in Discord.
For a change, implement it, run appropriate checks and inspect the affected game
in a phone-sized browser when tools permit. Explain any checks you could not run.
A trusted controller automatically checks and publishes completed changes. Never deploy,
push, merge, change credentials, commit, or claim a change is live yourself. Finish
with a concise description of the prepared change; the controller confirms publishing.
You can fix bugs, extend games, and create new games within src/games plus register
them in src/app/games.ts. Keep existing games and routes. Existing tests, package and
build settings, deployment files, service workers, platform code and saved-game storage
are protected. If a change needs these, explain what needs Ivan's review and end
needs_reply; do not bypass the restriction or weaken checks. New games need their own
release-checks/<game-id>.json: {"game":"Exact tile label","steps":[{"action":"click",
"selector":"a meaningful gameplay control CSS selector"},{"action":"expectVisible",
"selector":"CSS selector for the resulting game state"}]}. Check a real interaction,
not just whether the page exists. Don't modify existing games' storage formats; new
games needing persisted storage should get Ivan's review of the storage design.
When checks fail the controller gives you the failure and up to two repair attempts.
Return the final JSON schema: message is the human-readable answer; state is
needs_reply only when you need an answer, otherwise done. Keep links in message.
If resuming after an interruption, inspect actual files and completed work first;
never assume the previous attempt did nothing.`;

export const RESULT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["message", "state"],
  properties: {
    message: { type: "string" },
    state: { type: "string", enum: ["done", "needs_reply"] }
  }
};
