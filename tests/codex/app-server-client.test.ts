import { describe, expect, it } from "vitest";

import { AppServerCodexClient } from "../../src/codex/app-server-client.js";
import type {
  JsonRpcMessage,
  JsonRpcTransport
} from "../../src/codex/json-rpc.js";

describe("AppServerCodexClient", () => {
  it("initializes app-server, starts/resumes threads, and starts turns", async () => {
    const transport = new FakeJsonRpcTransport();
    const client = new AppServerCodexClient(transport);

    await client.connect();
    const threadId = await client.startThread({
      cwd: "/tmp/project",
      model: "gpt-5.5",
      sandbox: "workspace-write",
      approvalPolicy: "on-request"
    });
    await client.resumeThread("stored-thread", {
      cwd: "/tmp/project",
      model: "gpt-5.5"
    });
    await client.startTurn({
      threadId,
      clientUserMessageId: "message-1",
      input: [{ type: "text", text: "hello", text_elements: [] }],
      cwd: "/tmp/project",
      model: "gpt-5.5",
      approvalPolicy: "on-request"
    });

    expect(transport.started).toBe(true);
    expect(transport.sentRequests()).toMatchObject([
      {
        method: "initialize",
        params: {
          clientInfo: {
            name: "codex-discord-bot"
          },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false
          }
        }
      },
      {
        method: "thread/start",
        params: {
          cwd: "/tmp/project",
          model: "gpt-5.5",
          sandbox: "workspace-write",
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sessionStartSource: "startup"
        }
      },
      {
        method: "thread/resume",
        params: {
          threadId: "stored-thread",
          cwd: "/tmp/project",
          model: "gpt-5.5",
          approvalsReviewer: "user"
        }
      },
      {
        method: "turn/start",
        params: {
          threadId: "thread-1",
          clientUserMessageId: "message-1",
          input: [{ type: "text", text: "hello", text_elements: [] }],
          cwd: "/tmp/project",
          model: "gpt-5.5",
          approvalPolicy: "on-request",
          approvalsReviewer: "user"
        }
      }
    ]);
  });

  it("emits final assistant text from turn/completed notifications", async () => {
    const transport = new FakeJsonRpcTransport();
    const client = new AppServerCodexClient(transport);
    const finals: Array<{ threadId: string; text: string }> = [];
    client.onFinalMessage((message) => {
      finals.push(message);
    });
    await client.connect();

    transport.emit({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: {
          items: [
            { type: "userMessage", id: "user-1", clientId: null, content: [] },
            {
              type: "agentMessage",
              id: "agent-1",
              text: "final answer",
              phase: null,
              memoryCitation: null
            }
          ]
        }
      }
    });

    expect(finals).toEqual([{ threadId: "thread-1", text: "final answer" }]);
  });

  it("forwards approval requests and writes app-server responses", async () => {
    const transport = new FakeJsonRpcTransport();
    const client = new AppServerCodexClient(transport);
    const approvals: Record<string, unknown>[] = [];
    client.onApprovalRequest((request) => {
      approvals.push(request);
    });
    await client.connect();

    transport.emit({
      id: "approval-rpc-1",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        startedAtMs: 1000,
        command: "npm test"
      }
    });
    await client.sendApprovalResponse("approval-rpc-1", { decision: "accept" });

    expect(approvals).toEqual([
      {
        id: "approval-rpc-1",
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          startedAtMs: 1000,
          command: "npm test"
        }
      }
    ]);
    expect(transport.sent.at(-1)).toEqual({
      id: "approval-rpc-1",
      result: { decision: "accept" }
    });
  });
});

class FakeJsonRpcTransport implements JsonRpcTransport {
  started = false;
  sent: JsonRpcMessage[] = [];
  private handler: ((message: JsonRpcMessage) => void) | undefined;

  onMessage(handler: (message: JsonRpcMessage) => void): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {}

  async send(message: JsonRpcMessage): Promise<void> {
    this.sent.push(message);
    if ("id" in message && "method" in message) {
      queueMicrotask(() => this.respondTo(message));
    }
  }

  emit(message: JsonRpcMessage): void {
    this.handler?.(message);
  }

  sentRequests(): JsonRpcMessage[] {
    return this.sent.filter((message) => "method" in message);
  }

  private respondTo(message: JsonRpcMessage): void {
    if (!("method" in message)) {
      return;
    }
    if (message.method === "thread/start") {
      this.emit({
        id: message.id,
        result: { thread: { id: "thread-1" } }
      });
      return;
    }
    if (message.method === "thread/resume") {
      this.emit({
        id: message.id,
        result: { thread: { id: "stored-thread" } }
      });
      return;
    }
    this.emit({ id: message.id, result: {} });
  }
}
