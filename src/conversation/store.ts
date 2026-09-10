import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DiscordMessage } from "../discord/gateway.js";

export type Phase = "received" | "queued" | "working" | "waiting" | "stopping" | "done" | "stopped" | "interrupted" | "checking" | "publishing" | "verifying" | "rolling_back" | "review";
export interface Job {
  id: string;
  message: DiscordMessage;
  phase: Phase;
  detail: string;
  created: number;
  activity: number;
  turnId?: string;
  releaseId?: string;
  repairs?: number;
  checkAttempts?: number;
  retryCheckpoint?: {tree:string; baseline:string};
  resolvedBy?: string;
  supersededBy?: string;
  continuesDraft?: boolean;
  earlyReply?: string;
  earlyDeliveredChunks?: number;
  preview?: {id:string;url:string;tree:string};
  undoing?: boolean;
  started?: boolean;
  sourceStart?: {tree:string; baseline:string};
  cardId?: string;
  result?: string;
  needsReply?: boolean;
  needsReview?: boolean;
  deliveredChunks: number;
}
export interface ConversationState {
  threadId?: string;
  jobs: Job[];
  seen: string[];
}

export class ConversationStore {
  private locked = false;
  constructor(private readonly dir: string) {}

  async open(): Promise<ConversationState> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const lockPath = path.join(this.dir, "conversation.lock");
    try {
      const file = await open(lockPath, "wx", 0o600);
      await file.writeFile(String(process.pid));
      await file.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(await readFile(lockPath, "utf8"));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error("Invalid bot lock; inspect it before restarting");
      try { process.kill(pid, 0); }
      catch (probe) {
        if ((probe as NodeJS.ErrnoException).code === "ESRCH") {
          await unlink(lockPath);
          return this.open();
        }
        throw probe;
      }
      throw new Error("Another bot is already using this conversation");
    }
    this.locked = true;
    try {
      return JSON.parse(await readFile(path.join(this.dir, "conversation.json"), "utf8")) as ConversationState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { jobs: [], seen: [] };
      await this.close();
      throw error;
    }
  }

  async save(state: ConversationState): Promise<void> {
    const file = path.join(this.dir, "conversation.json");
    await writeFile(`${file}.tmp`, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  }

  async close(): Promise<void> {
    if (!this.locked) return;
    this.locked = false;
    await unlink(path.join(this.dir, "conversation.lock"));
  }
}
