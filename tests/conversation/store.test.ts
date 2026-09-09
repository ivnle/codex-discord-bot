import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConversationStore } from "../../src/conversation/store.js";

describe("conversation persistence",()=>{
  it("preserves requests and reply delivery state across restarts and rejects a second process",async()=>{
    const dir=await mkdtemp(path.join(tmpdir(),"family-store-"));
    const first=new ConversationStore(dir), second=new ConversationStore(dir);
    try {
      const state=await first.open(); state.threadId="saved-thread";
      state.jobs.push({id:"job",message:{id:"message",authorId:"wife",channelId:"game",content:"blue dinosaurs",isDirectMessage:false,attachments:[]},phase:"working",detail:"Making changes",created:1,activity:2,cardId:"discord-card",result:"reply",deliveredChunks:1});
      await first.save(state);
      await expect(second.open()).rejects.toThrow("already using");
      await first.close(); expect(await second.open()).toEqual(state);
    } finally {await first.close();await second.close();await rm(dir,{recursive:true,force:true});}
  });
});
