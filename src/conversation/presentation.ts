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
  const freshness = active ? `\n${Math.floor(age / 60)}m ${age % 60}s elapsed · Last progress <t:${Math.floor(job.activity / 1000)}:R>\n${["checking", "publishing", "verifying", "rolling_back"].includes(job.phase) ? "Automated checks · status refreshed" : connected ? "Codex connected" : "Checking connection"}` : "";
  const actions: TaskCard["actions"] = [];
  if (["received", "queued", "working", "waiting", "checking", "publishing", "verifying"].includes(job.phase)) actions.push({ id: `stop:${job.id}`, label: "Stop" });
  if (job.phase === "interrupted") actions.push({ id: `retry:${job.id}`, label: "Retry" });
  if (job.phase === "stopped" && job.sourceStart) actions.push({id:`retry:${job.id}`,label:"Resume"});
  if(job.releaseId && job.phase === "done") actions.push({id:`undo:${job.id}`,label:"Undo this change"});
  const draft=job.preview ? `\n[Try this draft](${job.preview.url}) · ${job.phase==="done" ? "Earlier draft; use the live link above." : job.supersededBy ? "Superseded draft." : "Draft only—not the live game. Saves here are separate."}` : "";
  if(job.supersededBy)actions.length=0;
  return { content: `**${titles[job.phase]}**\n${job.detail.slice(0, 1100)}${draft}${freshness}`, actions };
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
For a change, implement it and run focused checks when useful. The trusted controller
runs the required full verification and phone-browser checks, then publishes.
Do not run the entire verify suite yourself or report your sandbox's unavailable
browser as a release failure; the controller has a separate checking environment.
Never deploy, push, merge, change credentials, commit, or claim a change is live
yourself. Finish with a concise description of the prepared change. The controller
supplies the final publishing confirmation. For follow-up questions, use the trusted
controller status supplied with the parent's message; earlier coding replies may
predate publishing. The controller shares a draft link after quick checks, while full verification continues. Parents can try it and discuss or revise it in this channel. Draft saves are separate from the live game. Full checks still gate automatic production publishing. Never say a draft is live production.
You can fix bugs, extend games, and create new games within src/games plus register
them in src/app/games.ts. Keep existing games and routes. Existing tests, package and
build settings, deployment files, service workers, platform code and saved-game storage
are protected. If a change needs these, explain what needs Ivan's review and end
needs_review; do not bypass the restriction or weaken checks. New games need their own
release-checks/<game-id>.json: {"game":"Exact tile label","steps":[{"action":"click",
"selector":"a meaningful gameplay control CSS selector"},{"action":"expectVisible",
"selector":"CSS selector for the resulting game state"}]}. Check a real interaction,
not just whether the page exists. Don't modify existing games' storage formats; new
games needing persisted storage should get Ivan's review of the storage design.
When checks fail the controller gives you the failure and up to two repair attempts.
Repairs must stay within the original request and originally changed files. Never
fix an unrelated game merely to make a check pass; request owner review if broader
work is needed. A timing-sensitive failure may be retried without changing code.
Return the final JSON schema: message is the human-readable answer; state is
needs_review when a protected change needs Ivan; needs_reply when the parent can
answer a question; otherwise done. Keep links in message.
If resuming after an interruption, inspect actual files and completed work first;
never assume the previous attempt did nothing.`;

export const RESULT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["message", "state"],
  properties: {
    message: { type: "string" },
    state: { type: "string", enum: ["done", "needs_reply", "needs_review"] }
  }
};
