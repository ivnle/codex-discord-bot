import type { ReleaseService, ReleasePhase } from "../releases/controller.js";
import { ReviewRequired } from "../releases/policy.js";
import { randomUUID } from "node:crypto";
import type { BotConfig } from "../config/types.js";
import type { CodexClient, CodexRpcId } from "../codex/client.js";
import type { JsonRpcMessage } from "../codex/json-rpc.js";
import type { ConversationGateway, DiscordMessage, TaskAction } from "../discord/gateway.js";
import { mapServerRequestToApproval, mapApprovalChoice, renderApprovalPrompt, type ApprovalRequest } from "../approvals/approval-bridge.js";
import { chunkReply } from "../replies/chunk.js";
import { ConversationStore, type ConversationState, type Job } from "./store.js";
import { FAMILY_INSTRUCTIONS, RESULT_SCHEMA, taskCard } from "./presentation.js";

export interface ConversationCodex extends CodexClient {
  onEvent(handler: (event: JsonRpcMessage) => void): void;
  onDisconnect(handler: () => void): void;
  health(threadId: string): Promise<void>;
}

type Question = { id: string; question: string; options?: Array<{ label: string }> | null };
type InputRequest = { rpcId: CodexRpcId; questions: Question[]; index: number; answers: Record<string, { answers: string[] }> };
const activePhases = new Set(["received", "queued", "working", "stopping", "checking", "publishing", "verifying", "rolling_back"]);

/** One channel, one persisted conversation, and exactly one running turn. */
export class FamilyConversation {
  private state: ConversationState = { jobs: [], seen: [] };
  private active?: Job;
  private pendingInput?: InputRequest;
  private approvals = new Map<string, ApprovalRequest>();
  private connected = false;
  private ready = false;
  private incoming: DiscordMessage[] = [];
  private closing = false;
  private timer?: ReturnType<typeof setInterval>;
  private serial: Promise<unknown> = Promise.resolve();
  private dirty = new Set<string>();
  private lastPaint = new Map<string, number>();
  private lastProbe = 0;
  private releaseAbort?: AbortController;
  private releaseTask?: Promise<void>;

  constructor(
    private readonly config: BotConfig,
    private readonly discord: ConversationGateway,
    private readonly codex: ConversationCodex,
    private readonly store: ConversationStore,
    private readonly now = Date.now,
    private readonly releases?: ReleaseService,
  ) {}

  // Public for deterministic tests and orderly shutdown. All incoming work goes
  // through this lane, including notifications that arrive before RPC replies.
  async settled(): Promise<void> { await this.serial; }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.serial.then(operation);
    this.serial = task.catch(() => { console.error("Conversation operation failed; retained state for recovery"); });
    return task;
  }

  async start(token: string): Promise<void> {
    if (this.config.access.channels.length !== 1 || !this.config.access.allowUserIds.length) {
      throw new Error("Family mode needs exactly one channel and at least one allowed user");
    }
    this.state = await this.store.open();
    this.discord.onMessage((message) => {
      if(!this.ready){this.incoming.push(message);return Promise.resolve();}
      return this.enqueue(() => this.receive(message));
    });
    this.discord.onAction((action) => this.ready ? this.enqueue(() => this.action(action)) : Promise.resolve("Restarting safely. Please try this control again in a moment."));
    this.discord.onApprovalChoice((choice) => this.enqueue(async () => {
      const approval = this.approvals.get(choice.approvalId);
      if (!approval || !this.active) return;
      const result = mapApprovalChoice(approval, choice.choice, choice.userId, this.config.access);
      if (!result.authorized) return;
      // Permission-profile grants require different semantics from command
      // approval. Never silently grant an unspecified profile.
      await this.codex.sendApprovalResponse(result.rpcId, result.response);
      this.approvals.delete(choice.approvalId);
      this.active.phase = this.approvals.size ? "waiting" : "working";
      this.active.detail = this.approvals.size ? "Waiting for your permission." : "Continuing with your decision.";
      await this.saveAndPaint(this.active);
    }));
    this.codex.onEvent((event) => { void this.enqueue(() => this.event(event)).catch(() => {}); });
    this.codex.onDisconnect(() => { if (!this.closing) void this.enqueue(() => this.disconnect()).catch(() => {}); });
    try {
      await this.discord.start(token);
      // A previous process may have died before changing its visible card.
      for (const job of this.state.jobs) {
        if (activePhases.has(job.phase) || (job.phase === "waiting" && !job.result)) {
          job.phase = "interrupted";
          job.detail = "I restarted before this finished. Your request is saved. Tap Retry to continue.";
          this.dirty.add(job.id);
        }
      }
      await this.store.save(this.state);
      await this.flush();
      await this.releases?.recover();
      for(const job of this.state.jobs.filter(j=>j.phase==="interrupted")) {
        const completed=await this.releases?.completed?.(job.id);
        if(job.undoing && this.releases && job.releaseId) {
          if(completed)await this.releases.undo(job.releaseId,async(phase,detail)=>{job.phase=phase;job.detail=detail;await this.saveAndPaint(job);});
          job.phase="done";job.undoing=false;job.releaseId=undefined;job.detail="Previous version restored after restart.";job.result="The previous game version is restored. Refresh or reopen the game.";job.deliveredChunks=0;
          await this.saveAndPaint(job);await this.deliver(job);continue;
        }
        if(completed) {job.phase="done";job.releaseId=completed.id;job.result=completed.message;job.detail="Live release recovered after restart.";await this.saveAndPaint(job);await this.deliver(job);}
      }
      await this.connect();
      const lastSeen=this.state.seen.filter(id=>/^\d+$/.test(id)).sort((a,b)=>BigInt(a)<BigInt(b)?-1:1).at(-1);
      const missed=lastSeen && this.discord.messagesAfter ? await this.discord.messagesAfter(this.config.access.channels[0]!,lastSeen) : [];
      const incoming=[...missed,...this.incoming];this.incoming=[];this.ready=true;
      await this.enqueue(async()=>{for(const message of incoming)await this.receive(message);});
      this.timer = setInterval(() => { void this.enqueue(() => this.tick()).catch(() => {}); }, 5000);
    } catch (error) {
      await this.codex.stop?.();
      await this.discord.stop();
      await this.store.close();
      throw error;
    }
  }

  private async connect(): Promise<void> {
    await this.codex.connect();
    const options = {
      cwd: this.config.codex.cwd,
      ...(this.releases ? {} : { sandbox: this.config.codex.sandbox ?? "workspace-write" as const }),
      approvalPolicy: this.releases ? "never" as const : this.config.codex.approvalPolicy ?? "on-request" as const,
      ...(this.config.codex.model ? { model: this.config.codex.model } : {}),
      developerInstructions: FAMILY_INSTRUCTIONS,
    };
    // Never silently discard a conversation if resume fails.
    this.state.threadId = this.state.threadId
      ? await this.codex.resumeThread(this.state.threadId, options)
      : await this.codex.startThread(options);
    this.connected = true;
    await this.store.save(this.state);
  }

  private allowed(userId: string, channelId: string): boolean {
    return this.config.access.allowUserIds.includes(userId) && this.config.access.channels.includes(channelId);
  }

  private async receive(message: DiscordMessage): Promise<void> {
    if (this.closing || message.isDirectMessage || !this.allowed(message.authorId, message.channelId)) return;
    if (this.state.seen.includes(message.id)) return;
    this.state.seen.push(message.id);
    this.state.seen = this.state.seen.slice(-10000);
    if (!message.content.trim()) {
      await this.discord.sendMessage(message.channelId, "Please describe the change in a text message. Attachments alone aren't supported yet.");
      return;
    }
    if (/^(?:!?(?:stop|cancel))[.!]?$/i.test(message.content.trim())) {
      await this.stopJob(this.active);
      return;
    }
    if (/^undo[.!]?$/i.test(message.content.trim()) && this.releases) {
      const latest=[...this.state.jobs].reverse().find(j=>j.releaseId);
      const reply=latest ? await this.action({id:`undo:${latest.id}`,userId:message.authorId,channelId:message.channelId}) : "There isn't a completed change to undo yet.";
      await this.discord.sendMessage(message.channelId,reply); return;
    }
    if (this.pendingInput && this.active) {
      const request = this.pendingInput;
      const question = request.questions[request.index]!;
      request.answers[question.id] = { answers: [message.content] };
      request.index++;
      if (request.index < request.questions.length) { await this.askQuestion(); return; }
      await this.codex.sendApprovalResponse(request.rpcId, { answers: request.answers });
      this.pendingInput = undefined;
      this.active.phase = "working";
      this.active.detail = "Got your answer. Continuing.";
      await this.saveAndPaint(this.active);
      return;
    }
    // An ordinary follow-up resolves a prior conversational question.
    for (const old of this.state.jobs.filter((j) => j.phase === "waiting" && j.result)) {
      old.phase = "done"; old.detail = "Answer received."; await this.saveAndPaint(old);
    }
    const unfinished = !this.active ? [...this.state.jobs].reverse().find(j=>!j.resolvedBy && ["stopped","interrupted","review"].includes(j.phase)) : undefined;
    if(unfinished && this.releases) {
      message={...message,content:`There may be saved unfinished edits from this earlier request: ${unfinished.message.content}\nNew message from the parent: ${message.content}\nInspect the saved work. If this is an unrelated new request, ask whether to continue or set aside the previous edits before changing anything; never silently publish abandoned edits.`};
    }
    const job: Job = {
      id: randomUUID(), message, phase: this.active ? "queued" : "received",
      detail: this.active ? "Got it—I'll handle this after the current request." : "Got it. Your request is saved.",
      created: this.now(), activity: this.now(), deliveredChunks: 0,
    };
    this.state.jobs.push(job);
    await this.saveAndPaint(job); // Receipt must be durable before a worker starts.
    await this.pump();
  }

  private async pump(): Promise<void> {
    if (this.active || this.closing || !this.ready) return;
    const job = this.state.jobs.find((j) => j.phase === "received" || j.phase === "queued");
    if (!job || !job.cardId) return;
    if (!this.connected) {
      job.phase = "interrupted";
      job.detail = "The coding agent is unavailable. Your request is saved. Tap Retry to reconnect.";
      await this.saveAndPaint(job); return;
    }
    this.active = job;
    job.phase = "working"; job.detail = "Looking at your request."; job.activity = this.now();
    await this.saveAndPaint(job);
    try {
      await this.codex.startTurn({
        threadId: this.state.threadId!, clientUserMessageId: randomUUID(),
        cwd: this.config.codex.cwd,
        input: [{ type: "text", text: job.message.content, text_elements: [] }],
        outputSchema: RESULT_SCHEMA,
      });
    } catch {
      // A timeout is ambiguous: the worker could still be executing. Kill it
      // before enabling Retry, so two copies can never run together.
      await this.codex.stop?.();
      await this.disconnect();
    }
  }

  private async event(event: JsonRpcMessage): Promise<void> {
    if (this.closing || (this.releaseTask && ["checking","publishing","verifying","rolling_back"].includes(this.active?.phase ?? ""))) return;
    const p = record(event.params);
    const job = this.active;
    if (!job || p.threadId !== this.state.threadId) return;
    const turn = record(p.turn);
    const turnId = typeof p.turnId === "string" ? p.turnId : typeof turn.id === "string" ? turn.id : undefined;
    if (job.turnId && turnId && job.turnId !== turnId) return;
    if (turnId && !job.turnId) job.turnId = turnId;
    job.activity = this.now();
    if (event.id !== undefined && event.method) {
      if (event.method === "item/tool/requestUserInput") {
        const questions = Array.isArray(p.questions) ? p.questions as Question[] : [];
        if (!questions.length || questions.some((q) => !q.id || !q.question || record(q).isSecret)) {
          await this.codex.sendApprovalResponse(event.id, { answers: {} }); return;
        }
        this.pendingInput = { rpcId: event.id, questions, index: 0, answers: {} };
        job.phase = "waiting";
        await this.askQuestion(); return;
      }
      try {
        const approval = mapServerRequestToApproval(event as Record<string, unknown>);
        if (approval.kind === "permissions") {
          await this.codex.sendApprovalResponse(event.id, { permissions: {}, scope: "turn" });
          job.detail = "An extra access request wasn't granted. Looking for another way.";
        } else {
          this.approvals.set(approval.approvalId, approval);
          job.phase = "waiting"; job.detail = "Waiting for your permission. See the question below.";
          await this.saveAndPaint(job);
          await this.discord.sendApprovalPrompt(job.message.channelId, approval.approvalId, renderApprovalPrompt(approval));
        }
      } catch {
        // Unsupported server requests must not leave an invisible wait forever.
        await this.codex.sendApprovalResponse(event.id, { error: "This interaction is not supported by the Discord bridge. Ask in your final reply instead." });
      }
      return;
    }
    if (event.method === "item/completed" || event.method === "item/started") {
      const item = record(p.item);
      if (event.method === "item/completed" && item.type === "agentMessage" && typeof item.text === "string") {
        if (item.phase === "final_answer") {
          const result = parseResult(item.text);
          job.result = result.message;
          job.needsReply = result.needsReply;
          await this.store.save(this.state);
        } else if (job.phase === "working") {
          job.detail = item.text.slice(0, 1100); this.dirty.add(job.id);
        }
      } else if (job.phase === "working" && event.method === "item/started") {
        const descriptions: Record<string, string> = {
          commandExecution: "Working through your request.", fileChange: "Making the changes.",
          webSearch: "Looking up information for your request.", mcpToolCall: "Using a tool to check the work.",
        };
        if (descriptions[String(item.type)]) { job.detail = descriptions[String(item.type)]!; this.dirty.add(job.id); }
      }
    }
    if (event.method === "turn/completed") {
      const failed = turn.status === "failed";
      const stopped = turn.status === "interrupted" || job.phase === "stopping";
      if (!failed && !stopped && !job.needsReply && job.result && this.releases) {
        this.startRelease(job); return;
      }
      job.phase = failed ? "interrupted" : stopped ? "stopped" : job.needsReply ? "waiting" : "done";
      job.detail = failed ? "The agent couldn't finish this request. Tap Retry to continue from the saved work."
        : stopped ? "Stopped. Any edits already made are kept; nothing was published by stopping."
        : job.needsReply ? "Waiting for your answer to the question below."
        : "Finished. Ready for your next idea.";
      if (!failed && !stopped && !job.result) {
        job.phase = "interrupted"; job.detail = "The agent ended without a reply. Tap Retry to check what happened.";
      }
      if (failed || stopped) { job.result = undefined; job.needsReply = false; }
      this.active = undefined; this.pendingInput = undefined; this.approvals.clear();
      await this.saveAndPaint(job);
      await this.deliver(job);
      // Failure and cancellation leave queued requests visible for deliberate retry.
      if (failed || stopped) await this.pauseQueue();
      else await this.pump();
    }
  }

  private startRelease(job: Job): void {
    job.phase="checking";
    this.releaseAbort = new AbortController();
    const update = (phase: ReleasePhase, detail: string) => this.enqueue(async () => {
      job.phase=phase; job.detail=detail; job.activity=this.now(); await this.saveAndPaint(job);
    });
    this.releaseTask = this.releases!.release(job.id, update, this.releaseAbort.signal).then(
      outcome => this.enqueue(async () => {
        job.phase="done"; job.releaseId=outcome.id;
        for(const previous of this.state.jobs) {
          if(previous.created <= job.created && ["stopped","interrupted","review"].includes(previous.phase)) previous.resolvedBy=job.id;
        }
        job.detail=outcome.published ? "Live and checked. Ready for your next idea." : "Finished. Ready for your next idea.";
        if(outcome.message) job.result=`${job.result}\n\n${outcome.message}`;
        this.active=undefined; this.releaseAbort=undefined;
        await this.saveAndPaint(job); await this.deliver(job); await this.pump();
      }),
      error => this.enqueue(async () => {
        const cancelled=this.releaseAbort?.signal.aborted;
        this.releaseAbort=undefined;
        if(!cancelled && !(error instanceof ReviewRequired) && (job.repairs ?? 0)<2 && !this.closing) {
          job.repairs=(job.repairs ?? 0)+1; job.turnId=undefined; job.result=undefined;
          job.phase="working"; job.detail="A check found a problem. Fixing it before publishing.";
          await this.saveAndPaint(job);
          try { await this.codex.startTurn({threadId:this.state.threadId!,clientUserMessageId:randomUUID(),cwd:this.config.codex.cwd,
            input:[{type:"text",text:`The trusted release controller did not publish your changes. Repair the failure without changing protected checks, storage, dependencies, or deployment machinery. Do not claim it is live. Failure:\n${String(error).slice(-6500)}`,text_elements:[]}],outputSchema:RESULT_SCHEMA}); }
          catch { await this.codex.stop?.(); await this.disconnect(); }
          return;
        }
        job.phase=cancelled?"stopped":error instanceof ReviewRequired?"review":"interrupted";
        job.detail=error instanceof ReviewRequired?error.message:cancelled?"Stopped. Any unfinished edits are saved.":"I couldn't complete a verified release. Your edits are saved. Ivan can inspect the release log, or you can Retry.";
        job.result=undefined; this.active=undefined;
        await this.saveAndPaint(job); await this.pauseQueue();
      })
    ).finally(()=>{ this.releaseTask=undefined; });
  }

  private async askQuestion(): Promise<void> {
    const q = this.pendingInput!.questions[this.pendingInput!.index]!;
    this.active!.detail = [q.question, ...(q.options ?? []).map((o) => `• ${o.label}`), "Reply here with your answer."].join("\n");
    await this.saveAndPaint(this.active!);
    await this.discord.sendMessage(this.active!.message.channelId,
      [q.question, ...(q.options ?? []).map((o) => `• ${o.label}`), "Reply here with your answer."].join("\n"));
  }

  private async action(action: TaskAction): Promise<string> {
    if (!this.allowed(action.userId, action.channelId)) return "This control is only for the people allowed to use this channel.";
    const [verb, id] = action.id.split(":");
    const job = this.state.jobs.find((j) => j.id === id && j.message.channelId === action.channelId);
    if (!job) return "That request is no longer available.";
    if (verb === "undo" && job.releaseId && this.releases) {
      if(this.active) return "Wait for the current request to finish before Undo.";
      this.active=job;job.undoing=true;await this.store.save(this.state);
      this.releaseTask=this.releases.undo(job.releaseId,(phase,detail)=>this.enqueue(async()=>{
        job.phase=phase; job.detail=detail; await this.saveAndPaint(job);
      })).then(message=>this.enqueue(async()=>{
        job.phase="done";job.undoing=false;job.detail="Previous version restored.";job.result=message;job.deliveredChunks=0;job.releaseId=undefined;
        this.active=undefined;await this.saveAndPaint(job);await this.deliver(job);await this.pump();
      }),error=>this.enqueue(async()=>{job.phase="done";job.undoing=false;job.detail=String(error).slice(0,1000);this.active=undefined;await this.saveAndPaint(job);})).finally(()=>{this.releaseTask=undefined;});
      return "Undo received. I'll confirm when the previous version is restored.";
    }
    if (verb === "stop") { await this.stopJob(job); return job.phase === "stopping" ? "Stopping now…" : "Stopped, or already finished."; }
    if (verb === "retry" && job.phase === "interrupted") {
      if (this.active) return "Please wait for the current request, or stop it first.";
      if (!this.connected) {
        try { await this.codex.stop?.(); await this.connect(); }
        catch { return "The coding agent is still unavailable. Your request is saved."; }
      }
      // Disconnect notifications from the old transport must be processed before
      // reconnect; adapters identify stale process closures separately.
      job.turnId = undefined; job.result = undefined; job.needsReply = false; job.deliveredChunks = 0;
      job.phase = "received"; job.detail = "Got it. I'll inspect the saved work and continue.";
      job.message.content = `Continue this request after an interruption. Inspect existing changes before doing more work.\n\n${job.message.content}`;
      await this.saveAndPaint(job); await this.pump(); return "Retry received.";
    }
    return "That action is no longer needed.";
  }

  private async stopJob(job?: Job): Promise<void> {
    if (!job) return;
    if (job === this.active) {
      if(this.releaseAbort) {this.releaseAbort.abort(); job.detail="Stop received. Finishing safely; restoring the previous version if uploading already started."; await this.saveAndPaint(job); return;}
      if(this.releaseTask) return;
      if (job.phase === "stopping") return;
      job.phase = "stopping"; job.detail = "Stop received. Waiting for the agent to stop.";
      await this.saveAndPaint(job); await this.pauseQueue();
      try { if (!await this.codex.interrupt()) throw new Error("No active turn"); }
      catch { await this.codex.stop?.(); await this.disconnect(); }
    } else if (["received", "queued", "waiting"].includes(job.phase)) {
      job.phase = "stopped"; job.detail = "Cancelled this request."; await this.saveAndPaint(job);
    }
  }

  private async pauseQueue(): Promise<void> {
    for (const job of this.state.jobs.filter((j) => ["received", "queued"].includes(j.phase))) {
      job.phase = "interrupted"; job.detail = "This queued request is paused. Tap Retry when you're ready.";
      await this.saveAndPaint(job);
    }
  }

  private async disconnect(): Promise<void> {
    this.connected = false;
    if(this.releaseTask) return;
    if (this.active) {
      const job = this.active;
      job.phase = "interrupted"; job.detail = "The coding agent disconnected. Your request and any edits are saved. Tap Retry to reconnect.";
      this.active = undefined; this.pendingInput = undefined; this.approvals.clear();
      await this.saveAndPaint(job);
    }
    await this.pauseQueue();
  }

  private async saveAndPaint(job: Job): Promise<void> {
    await this.store.save(this.state);
    this.dirty.add(job.id);
    await this.paint(job);
  }
  private async paint(job: Job): Promise<void> {
    try {
      job.cardId = await this.discord.putStatus(job.message.channelId, job.cardId, taskCard(job, this.now(), this.connected));
      this.lastPaint.set(job.id, this.now()); this.dirty.delete(job.id);
      await this.store.save(this.state);
    } catch { console.error("Status delivery failed; will retry"); }
  }
  private async deliver(job: Job): Promise<void> {
    if (!job.result || !["done", "waiting"].includes(job.phase)) return;
    const chunks = chunkReply(job.result);
    while (job.deliveredChunks < chunks.length) {
      try {
        await this.discord.sendMessage(job.message.channelId, chunks[job.deliveredChunks]!);
        job.deliveredChunks++;
        await this.store.save(this.state);
      } catch { console.error("Reply delivery failed; will retry"); return; }
    }
  }
  private async flush(): Promise<void> {
    for (const job of this.state.jobs) {
      if (this.dirty.has(job.id)) await this.paint(job);
      await this.deliver(job);
    }
  }
  async tick(): Promise<void> {
    if (this.closing) return;
    if (this.active && !this.releaseTask && this.now() - this.lastProbe >= 30000) {
      this.lastProbe = this.now();
      try { await this.codex.health(this.state.threadId!); }
      catch { await this.codex.stop?.(); await this.disconnect(); }
      if (this.active) this.dirty.add(this.active.id);
    }
    if(this.active && this.releaseTask) {this.active.activity=this.now(); this.dirty.add(this.active.id);}
    for (const job of this.state.jobs) {
      if (this.dirty.has(job.id) && this.now() - (this.lastPaint.get(job.id) ?? 0) >= 3000) await this.paint(job);
      await this.deliver(job);
    }
    await this.pump();
  }
  async stop(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    clearInterval(this.timer);
    await this.settled();
    this.releaseAbort?.abort();
    await this.releaseTask;
    await this.codex.stop?.();
    await this.disconnect();
    await this.discord.stop();
    await this.store.close();
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
export function parseResult(text: string): { message: string; needsReply: boolean } {
  try {
    const value = JSON.parse(text) as unknown;
    const result = record(value);
    if (typeof result.message === "string" && ["done", "needs_reply"].includes(String(result.state))) {
      return { message: result.message, needsReply: result.state === "needs_reply" };
    }
  } catch { /* Older models may answer in plain text. */ }
  return { message: text, needsReply: false };
}
