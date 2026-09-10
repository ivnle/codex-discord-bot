import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FamilyConversation, type ConversationCodex } from "../../src/conversation/runtime.js";
import { ConversationStore } from "../../src/conversation/store.js";
import { loadConfigFromString } from "../../src/config/load.js";
import type { ConversationGateway, DiscordMessage, TaskCard, TaskAction } from "../../src/discord/gateway.js";
import type { JsonRpcMessage } from "../../src/codex/json-rpc.js";

const dirs: string[] = [];
const bots: FamilyConversation[] = [];
afterEach(async () => { for (const bot of bots.splice(0)) await bot.stop(); for (const dir of dirs.splice(0)) await rm(dir, {recursive:true, force:true}); });
async function setup(releases?: import("../../src/releases/controller.js").ReleaseService, history?: DiscordMessage[]) {
  const dir = await mkdtemp(path.join(tmpdir(), "family-test-")); dirs.push(dir);
  const config = loadConfigFromString(`name: test\ndiscord_token_env: TOKEN\ncodex:\n  cwd: /tmp\naccess:\n  allow_user_ids: [wife]\n  channels: [game]\nruntime:\n  data_dir: ${dir}\n`);
  let receive!: (message: DiscordMessage) => Promise<void>;
  let action!: (action: TaskAction) => Promise<string>;
  let event!: (event: JsonRpcMessage) => void;
  let disconnect!: () => void;
  let time = 100000;
  const cards = new Map<string, TaskCard>();
  const replies: string[] = [];
  const turns: unknown[] = [];
  const responses: unknown[] = [];
  let failReply = false;
  let failStart = false;
  const gateway = {
    onMessage(h: typeof receive) { receive = h; }, onAction(h: typeof action) { action = h; }, onApprovalChoice() {},
    async start() {if(history?.[0])await receive(history[0]);}, async stop() {}, async sendTyping() {}, async sendApprovalPrompt() {},
    async messagesAfter() {return history ?? [];},
    async sendMessage(_c: string, text: string) { if (failReply) throw Error("offline"); replies.push(text); },
    async putStatus(_c: string, id: string | undefined, card: TaskCard) { id ??= String(cards.size+1); cards.set(id, card); return id; },
  } as ConversationGateway;
  const codex = {
    onEvent(h: typeof event) { event=h; }, onDisconnect(h: typeof disconnect) { disconnect=h; },
    async connect() {}, async stop() {}, async health() {}, async startThread() {return "thread";}, async resumeThread() {return "thread";},
    async startTurn(request: unknown) { turns.push(request); if (failStart) throw Error("timeout"); }, async interrupt() {return true;},
    async sendApprovalResponse(_id: unknown, response: unknown) {responses.push(response);},
    onFinalMessage() {}, onTurnCompleted() {}, onApprovalRequest() {}, getTokenUsage() {}, async compact() {},
  } as ConversationCodex;
  if(history)await writeFile(path.join(dir,"conversation.json"),JSON.stringify({jobs:[],seen:["100"]}));
  const store = new ConversationStore(dir);
  const bot = new FamilyConversation(config,gateway,codex,store,()=>time,releases); bots.push(bot); await bot.start("token");
  const send = (text="make dinosaurs bigger", id=String(Math.random()), authorId="wife", channelId="game") => receive({id,authorId,channelId,content:text,isDirectMessage:false,attachments:[]});
  const emit = async (method:string, params:Record<string,unknown>, id?:number) => {event({method,params:{threadId:"thread",...params},...(id!==undefined?{id}:{})}); await bot.settled();};
  const complete = async (turnId="t1", state="done") => {
    await emit("item/completed",{turnId,item:{type:"agentMessage",phase:"final_answer",text:JSON.stringify({message:"All done",state})}});
    await emit("turn/completed",{turn:{id:turnId,status:"completed"}});
  };
  return {bot,dir,send,emit,complete,cards,replies,turns,responses,action,disconnect,
    setFailReply:(v:boolean)=>{failReply=v;},setFailStart:(v:boolean)=>{failStart=v;}, advance:()=>{time+=31000;}};
}

describe("family conversation",()=>{
  it("acknowledges, edits one card, and sends a completion reply",async()=>{
    const h=await setup(); await h.send(); expect(h.cards.size).toBe(1); expect([...h.cards.values()][0]!.content).toContain("Working");
    await h.complete(); expect(h.replies).toEqual(["All done"]); expect(h.cards.size).toBe(1); expect([...h.cards.values()][0]!.content).toContain("Ready for your next idea");
  });
  it("rejects other users and channels and deduplicates messages",async()=>{
    const h=await setup(); await h.send("hello","1","stranger"); await h.send("hello","2","wife","elsewhere"); expect(h.turns).toHaveLength(0);
    await h.send("hello","3"); await h.send("hello","3"); expect(h.turns).toHaveLength(1);
  });
  it("makes queued follow-ups visible and starts only one turn at a time",async()=>{
    const h=await setup(); await h.send(); await h.send("blue too"); expect(h.turns).toHaveLength(1); expect([...h.cards.values()][1]!.content).toContain("Up next");
    await h.complete(); expect(h.turns).toHaveLength(2);
  });
  it("Stop waits for actual termination and pauses queued work",async()=>{
    const h=await setup(); await h.send(); await h.send("blue too");
    const stop=[...h.cards.values()][0]!.actions[0]!.id;
    await h.action({id:stop,userId:"wife",channelId:"game"}); expect([...h.cards.values()][0]!.content).toContain("Stopping");
    await h.emit("turn/completed",{turn:{id:"t1",status:"interrupted"}});
    expect([...h.cards.values()][0]!.content).toContain("Stopped"); expect(h.turns).toHaveLength(1); expect([...h.cards.values()][1]!.content).toContain("Interrupted");
  });
  it("does not accept stale or unauthorized Stop buttons",async()=>{
    const h=await setup(); await h.send(); const stop=[...h.cards.values()][0]!.actions[0]!.id;
    await h.action({id:stop,userId:"stranger",channelId:"game"}); expect([...h.cards.values()][0]!.content).toContain("Working");
    await h.complete(); await h.action({id:stop,userId:"wife",channelId:"game"}); expect([...h.cards.values()][0]!.content).toContain("Done");
  });
  it("turns a disconnected worker into an explicit interrupted state",async()=>{
    const h=await setup(); await h.send(); h.disconnect(); await h.bot.settled(); expect([...h.cards.values()][0]!.content).toContain("Interrupted");
    const retry=[...h.cards.values()][0]!.actions[0]!.id; await h.action({id:retry,userId:"wife",channelId:"game"}); expect(h.turns).toHaveLength(2);
  });
  it("fails visibly when starting a turn times out",async()=>{
    const h=await setup(); h.setFailStart(true); await h.send(); expect([...h.cards.values()][0]!.content).toContain("Interrupted");
  });
  it("retries delivery without running Codex twice",async()=>{
    const h=await setup(); await h.send(); h.setFailReply(true); await h.complete(); expect(h.replies).toHaveLength(0);
    h.setFailReply(false); h.advance(); await h.bot.tick(); expect(h.replies).toEqual(["All done"]); expect(h.turns).toHaveLength(1);
  });
  it("shows a conversational question as waiting, then accepts an ordinary reply",async()=>{
    const h=await setup(); await h.send(); await h.complete("t1","needs_reply"); expect([...h.cards.values()][0]!.content).toContain("Needs your answer");
    await h.send("yes"); expect(h.turns).toHaveLength(2); expect([...h.cards.values()][0]!.content).toContain("Answer received");
  });
  it("answers a blocking Codex question without starting another turn",async()=>{
    const h=await setup(); await h.send(); await h.emit("item/tool/requestUserInput",{turnId:"t1",questions:[{id:"color",question:"Which color?"}]},42);
    await h.send("blue"); expect(h.responses).toEqual([{answers:{color:{answers:["blue"]}}}]); expect(h.turns).toHaveLength(1);
  });
  it("ignores late completion events from an older turn",async()=>{
    const h=await setup(); await h.send(); await h.complete(); await h.send(); await h.emit("turn/started",{turn:{id:"t2"}});
    await h.emit("turn/completed",{turn:{id:"t1",status:"completed"}}); expect([...h.cards.values()][1]!.content).toContain("Working");
  });
});


describe("automatic releases in Discord",()=>{
  it("keeps queued requests waiting during checks and only confirms a verified publication",async()=>{
    let finish!:(v:any)=>void;
    const service={recover:async()=>{},undo:async()=>"restored",release:async(_id:string,update:any)=>{
      await update("checking","Checking all games.");return await new Promise<any>(resolve=>{finish=resolve;});
    }};
    const h=await setup(service);await h.send();await h.complete();await h.bot.settled();
    await h.send("next idea");expect(h.turns).toHaveLength(1);expect(h.replies).toEqual([]);
    expect([...h.cards.values()][0]!.content).toContain("Checking");
    finish({published:true,id:"release-1",message:"Verified live version"});
    await new Promise(r=>setTimeout(r,10));await h.bot.settled();
    expect(h.replies).toEqual(["Verified live version"]);expect(h.turns).toHaveLength(2);
    expect([...h.cards.values()][0]!.actions.some(a=>a.label==="Undo this change")).toBe(true);
  });
  it("Stop aborts checking without interrupting an already finished Codex turn",async()=>{
    let signal!:AbortSignal;
    const service={recover:async()=>{},undo:async()=>"restored",release:async(_id:string,update:any,s:AbortSignal)=>{
      signal=s;await update("checking","Checking games.");return await new Promise<any>((_resolve,reject)=>s.addEventListener("abort",()=>reject(Error("cancelled"))));
    }};
    const h=await setup(service);await h.send();await h.complete();await h.bot.settled();
    await h.send("stop");await new Promise(r=>setTimeout(r,10));await h.bot.settled();
    expect(signal.aborted).toBe(true);expect(h.replies).toEqual([]);expect([...h.cards.values()][0]!.content).toContain("Stopped");
  });
  it("routes a protected change to review without asking the agent to bypass policy",async()=>{
    const {ReviewRequired}=await import("../../src/releases/policy.js");
    const service={recover:async()=>{},undo:async()=>"restored",release:async()=>{throw new ReviewRequired("Storage needs review.");}};
    const h=await setup(service);await h.send();await h.complete();await new Promise(r=>setTimeout(r,10));await h.bot.settled();
    expect(h.turns).toHaveLength(1);expect(h.replies).toEqual([]);expect([...h.cards.values()][0]!.content).toContain("Ivan");
  });
  it("sends a failed check back for repair without publishing the agent's premature answer",async()=>{
    const service={recover:async()=>{},undo:async()=>"restored",release:async()=>{throw Error("Pizza interaction check failed");}};
    const h=await setup(service);await h.send();await h.complete();await new Promise(r=>setTimeout(r,10));await h.bot.settled();
    expect(h.turns).toHaveLength(2);expect(h.replies).toEqual([]);expect(JSON.stringify(h.turns[1])).toContain("Pizza interaction check failed");
  });
});

it("recovers an offline message once even when it also arrives during connection",async()=>{
 const message={id:"101",authorId:"wife",channelId:"game",content:"A saved request",isDirectMessage:false,attachments:[]};
 const h=await setup(undefined,[message]);
 expect(h.turns).toHaveLength(1);expect(h.cards.size).toBe(1);expect(JSON.stringify(h.turns[0])).toContain("A saved request");
});

it("does not expose an outdated coding draft in a verified release reply",async()=>{
 const service={recover:async()=>{},undo:async()=>"restored",status:async()=>"Trusted status: last change published.",release:async()=>({published:true,id:"version",message:"Verified live. Refresh the game."})};
 const h=await setup(service);await h.send();
 expect(JSON.stringify(h.turns[0])).toContain("Trusted status: last change published.");
 await h.emit("item/completed",{turnId:"t1",item:{type:"agentMessage",phase:"final_answer",text:JSON.stringify({message:"Browser blocked. Nothing was published; no preview is available.",state:"done"})}});
 await h.emit("turn/completed",{turn:{id:"t1",status:"completed"}});await new Promise(r=>setTimeout(r,10));await h.bot.settled();
 expect(h.replies).toEqual(["Verified live. Refresh the game."]);
});
it("does not treat a cancelled queued request as unfinished edits",async()=>{
 const service={recover:async()=>{},undo:async()=>"restored",release:async()=>({published:false})};
 const h=await setup(service);await h.send("first");await h.send("cancelled second");
 const stop=[...h.cards.values()][1]!.actions.find(a=>a.label==="Stop")!;
 await h.action({id:stop.id,userId:"wife",channelId:"game"});await h.complete();await new Promise(r=>setTimeout(r,10));await h.bot.settled();
 await h.send("unrelated question");expect(JSON.stringify(h.turns.at(-1))).not.toContain("cancelled second");
});

it("distinguishes owner review from a question for the parent",async()=>{
 let releases=0;const service={recover:async()=>{},undo:async()=>"restored",hasChanges:async()=>false,release:async()=>{releases++;return {published:false};}};
 const h=await setup(service);await h.send("change protected storage");await h.complete("t1","needs_review");
 expect(releases).toBe(0);expect([...h.cards.values()][0]!.content).toContain("Ivan");expect(h.replies).toEqual(["All done"]);
 await h.send("ordinary question");expect(JSON.stringify(h.turns.at(-1))).not.toContain("saved unfinished edits");
});

it.each([
 ['dirty','dirty',false,false],
 ['dirty','new',false,true],
 ['base','new',true,false],
 ['base','base',false,false],
] as const)('request checkpoint %s -> %s prevents inherited publication',async(start,end,published,review)=>{
 let tree:string=start;let calls=0;
 const h=await setup({recover:async()=>{},undo:async()=>'',checkpoint:async()=>({tree,baseline:'base'}),release:async()=>{calls++;return {published:true,message:'Verified live'};}});
 await h.send('current request');tree=end;await h.complete();await h.bot.settled();
 expect(calls).toBe(published?1:0);
 expect([...h.cards.values()][0]!.content.includes('Ivan’s review')).toBe(review);
});
it('explicit Resume retains ownership of a stopped request',async()=>{
 let tree='base';let calls=0;
 const h=await setup({recover:async()=>{},undo:async()=>'',checkpoint:async()=>({tree,baseline:'base'}),release:async()=>{calls++;return {published:true,message:'Verified live'};}});
 await h.send('lavender');tree='lavender';
 await h.action({id:[...h.cards.values()][0]!.actions[0]!.id,userId:'wife',channelId:'game'});
 await h.emit('turn/completed',{turn:{id:'t1',status:'interrupted'}});
 const resume=[...h.cards.values()][0]!.actions.find(a=>a.label==='Resume')!;
 await h.action({id:resume.id,userId:'wife',channelId:'game'});await h.complete('t2');await h.bot.settled();expect(calls).toBe(1);
});

it('does not spend a repair turn on unavailable test infrastructure',async()=>{
 const {CheckUnavailable}=await import('../../src/releases/policy.js');
 const service={recover:async()=>{},undo:async()=>"restored",release:async()=>{throw new CheckUnavailable('browser unavailable');}};
 const h=await setup(service);await h.send();await h.complete();await new Promise(r=>setTimeout(r,10));await h.bot.settled();
 expect(h.turns).toHaveLength(1);
 expect([...h.cards.values()][0]!.content).toContain('test environment');
 expect([...h.cards.values()][0]!.actions.some(a=>a.label==='Retry')).toBe(true);
});

it('retries identical infrastructure-blocked work without another coding turn',async()=>{
 const {CheckUnavailable}=await import('../../src/releases/policy.js');
 let calls=0,tree='base';
 const service={recover:async()=>{},undo:async()=>"restored",checkpoint:async()=>({tree,baseline:'base'}),release:async()=>{
  if(++calls===1)throw new CheckUnavailable('browser unavailable');return {published:true,message:'Verified live.'};
 }};
 const h=await setup(service);await h.send();tree='same';await h.complete();await new Promise(r=>setTimeout(r,10));await h.bot.settled();
 const retry=[...h.cards.values()][0]!.actions.find(a=>a.label==='Retry')!;
 await h.action({id:retry.id,userId:'wife',channelId:'game'});await new Promise(r=>setTimeout(r,10));await h.bot.settled();
 expect(calls).toBe(2);expect(h.turns).toHaveLength(1);expect(h.replies).toEqual(['Verified live.']);
});
it('refuses an infrastructure retry if the candidate has changed',async()=>{
 const {CheckUnavailable}=await import('../../src/releases/policy.js');
 let tree='base',calls=0;
 const service={recover:async()=>{},undo:async()=>"restored",checkpoint:async()=>({tree,baseline:'base'}),release:async()=>{calls++;throw new CheckUnavailable('browser unavailable');}};
 const h=await setup(service);await h.send();tree='same';await h.complete();await new Promise(r=>setTimeout(r,10));await h.bot.settled();tree='changed';
 const retry=[...h.cards.values()][0]!.actions.find(a=>a.label==='Retry')!;
 await h.action({id:retry.id,userId:'wife',channelId:'game'});await h.bot.settled();
 expect(calls).toBe(1);expect(h.turns).toHaveLength(1);expect([...h.cards.values()][0]!.content).toContain('saved candidate changed');
});
it('status refresh does not pretend a running check made progress',async()=>{
 let finish!:(x:any)=>void;
 const service={recover:async()=>{},undo:async()=>"restored",release:async(_id:string,update:any)=>{await update('checking','Testing game');return new Promise<any>(resolve=>{finish=resolve;});}};
 const h=await setup(service);await h.send();await h.complete();await new Promise(r=>setTimeout(r,10));await h.bot.settled();
 const before=[...h.cards.values()][0]!.content.match(/Last progress <t:\d+:R>/)![0];
 h.advance();await h.bot.tick();await h.bot.settled();
 expect([...h.cards.values()][0]!.content).toContain(before);
 finish({published:false});await new Promise(r=>setTimeout(r,10));await h.bot.settled();
});

it('does not leave a phantom working job when repair startup fails after direct retry',async()=>{
 const {CheckUnavailable,CheckFailed}=await import('../../src/releases/policy.js');
 let calls=0,tree='base';
 const service={recover:async()=>{},undo:async()=>"restored",checkpoint:async()=>({tree,baseline:'base'}),release:async()=>{
  if(++calls===1)throw new CheckUnavailable('browser unavailable');throw new CheckFailed('gameplay assertion failed');
 }};
 const h=await setup(service);await h.send();tree='candidate';await h.complete();await new Promise(r=>setTimeout(r,10));await h.bot.settled();
 h.disconnect();await h.bot.settled();h.setFailStart(true);
 const retry=[...h.cards.values()][0]!.actions.find(a=>a.label==='Retry')!;
 await h.action({id:retry.id,userId:'wife',channelId:'game'});await new Promise(r=>setTimeout(r,10));await h.bot.settled();
 expect(calls).toBe(2);expect([...h.cards.values()][0]!.content).toContain('could not start the repair');
 expect([...h.cards.values()][0]!.actions.some(a=>a.label==='Retry')).toBe(true);
});


describe("draft preview feedback", () => {
  const preview = {id: "draft-1", url: "https://draft.example.test/potty/", tree: "candidate"};
  const savedJobs = async (dir: string) => JSON.parse(await readFile(path.join(dir, "conversation.json"), "utf8")).jobs;

  it("persists the draft link and keeps it visible through later checking updates", async () => {
    let update!: (phase: "checking", detail: string, draft?: typeof preview) => Promise<void>;
    let finish!: (result: {published: boolean}) => void;
    const h = await setup({recover: async () => {}, undo: async () => "", release: async (_id, progress) => {
      update = progress;
      await update("checking", "Try the draft while broader checks run.", preview);
      return new Promise(resolve => {finish = resolve;});
    }});
    try {
      await h.send(); await h.complete();
      await expect.poll(() => [...h.cards.values()][0]?.content).toContain(preview.url);
      await update("checking", "Checking the other games.");
      expect([...h.cards.values()][0]!.content).toContain(preview.url);
      expect((await savedJobs(h.dir))[0].preview).toEqual(preview);
    } finally {finish?.({published: false}); await h.bot.settled();}
  });

  it.each([false, true])("cancels obsolete checks and answers a question-only follow-up before publication (retry delivery: %s)", async failEarlyDelivery => {
    let tree = "base", calls = 0;
    let finishRevised!: (result: {published: boolean; message: string}) => void;
    let signal!: AbortSignal;
    let rejectOld!: (error: Error) => void;
    let obsoleteUpdate!: (phase: "checking", detail: string) => Promise<void>;
    const h = await setup({recover: async () => {}, undo: async () => "", checkpoint: async () => ({tree, baseline: "base"}),
      release: async (_id, update, abort) => {
        calls++;
        if (calls > 1) return new Promise(resolve => {finishRevised = resolve;});
        signal = abort!;
        obsoleteUpdate = update;
        await update("checking", "Draft is ready.", preview);
        return new Promise((_resolve, reject) => {rejectOld = reject;});
      }});
    try {
      await h.send("Make the character enter from the right."); tree = "candidate"; await h.complete();
      await expect.poll(() => [...h.cards.values()][0]?.content).toContain(preview.url);
      await h.send("How fast does the character walk?");
      expect(signal.aborted).toBe(true);
      expect(h.turns).toHaveLength(1); // Browser cleanup still owns the workspace.
      expect(h.replies).toEqual([]);
      const [old, next] = await savedJobs(h.dir);
      expect(old.supersededBy).toBe(next.id);
      expect(old.resolvedBy).toBe(next.id);
      await obsoleteUpdate("checking", "Obsolete test progress.");
      expect([...h.cards.values()][0]!.content).not.toContain("Obsolete test progress.");
      expect(next.sourceStart).toEqual({tree: "base", baseline: "base"});
      expect(next.message.content).toContain("Make the character enter from the right.");
      expect(next.message.content).toContain("How fast does the character walk?");
      // A late assertion failure from the old runner must not trigger a repair turn.
      rejectOld(new Error("obsolete browser assertion failed after cancellation"));
      await expect.poll(() => h.turns.length).toBe(2);
      expect(JSON.stringify(h.turns[1])).toContain("How fast does the character walk?");
      expect(JSON.stringify(h.turns[1])).not.toContain("obsolete browser assertion");
      expect(calls).toBe(1);
      // The answer adds no edits, but the inherited candidate remains authorized.
      h.setFailReply(failEarlyDelivery);
      await h.complete("t2");
      await expect.poll(() => calls).toBe(2);
      if (failEarlyDelivery) {
        expect(h.replies).toEqual([]);
        expect((await savedJobs(h.dir))[1].earlyReply).toBe("All done");
        expect((await savedJobs(h.dir))[1].earlyDeliveredChunks).toBe(0);
        h.setFailReply(false); h.advance(); await h.bot.tick(); await h.bot.settled();
      }
      // The parent gets their answer while the resumed release remains pending.
      expect(h.replies).toEqual(["All done"]);
      expect((await savedJobs(h.dir))[1].earlyDeliveredChunks).toBe(1);
      h.advance(); await h.bot.tick(); await h.bot.settled();
      expect(h.replies).toEqual(["All done"]);
      finishRevised({published: true, message: "Revised draft verified live."});
      await expect.poll(() => h.replies).toEqual(["All done", "Revised draft verified live."]);
      expect(h.turns).toHaveLength(2);
    } finally {
      rejectOld?.(new Error("test cleanup"));
      finishRevised?.({published: false, message: "test cleanup"});
      await h.bot.settled();
    }
  });

  it("replaces checks when a preview arrives after feedback was queued, and rejects controls on the old draft", async () => {
    let tree = "base";
    let signal!: AbortSignal;
    let progress!: (phase: "checking", detail: string, draft?: typeof preview) => Promise<void>;
    let rejectOld!: (error: Error) => void;
    const h = await setup({recover: async () => {}, undo: async () => "", checkpoint: async () => ({tree, baseline: "base"}),
      release: async (_id, update, abort) => {
        signal = abort!; progress = update;
        await update("checking", "Preparing the draft.");
        return new Promise((_resolve, reject) => {rejectOld = reject;});
      }});
    try {
      await h.send("Make the character enter from the right."); tree = "candidate"; await h.complete();
      await expect.poll(() => typeof rejectOld).toBe("function");
      await h.send("Make the walk slower too.");
      expect(signal.aborted).toBe(false);
      expect(h.turns).toHaveLength(1);
      expect((await savedJobs(h.dir))[1].sourceStart).toBeUndefined();
      await progress("checking", "Draft is ready.", preview);
      expect(signal.aborted).toBe(true);
      expect(h.turns).toHaveLength(1);
      const [old, next] = await savedJobs(h.dir);
      expect(old.supersededBy).toBe(next.id);
      expect(old.resolvedBy).toBe(next.id);
      expect(next.sourceStart).toEqual({tree: "base", baseline: "base"});
      expect(next.message.content).toContain("Make the character enter from the right.");
      expect(next.message.content).toContain("Make the walk slower too.");
      expect([...h.cards.values()][0]!.actions).toEqual([]);
      for (const verb of ["stop", "retry"]) {
        expect(await h.action({id: `${verb}:${old.id}`, userId: "wife", channelId: "game"})).toContain("replaced");
      }
      expect(h.turns).toHaveLength(1);
      rejectOld(new Error("cancelled after cleanup"));
      await expect.poll(() => h.turns.length).toBe(2);
      expect([...h.cards.values()][0]!.actions).toEqual([]);
      expect((await savedJobs(h.dir))[1].sourceStart).toEqual({tree: "base", baseline: "base"});
      expect(h.replies).toEqual([]);
    } finally {rejectOld?.(new Error("test cleanup")); await h.bot.settled();}
  });

  it("retains draft authorization through a clarification question and the parent's answer", async () => {
    let tree = "base", calls = 0;
    let rejectOld!: (error: Error) => void;
    const h = await setup({recover: async () => {}, undo: async () => "", checkpoint: async () => ({tree, baseline: "base"}),
      release: async (_id, update) => {
        if (++calls > 1) return {published: true, message: "Clarified draft verified live."};
        await update("checking", "Draft is ready.", preview);
        return new Promise((_resolve, reject) => {rejectOld = reject;});
      }});
    try {
      await h.send("Make the character enter from the right."); tree = "candidate"; await h.complete();
      await expect.poll(() => typeof rejectOld).toBe("function");
      await h.send("Maybe change the walking speed?");
      rejectOld(new Error("cancelled after cleanup"));
      await expect.poll(() => h.turns.length).toBe(2);
      await h.emit("item/completed", {turnId: "t2", item: {type: "agentMessage", phase: "final_answer",
        text: JSON.stringify({message: "Should the character walk faster or slower?", state: "needs_reply"})}});
      await h.emit("turn/completed", {turn: {id: "t2", status: "completed"}});
      expect(calls).toBe(1);
      expect(h.replies).toEqual(["Should the character walk faster or slower?"]);
      expect((await savedJobs(h.dir))[1].phase).toBe("waiting");
      await h.send("Keep the current speed, thanks.");
      expect(h.turns).toHaveLength(3);
      const [, discussion, answer] = await savedJobs(h.dir);
      expect(discussion.resolvedBy).toBe(answer.id);
      expect(answer.sourceStart).toEqual({tree: "base", baseline: "base"});
      expect(answer.continuesDraft).toBe(true);
      expect(JSON.stringify(h.turns[2])).toContain("Make the character enter from the right.");
      expect(JSON.stringify(h.turns[2])).toContain("Keep the current speed, thanks.");
      // No new edits are necessary; the original candidate is still authorized.
      await h.complete("t3");
      await expect.poll(() => h.replies).toEqual([
        "Should the character walk faster or slower?", "All done", "Clarified draft verified live.",
      ]);
      expect(calls).toBe(2);
      expect((await savedJobs(h.dir))[2].phase).toBe("done");
      expect([...h.cards.values()][2]!.content).not.toContain("Ivan’s review");
    } finally {rejectOld?.(new Error("test cleanup")); await h.bot.settled();}
  });

  it.each(["publishing", "verifying"] as const)("queues feedback without interrupting %s", async phase => {
    let signal!: AbortSignal;
    let finish!: (result: {published: boolean; message: string}) => void;
    let tree = "base";
    const h = await setup({recover: async () => {}, undo: async () => "", checkpoint: async () => ({tree, baseline: "base"}),
      release: async (_id, update, abort) => {
        signal = abort!;
        await update("checking", "Draft ready.", preview);
        await update(phase, "Finishing publication.");
        return new Promise(resolve => {finish = resolve;});
      }});
    try {
      await h.send(); tree = "candidate"; await h.complete();
      await expect.poll(async () => (await savedJobs(h.dir))[0].phase).toBe(phase);
      await h.send("Make it a little slower.");
      expect(signal.aborted).toBe(false);
      expect(h.turns).toHaveLength(1);
      const [old, next] = await savedJobs(h.dir);
      expect(old.supersededBy).toBeUndefined();
      expect(next.phase).toBe("queued");
      finish({published: true, message: "Verified live."});
      await expect.poll(() => h.turns.length).toBe(2);
      expect(h.replies).toEqual(["Verified live."]);
    } finally {finish?.({published: false, message: "test cleanup"}); await h.bot.settled();}
  });

  it("answers an ordinary question without starting release checks when no edits exist", async () => {
    let calls = 0;
    const h = await setup({recover: async () => {}, undo: async () => "", checkpoint: async () => ({tree: "base", baseline: "base"}),
      release: async () => {calls++; return {published: false};}});
    await h.send("What games can my child play?"); await h.complete();
    expect(calls).toBe(0);
    expect(h.replies).toEqual(["All done"]);
  });
});
