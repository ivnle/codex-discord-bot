import { describe, expect, it } from "vitest";

import { AppServerCodexClient } from "../../src/codex/app-server-client.js";
import { FakeAppServerTransport } from "../fakes/fake-app-server-transport.js";

describe("AppServerCodexClient", () => {
  it("initializes app-server, starts/resumes threads, and starts turns", async () => {
    const transport = new FakeAppServerTransport();
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
    await client.interrupt();
    await client.compact(threadId);

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
      },
      {
        method: "turn/interrupt"
      },
      {
        method: "thread/compact",
        params: {
          threadId: "thread-1"
        }
      }
    ]);
  });

  it("emits final assistant text from final_answer item/completed notifications only", async () => {
    const transport = new FakeAppServerTransport();
    const client = new AppServerCodexClient(transport);
    const finals: Array<{ threadId: string; text: string }> = [];
    const completedTurns: Array<{ threadId: string }> = [];
    client.onFinalMessage((message) => {
      finals.push(message);
    });
    client.onTurnCompleted((message) => {
      completedTurns.push(message);
    });
    await client.connect();

    transport.emitCompletedTurn({
      threadId: "thread-1",
      turnId: "turn-1",
      commentaryText: "commentary should not be posted",
      finalText: "final answer"
    });

    expect(finals).toEqual([{ threadId: "thread-1", text: "final answer" }]);
    expect(completedTurns).toEqual([{ threadId: "thread-1" }]);
  });

  it("forwards approval requests and writes app-server responses", async () => {
    const transport = new FakeAppServerTransport();
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
