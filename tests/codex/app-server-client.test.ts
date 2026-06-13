import { afterEach, describe, expect, it, vi } from "vitest";

import { AppServerCodexClient } from "../../src/codex/app-server-client.js";
import { JsonRpcPeer } from "../../src/codex/json-rpc.js";
import { FakeAppServerTransport } from "../fakes/fake-app-server-transport.js";

afterEach(() => {
  vi.useRealTimers();
});

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
    await expect(client.interrupt()).resolves.toBe(true);
    const compactPromise = client.compact(threadId);
    await flushAsyncProtocol();
    transport.emitCompletedCompaction({ threadId });
    await compactPromise;

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
        method: "turn/interrupt",
        params: {
          threadId: "thread-1",
          turnId: "turn-1"
        }
      },
      {
        method: "thread/compact/start",
        params: {
          threadId: "thread-1"
        }
      }
    ]);
  });

  it("waits for a matching contextCompaction item before compact resolves", async () => {
    vi.useFakeTimers();
    const transport = new FakeAppServerTransport();
    const client = new AppServerCodexClient(transport);
    await client.connect();

    const compactPromise = client.compact("thread-1");
    let settled = false;
    void compactPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );

    await flushAsyncProtocol();
    expect(transport.sentRequests().at(-1)).toMatchObject({
      method: "thread/compact/start",
      params: { threadId: "thread-1" }
    });
    expect(settled).toBe(false);

    transport.emitCompletedCompaction({
      threadId: "thread-2",
      turnId: "compact-turn-2"
    });
    await flushAsyncProtocol();
    expect(settled).toBe(false);

    transport.emitCompletedCompaction({ threadId: "thread-1" });
    await flushAsyncProtocol();

    expect(settled).toBe(true);
    await expect(compactPromise).resolves.toBeUndefined();
  });

  it("still resolves compact on deprecated thread/compacted notifications", async () => {
    const transport = new FakeAppServerTransport();
    const client = new AppServerCodexClient(transport);
    await client.connect();

    const compactPromise = client.compact("thread-1");
    await flushAsyncProtocol();

    transport.emit({
      method: "thread/compacted",
      params: { threadId: "thread-1", turnId: "compact-turn-1" }
    });

    await expect(compactPromise).resolves.toBeUndefined();
  });

  it("rejects compact when no matching completion notification arrives", async () => {
    vi.useFakeTimers();
    const transport = new FakeAppServerTransport();
    const client = new AppServerCodexClient(transport);
    await client.connect();

    const compactPromise = client.compact("thread-1");
    const compactResult = compactPromise.then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error })
    );

    await flushAsyncProtocol();
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(compactResult).resolves.toMatchObject({
      status: "rejected",
      error: expect.objectContaining({
        message: "Timed out waiting for Codex compaction to finish for thread thread-1"
      })
    });
  });

  it("does not send interrupt when no turn id is known", async () => {
    const transport = new FakeAppServerTransport();
    const client = new AppServerCodexClient(transport);

    await client.connect();
    await client.startThread({ cwd: "/tmp/project" });

    await expect(client.interrupt()).resolves.toBe(false);
    expect(
      transport
        .sentRequests()
        .filter((request) => request.method === "turn/interrupt")
    ).toEqual([]);
  });

  it(
    "tracks turn ids from turn/started notifications and clears them on turn/completed",
    async () => {
      const transport = new FakeAppServerTransport();
      const client = new AppServerCodexClient(transport);

      await client.connect();
      await client.startThread({ cwd: "/tmp/project" });

      transport.emit({
        method: "turn/started",
        params: {
          threadId: "thread-1",
          turn: {
            id: "turn-from-notification",
            status: "in_progress"
          }
        }
      });

      await expect(client.interrupt()).resolves.toBe(true);
      expect(transport.sentRequests().at(-1)).toMatchObject({
        method: "turn/interrupt",
        params: {
          threadId: "thread-1",
          turnId: "turn-from-notification"
        }
      });

      transport.emit({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: {
            id: "turn-from-notification",
            status: "completed"
          }
        }
      });

      await expect(client.interrupt()).resolves.toBe(false);
      expect(
        transport
          .sentRequests()
          .filter((request) => request.method === "turn/interrupt")
      ).toHaveLength(1);
    }
  );

  it("fake transport rejects malformed interrupt params and bare compact methods", async () => {
    const transport = new FakeAppServerTransport();
    const peer = new JsonRpcPeer(transport);
    await peer.start();

    await expect(peer.request("turn/interrupt")).rejects.toMatchObject({
      code: -32600,
      message: expect.stringContaining("params")
    });
    await expect(
      peer.request("thread/compact", { threadId: "thread-1" })
    ).rejects.toMatchObject({
      code: -32601,
      message: expect.stringContaining("thread/compact")
    });
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

  it("stores latest token usage notifications for the current thread", async () => {
    const transport = new FakeAppServerTransport();
    const client = new AppServerCodexClient(transport);
    await client.connect();
    await client.startThread({ cwd: "/tmp/project" });

    const threadOneUsage = tokenUsage({
      totalTokens: 1_200_000,
      inputTokens: 45_000,
      modelContextWindow: 272_000
    });
    transport.emit({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        tokenUsage: threadOneUsage
      }
    });

    expect(readTokenUsage(client)).toEqual(threadOneUsage);

    const threadTwoUsage = tokenUsage({
      totalTokens: 2_000_000,
      inputTokens: 10_000,
      modelContextWindow: null
    });
    transport.emit({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-2",
        turnId: "turn-1",
        tokenUsage: threadTwoUsage
      }
    });

    expect(readTokenUsage(client)).toEqual(threadOneUsage);

    await client.resumeThread("thread-2", { cwd: "/tmp/project" });

    expect(readTokenUsage(client)).toEqual(threadTwoUsage);
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

async function flushAsyncProtocol(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

function readTokenUsage(client: AppServerCodexClient): unknown {
  return (client as unknown as { getTokenUsage: () => unknown }).getTokenUsage();
}

function tokenUsage({
  totalTokens,
  inputTokens,
  modelContextWindow
}: {
  totalTokens: number;
  inputTokens: number;
  modelContextWindow: number | null;
}): {
  total: TokenUsageBreakdownForTest;
  last: TokenUsageBreakdownForTest;
  modelContextWindow: number | null;
} {
  return {
    total: tokenBreakdown({ totalTokens }),
    last: tokenBreakdown({ inputTokens }),
    modelContextWindow
  };
}

type TokenUsageBreakdownForTest = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

function tokenBreakdown(
  overrides: Partial<TokenUsageBreakdownForTest>
): TokenUsageBreakdownForTest {
  return {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    ...overrides
  };
}
