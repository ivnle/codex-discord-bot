import type {
  CodexApprovalRequestHandler,
  CodexClient,
  CodexFinalMessageHandler,
  CodexRpcId,
  CodexStartTurnRequest,
  CodexThreadOptions
} from "./client.js";
import { JsonRpcPeer, type JsonRpcMessage, type JsonRpcTransport } from "./json-rpc.js";

const APPROVAL_REQUEST_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "execCommandApproval",
  "applyPatchApproval"
]);

export class AppServerCodexClient implements CodexClient {
  private readonly peer: JsonRpcPeer;
  private readonly finalHandlers: CodexFinalMessageHandler[] = [];
  private readonly approvalHandlers: CodexApprovalRequestHandler[] = [];

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
    return threadIdFromResult(result);
  }

  async resumeThread(
    threadId: string,
    options: CodexThreadOptions = { cwd: process.cwd() }
  ): Promise<string> {
    const result = await this.peer.request("thread/resume", {
      threadId,
      ...threadParams(options)
    });
    return threadIdFromResult(result);
  }

  async startTurn(request: CodexStartTurnRequest): Promise<void> {
    await this.peer.request("turn/start", {
      ...request,
      approvalsReviewer: "user"
    });
  }

  onFinalMessage(handler: CodexFinalMessageHandler): void {
    this.finalHandlers.push(handler);
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
    if (message.method !== "turn/completed") {
      return;
    }
    const params = asRecord(message.params);
    const threadId = typeof params.threadId === "string" ? params.threadId : "";
    const turn = asRecord(params.turn);
    const items = Array.isArray(turn.items) ? turn.items : [];
    const finalAgentMessage = [...items]
      .reverse()
      .map((item) => asRecord(item))
      .find((item) => item.type === "agentMessage" && typeof item.text === "string");

    if (!threadId || !finalAgentMessage) {
      return;
    }

    for (const handler of this.finalHandlers) {
      void handler({ threadId, text: finalAgentMessage.text as string });
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

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
