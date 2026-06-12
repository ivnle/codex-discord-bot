import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CodexDiscordBot } from "../../src/bot/runtime.js";
import { AppServerCodexClient } from "../../src/codex/app-server-client.js";
import type {
  CodexApprovalRequestHandler,
  CodexClient,
  CodexFinalMessageHandler,
  CodexStartTurnRequest,
  CodexThreadOptions,
  CodexTurnCompletedHandler
} from "../../src/codex/client.js";
import type { BotConfig } from "../../src/config/types.js";
import type {
  DiscordApprovalChoice,
  DiscordApprovalChoiceHandler,
  DiscordGateway,
  DiscordMessage,
  DiscordMessageHandler,
  DiscordPrompt
} from "../../src/discord/gateway.js";
import { ThreadStateStore } from "../../src/state/thread-state.js";
import { FakeAppServerTransport } from "../fakes/fake-app-server-transport.js";

const createdDirs: string[] = [];

async function tempDataDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-discord-bot-flow-"));
  createdDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

describe("CodexDiscordBot", () => {
  it("starts a new Codex thread on startup and persists the thread id", async () => {
    const dataDir = await tempDataDir();
    const state = new ThreadStateStore(dataDir);
    const discord = new FakeDiscordGateway();
    const codex = new FakeCodexClient();
    const bot = new CodexDiscordBot(configFor(dataDir), discord, codex, state);

    await bot.start("gateway-auth-value");

    expect(discord.startedToken).toBe("gateway-auth-value");
    expect(codex.connectCalls).toBe(1);
    expect(codex.startedThreads).toEqual([
      {
        cwd: "/tmp/project",
        model: "gpt-5.5",
        sandbox: "workspace-write",
        approvalPolicy: "on-request"
      }
    ]);
    await expect(state.readThreadId()).resolves.toBe("thread-1");
  });

  it("resumes a stored thread id instead of starting a new thread", async () => {
    const dataDir = await tempDataDir();
    const state = new ThreadStateStore(dataDir);
    await state.writeThreadId("stored-thread");
    const codex = new FakeCodexClient();

    await new CodexDiscordBot(
      configFor(dataDir),
      new FakeDiscordGateway(),
      codex,
      state
    ).start("gateway-auth-value");

    expect(codex.resumedThreads).toEqual(["stored-thread"]);
    expect(codex.startedThreads).toEqual([]);
  });

  it("starts and persists a new thread when a stored thread cannot be resumed", async () => {
    const dataDir = await tempDataDir();
    const state = new ThreadStateStore(dataDir);
    await state.writeThreadId("stored-thread");
    const discord = new FakeDiscordGateway();
    const transport = new FakeAppServerTransport();
    transport.resumeError = {
      code: -32600,
      message: "no rollout found for thread id stored-thread"
    };
    transport.nextStartedThreadId = "replacement-thread";
    const codex = new AppServerCodexClient(transport);

    await expect(
      new CodexDiscordBot(configFor(dataDir), discord, codex, state).start(
        "gateway-auth-value"
      )
    ).resolves.toBeUndefined();

    expect(transport.sentRequests()).toMatchObject([
      { method: "initialize" },
      {
        method: "thread/resume",
        params: {
          threadId: "stored-thread",
          cwd: "/tmp/project",
          model: "gpt-5.5",
          sandbox: "workspace-write",
          approvalPolicy: "on-request",
          approvalsReviewer: "user"
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
      }
    ]);
    await expect(state.readThreadId()).resolves.toBe("replacement-thread");
    expect(discord.startedToken).toBe("gateway-auth-value");
  });

  it("does not replace a stored thread for unrelated resume failures", async () => {
    const dataDir = await tempDataDir();
    const state = new ThreadStateStore(dataDir);
    await state.writeThreadId("stored-thread");
    const discord = new FakeDiscordGateway();
    const transport = new FakeAppServerTransport();
    transport.resumeError = new Error("transport unavailable");
    const codex = new AppServerCodexClient(transport);

    await expect(
      new CodexDiscordBot(configFor(dataDir), discord, codex, state).start(
        "gateway-auth-value"
      )
    ).rejects.toThrow("transport unavailable");

    expect(
      transport.sentRequests().some((request) => request.method === "thread/start")
    ).toBe(false);
    await expect(state.readThreadId()).resolves.toBe("stored-thread");
    expect(discord.startedToken).toBeUndefined();
  });

  it("sends allowed Discord messages to turn/start and posts the final reply", async () => {
    const dataDir = await tempDataDir();
    const discord = new FakeDiscordGateway();
    const transport = new FakeAppServerTransport();
    const codex = new AppServerCodexClient(transport);
    await new CodexDiscordBot(
      configFor(dataDir),
      discord,
      codex,
      new ThreadStateStore(dataDir)
    ).start("gateway-auth-value");

    await discord.emitMessage(message("message-1", "hello Codex"));

    expect(transport.sentRequests().at(-1)).toMatchObject({
      method: "turn/start",
      params: {
        threadId: "thread-1",
        clientUserMessageId: "message-1",
        input: [{ type: "text", text: "hello Codex", text_elements: [] }],
        cwd: "/tmp/project",
        model: "gpt-5.5",
        approvalPolicy: "on-request",
        approvalsReviewer: "user"
      }
    });

    transport.emitCompletedTurn({
      threadId: "thread-1",
      turnId: "turn-1",
      commentaryText: "commentary should not be posted",
      finalText: "final answer"
    });

    expect(discord.sentMessages).toEqual([
      { channelId: "channel-1", content: "final answer" }
    ]);
  });

  it("queues allowed messages FIFO while a Codex turn is active", async () => {
    const dataDir = await tempDataDir();
    const discord = new FakeDiscordGateway();
    const codex = new FakeCodexClient();
    await new CodexDiscordBot(
      configFor(dataDir),
      discord,
      codex,
      new ThreadStateStore(dataDir)
    ).start("gateway-auth-value");

    await discord.emitMessage(message("message-1", "first"));
    await discord.emitMessage(message("message-2", "second"));

    expect(codex.turns.map((turn) => turn.input[0]?.text)).toEqual(["first"]);

    await codex.emitFinalMessage({ threadId: "thread-1", text: "done first" });

    expect(discord.sentMessages).toEqual([
      { channelId: "channel-1", content: "done first" }
    ]);
    expect(codex.turns.map((turn) => turn.input[0]?.text)).toEqual(["first"]);

    await codex.emitTurnCompleted({ threadId: "thread-1" });

    expect(codex.turns.map((turn) => turn.input[0]?.text)).toEqual([
      "first",
      "second"
    ]);

    await codex.emitFinalMessage({ threadId: "thread-1", text: "done second" });

    expect(discord.sentMessages).toEqual([
      { channelId: "channel-1", content: "done first" },
      { channelId: "channel-1", content: "done second" }
    ]);
  });

  it("does not post a reply for tool-only turns but still drains the queue", async () => {
    const dataDir = await tempDataDir();
    const discord = new FakeDiscordGateway();
    const transport = new FakeAppServerTransport();
    const codex = new AppServerCodexClient(transport);
    await new CodexDiscordBot(
      configFor(dataDir),
      discord,
      codex,
      new ThreadStateStore(dataDir)
    ).start("gateway-auth-value");

    await discord.emitMessage(message("message-1", "run a tool"));
    await discord.emitMessage(message("message-2", "after tool"));

    expect(turnStartTexts(transport)).toEqual(["run a tool"]);

    transport.emitCompletedTurn({
      threadId: "thread-1",
      turnId: "turn-1",
      commentaryText: "tool commentary should not be posted"
    });

    expect(discord.sentMessages).toEqual([]);
    expect(turnStartTexts(transport)).toEqual(["run a tool", "after tool"]);

    transport.emitCompletedTurn({
      threadId: "thread-1",
      turnId: "turn-2",
      finalText: "done second"
    });

    expect(discord.sentMessages).toEqual([
      { channelId: "channel-1", content: "done second" }
    ]);
  });

  it("bridges approval prompts and ignores approval choices from unauthorized users", async () => {
    const dataDir = await tempDataDir();
    const discord = new FakeDiscordGateway();
    const codex = new FakeCodexClient();
    await new CodexDiscordBot(
      configFor(dataDir),
      discord,
      codex,
      new ThreadStateStore(dataDir)
    ).start("gateway-auth-value");

    await discord.emitMessage(message("message-1", "run tests"));
    await codex.emitApprovalRequest(commandApprovalRequest("rpc-1"));

    expect(discord.sentPrompts).toHaveLength(1);
    expect(discord.sentPrompts[0]).toMatchObject({
      channelId: "channel-1",
      approvalId: "string:rpc-1"
    });
    const approvalId = discord.sentPrompts[0]!.approvalId;

    await discord.emitApprovalChoice({
      approvalId,
      choice: "approve",
      userId: "user-2"
    });
    expect(codex.approvalResponses).toEqual([]);

    await discord.emitApprovalChoice({
      approvalId,
      choice: "approve",
      userId: "user-1"
    });
    expect(codex.approvalResponses).toEqual([
      { rpcId: "rpc-1", response: { decision: "accept" } }
    ]);
  });
});

function configFor(dataDir: string): BotConfig {
  return {
    name: "example",
    discordTokenEnv: "DISCORD_BOT_TOKEN",
    codex: {
      command: "codex",
      args: ["app-server", "--stdio"],
      cwd: "/tmp/project",
      model: "gpt-5.5",
      sandbox: "workspace-write",
      approvalPolicy: "on-request"
    },
    access: {
      allowUserIds: ["user-1"],
      channels: ["channel-1"]
    },
    runtime: {
      dataDir,
      logLevel: "info"
    }
  };
}

function message(id: string, content: string): DiscordMessage {
  return {
    id,
    authorId: "user-1",
    channelId: "channel-1",
    isDirectMessage: false,
    content
  };
}

function commandApprovalRequest(id: string): Record<string, unknown> {
  return {
    id,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      startedAtMs: 1000,
      command: "npm test",
      cwd: "/tmp/project",
      reason: "command needs approval"
    }
  };
}

function turnStartTexts(transport: FakeAppServerTransport): string[] {
  return transport
    .sentRequests()
    .filter((request) => request.method === "turn/start")
    .map((request) => {
      const params = asRecord(request.params);
      const input = Array.isArray(params.input) ? params.input : [];
      const firstInput = asRecord(input[0]);
      return typeof firstInput.text === "string" ? firstInput.text : "";
    });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

class FakeDiscordGateway implements DiscordGateway {
  startedToken: string | undefined;
  sentMessages: Array<{ channelId: string; content: string }> = [];
  sentPrompts: Array<{
    channelId: string;
    approvalId: string;
    prompt: DiscordPrompt;
  }> = [];
  private readonly messageHandlers: DiscordMessageHandler[] = [];
  private readonly approvalHandlers: DiscordApprovalChoiceHandler[] = [];

  onMessage(handler: DiscordMessageHandler): void {
    this.messageHandlers.push(handler);
  }

  onApprovalChoice(handler: DiscordApprovalChoiceHandler): void {
    this.approvalHandlers.push(handler);
  }

  async start(token: string): Promise<void> {
    this.startedToken = token;
  }

  async stop(): Promise<void> {}

  async sendMessage(channelId: string, content: string): Promise<void> {
    this.sentMessages.push({ channelId, content });
  }

  async sendApprovalPrompt(
    channelId: string,
    approvalId: string,
    prompt: DiscordPrompt
  ): Promise<void> {
    this.sentPrompts.push({ channelId, approvalId, prompt });
  }

  async emitMessage(messageToEmit: DiscordMessage): Promise<void> {
    for (const handler of this.messageHandlers) {
      await handler(messageToEmit);
    }
  }

  async emitApprovalChoice(choice: DiscordApprovalChoice): Promise<void> {
    for (const handler of this.approvalHandlers) {
      await handler(choice);
    }
  }
}

class FakeCodexClient implements CodexClient {
  connectCalls = 0;
  startedThreads: CodexThreadOptions[] = [];
  resumedThreads: string[] = [];
  turns: CodexStartTurnRequest[] = [];
  approvalResponses: Array<{ rpcId: string; response: Record<string, unknown> }> =
    [];
  private readonly finalHandlers: CodexFinalMessageHandler[] = [];
  private readonly turnCompletedHandlers: CodexTurnCompletedHandler[] = [];
  private readonly approvalHandlers: CodexApprovalRequestHandler[] = [];

  async connect(): Promise<void> {
    this.connectCalls += 1;
  }

  async startThread(options: CodexThreadOptions): Promise<string> {
    this.startedThreads.push(options);
    return "thread-1";
  }

  async resumeThread(threadId: string): Promise<string> {
    this.resumedThreads.push(threadId);
    return threadId;
  }

  async startTurn(request: CodexStartTurnRequest): Promise<void> {
    this.turns.push(request);
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
    rpcId: string,
    response: Record<string, unknown>
  ): Promise<void> {
    this.approvalResponses.push({ rpcId, response });
  }

  async emitFinalMessage(messageToEmit: {
    threadId: string;
    text: string;
  }): Promise<void> {
    for (const handler of this.finalHandlers) {
      await handler(messageToEmit);
    }
  }

  async emitTurnCompleted(messageToEmit: { threadId: string }): Promise<void> {
    for (const handler of this.turnCompletedHandlers) {
      await handler(messageToEmit);
    }
  }

  async emitApprovalRequest(request: Record<string, unknown>): Promise<void> {
    for (const handler of this.approvalHandlers) {
      await handler(request);
    }
  }
}
