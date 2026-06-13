import type {
  CodexApprovalRequestHandler,
  CodexClient,
  CodexFinalMessageHandler,
  CodexRpcId,
  CodexStartTurnRequest,
  CodexThreadOptions,
  CodexTurnCompletedHandler
} from "./client.js";
import { JsonRpcPeer, type JsonRpcMessage, type JsonRpcTransport } from "./json-rpc.js";

const APPROVAL_REQUEST_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "execCommandApproval",
  "applyPatchApproval"
]);
const COMPACT_TIMEOUT_MS = 60_000;

type CompactWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export class AppServerCodexClient implements CodexClient {
  private readonly peer: JsonRpcPeer;
  private readonly finalHandlers: CodexFinalMessageHandler[] = [];
  private readonly turnCompletedHandlers: CodexTurnCompletedHandler[] = [];
  private readonly approvalHandlers: CodexApprovalRequestHandler[] = [];
  private readonly compactWaiters = new Map<string, CompactWaiter>();
  private currentThreadId: string | undefined;
  private currentTurnId: string | undefined;

  constructor(transport: JsonRpcTransport) {
    this.peer = new JsonRpcPeer(transport);
    this.peer.onNotification((message) => this.handleNotification(message));
    this.peer.onRequest((message) => this.handleServerRequest(message));
  }

  async connect(): Promise<void> {
    await this.peer.start();
    await this.peer.request("initialize", {
      clientInfo: {
        name: "codex-discord-bot",
        title: "Codex Discord Bot",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false
      }
    });
  }

  async stop(): Promise<void> {
    await this.peer.stop();
  }

  async startThread(options: CodexThreadOptions): Promise<string> {
    const result = await this.peer.request("thread/start", {
      ...threadParams(options),
      sessionStartSource: "startup"
    });
    const threadId = threadIdFromResult(result);
    this.currentThreadId = threadId;
    this.currentTurnId = undefined;
    return threadId;
  }

  async resumeThread(
    threadId: string,
    options: CodexThreadOptions = { cwd: process.cwd() }
  ): Promise<string> {
    const result = await this.peer.request("thread/resume", {
      threadId,
      ...threadParams(options)
    });
    const resumedThreadId = threadIdFromResult(result);
    this.currentThreadId = resumedThreadId;
    this.currentTurnId = undefined;
    return resumedThreadId;
  }

  async startTurn(request: CodexStartTurnRequest): Promise<void> {
    const result = await this.peer.request("turn/start", {
      ...request,
      approvalsReviewer: "user"
    });
    this.currentThreadId = request.threadId;
    this.currentTurnId = turnIdFromResult(result);
  }

  async interrupt(): Promise<boolean> {
    if (!this.currentThreadId || !this.currentTurnId) {
      return false;
    }
    await this.peer.request("turn/interrupt", {
      threadId: this.currentThreadId,
      turnId: this.currentTurnId
    });
    return true;
  }

  async compact(threadId: string): Promise<void> {
    const completion = this.waitForCompactCompletion(threadId).then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error })
    );
    try {
      await this.peer.request("thread/compact/start", { threadId });
    } catch (error) {
      this.clearCompactWaiter(threadId);
      throw error;
    }
    const result = await completion;
    if (result.status === "rejected") {
      throw result.error;
    }
  }

  onFinalMessage(handler: CodexFinalMessageHandler): void {
    this.finalHandlers.push(handler);
  }

  onTurnCompleted(handler: CodexTurnCompletedHandler): void {
    this.turnCompletedHandlers.push(handler);
  }

  onApprovalRequest(handler: CodexApprovalRequestHandler): void {
    this.approvalHandlers.push(handler);
  }

  async sendApprovalResponse(
    rpcId: CodexRpcId,
    response: Record<string, unknown>
  ): Promise<void> {
    await this.peer.respond(rpcId, response);
  }

  private handleNotification(message: JsonRpcMessage): void {
    const params = asRecord(message.params);
    const threadId = typeof params.threadId === "string" ? params.threadId : "";

    if (!threadId) {
      return;
    }

    if (message.method === "turn/started") {
      const turn = asRecord(params.turn);
      if (typeof turn.id === "string" && turn.id.length > 0) {
        this.currentThreadId = threadId;
        this.currentTurnId = turn.id;
      }
      return;
    }

    if (message.method === "item/completed") {
      const item = asRecord(params.item);
      if (item.type === "contextCompaction") {
        this.resolveCompactWaiter(threadId);
        return;
      }

      if (
        item.type !== "agentMessage" ||
        item.phase !== "final_answer" ||
        typeof item.text !== "string" ||
        item.text.length === 0
      ) {
        return;
      }

      for (const handler of this.finalHandlers) {
        void handler({ threadId, text: item.text });
      }
      return;
    }

    if (message.method === "thread/compacted") {
      // Deprecated in newer codex app-servers, but harmless as a compatibility fallback.
      this.resolveCompactWaiter(threadId);
      return;
    }

    if (message.method === "turn/completed") {
      const turn = asRecord(params.turn);
      const turnId = typeof turn.id === "string" ? turn.id : undefined;
      if (
        threadId === this.currentThreadId &&
        (!turnId || turnId === this.currentTurnId)
      ) {
        this.currentTurnId = undefined;
      }
      for (const handler of this.turnCompletedHandlers) {
        void handler({ threadId });
      }
    }
  }

  private handleServerRequest(message: JsonRpcMessage): void {
    if (!message.method || !APPROVAL_REQUEST_METHODS.has(message.method)) {
      return;
    }

    const request = {
      id: message.id,
      method: message.method,
      params: message.params
    } as Record<string, unknown>;
    for (const handler of this.approvalHandlers) {
      void handler(request);
    }
  }

  private waitForCompactCompletion(threadId: string): Promise<void> {
    if (this.compactWaiters.has(threadId)) {
      throw new Error(`Compaction is already pending for thread ${threadId}`);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.compactWaiters.delete(threadId);
        reject(
          new Error(
            `Timed out waiting for Codex compaction to finish for thread ${threadId}`
          )
        );
      }, COMPACT_TIMEOUT_MS);
      this.compactWaiters.set(threadId, { resolve, reject, timeout });
    });
  }

  private resolveCompactWaiter(threadId: string): void {
    const waiter = this.compactWaiters.get(threadId);
    if (!waiter) {
      return;
    }
    this.compactWaiters.delete(threadId);
    clearTimeout(waiter.timeout);
    waiter.resolve();
  }

  private clearCompactWaiter(threadId: string): void {
    const waiter = this.compactWaiters.get(threadId);
    if (!waiter) {
      return;
    }
    this.compactWaiters.delete(threadId);
    clearTimeout(waiter.timeout);
  }
}

function threadParams(options: CodexThreadOptions): Record<string, unknown> {
  return {
    cwd: options.cwd,
    ...(options.model ? { model: options.model } : {}),
    ...(options.sandbox ? { sandbox: options.sandbox } : {}),
    ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
    approvalsReviewer: "user"
  };
}

function threadIdFromResult(result: unknown): string {
  const resultRecord = asRecord(result);
  const thread = asRecord(resultRecord.thread);
  if (typeof thread.id !== "string" || thread.id.length === 0) {
    throw new Error("Codex app-server response did not include thread.id");
  }
  return thread.id;
}

function turnIdFromResult(result: unknown): string {
  const resultRecord = asRecord(result);
  const turn = asRecord(resultRecord.turn);
  if (typeof turn.id !== "string" || turn.id.length === 0) {
    throw new Error("Codex app-server response did not include turn.id");
  }
  return turn.id;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
