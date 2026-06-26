import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

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
  DiscordAttachment,
  DiscordGateway,
  DiscordMessage,
  DiscordMessageHandler,
  DiscordPrompt
} from "../../src/discord/gateway.js";
import { ThreadStateStore } from "../../src/state/thread-state.js";
import type { Transcriber } from "../../src/transcription/transcriber.js";
import { FakeAppServerTransport } from "../fakes/fake-app-server-transport.js";

const createdDirs: string[] = [];

type TestTokenUsageBreakdown = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

type TestThreadTokenUsage = {
  total: TestTokenUsageBreakdown;
  last: TestTokenUsageBreakdown;
  modelContextWindow: number | null;
};

async function tempDataDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-discord-bot-flow-"));
  createdDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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

  it("sends typing immediately and refreshes while a turn is active", async () => {
    vi.useFakeTimers();
    const dataDir = await tempDataDir();
    const discord = new FakeDiscordGateway();
    const codex = new FakeCodexClient();
    const bot = new CodexDiscordBot(
      configFor(dataDir),
      discord,
      codex,
      new ThreadStateStore(dataDir)
    );
    await bot.start("gateway-auth-value");

    await discord.emitMessage(message("message-1", "hello Codex"));

    expect(discord.typingCalls).toEqual([{ channelId: "channel-1" }]);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(8000);
    expect(discord.typingCalls).toEqual([
      { channelId: "channel-1" },
      { channelId: "channel-1" }
    ]);

    await vi.advanceTimersByTimeAsync(16000);
    expect(discord.typingCalls).toEqual([
      { channelId: "channel-1" },
      { channelId: "channel-1" },
      { channelId: "channel-1" },
      { channelId: "channel-1" }
    ]);

    await bot.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops typing after the final reply is posted", async () => {
    vi.useFakeTimers();
    const dataDir = await tempDataDir();
    const discord = new FakeDiscordGateway();
    const codex = new FakeCodexClient();
    await new CodexDiscordBot(
      configFor(dataDir),
      discord,
      codex,
      new ThreadStateStore(dataDir)
    ).start("gateway-auth-value");

    await discord.emitMessage(message("message-1", "hello Codex"));
    expect(vi.getTimerCount()).toBe(1);

    await codex.emitFinalMessage({ threadId: "thread-1", text: "final answer" });

    expect(discord.sentMessages).toEqual([
      { channelId: "channel-1", content: "final answer" }
    ]);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(24000);
    expect(discord.typingCalls).toEqual([{ channelId: "channel-1" }]);
  });

  it("stops typing for a tool-only completed turn", async () => {
    vi.useFakeTimers();
    const dataDir = await tempDataDir();
    const discord = new FakeDiscordGateway();
    const codex = new FakeCodexClient();
    await new CodexDiscordBot(
      configFor(dataDir),
      discord,
      codex,
      new ThreadStateStore(dataDir)
    ).start("gateway-auth-value");

    await discord.emitMessage(message("message-1", "run a tool"));
    expect(vi.getTimerCount()).toBe(1);

    await codex.emitTurnCompleted({ threadId: "thread-1" });

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(24000);
    expect(discord.typingCalls).toEqual([{ channelId: "channel-1" }]);
  });

  it("restarts typing for the next queued turn without overlapping timers", async () => {
    vi.useFakeTimers();
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
    expect(discord.typingCalls).toEqual([{ channelId: "channel-1" }]);
    expect(vi.getTimerCount()).toBe(1);

    await codex.emitTurnCompleted({ threadId: "thread-1" });

    expect(codex.turns.map((turn) => turn.input[0]?.text)).toEqual([
      "first",
      "second"
    ]);
    expect(discord.typingCalls).toEqual([
      { channelId: "channel-1" },
      { channelId: "channel-1" }
    ]);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("clears the typing interval when the bot stops", async () => {
    vi.useFakeTimers();
    const dataDir = await tempDataDir();
    const discord = new FakeDiscordGateway();
    const codex = new FakeCodexClient();
    const bot = new CodexDiscordBot(
      configFor(dataDir),
      discord,
      codex,
      new ThreadStateStore(dataDir)
    );
    await bot.start("gateway-auth-value");

    await discord.emitMessage(message("message-1", "hello Codex"));
    expect(vi.getTimerCount()).toBe(1);

    await bot.stop();

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(24000);
    expect(discord.typingCalls).toEqual([{ channelId: "channel-1" }]);
  });

  it("keeps the turn running when sending typing fails", async () => {
    const dataDir = await tempDataDir();
    const discord = new FakeDiscordGateway();
    discord.typingError = new Error("typing unavailable");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const codex = new FakeCodexClient();
    await new CodexDiscordBot(
      configFor(dataDir),
      discord,
      codex,
      new ThreadStateStore(dataDir)
    ).start("gateway-auth-value");

    await discord.emitMessage(message("message-1", "hello Codex"));
    await Promise.resolve();

    expect(codex.turns.map((turn) => turn.input[0]?.text)).toEqual([
      "hello Codex"
    ]);
    expect(consoleError).toHaveBeenCalled();

    await codex.emitFinalMessage({ threadId: "thread-1", text: "final answer" });

    expect(discord.sentMessages).toEqual([
      { channelId: "channel-1", content: "final answer" }
    ]);
  });

  it("starts a Codex turn with transcript text for an audio-only voice note", async () => {
    const dataDir = await tempDataDir();
    const discord = new FakeDiscordGateway();
    const codex = new FakeCodexClient();
    const transcriber = new FakeTranscriber({
      "https://cdn.example.test/voice.ogg": "hello world"
    });
    await new CodexDiscordBot(
      configFor(dataDir, { transcription: enabledTranscription() }),
      discord,
      codex,
      new ThreadStateStore(dataDir),
      transcriber
    ).start("gateway-auth-value");

    await discord.emitMessage(
      message("message-1", "", [
        attachment("https://cdn.example.test/voice.ogg", "audio/ogg")
      ])
    );

    expect(transcriber.calls).toEqual(["https://cdn.example.test/voice.ogg"]);
    expect(codex.turns.map((turn) => turn.input[0]?.text)).toEqual([
      "hello world"
    ]);
  });

  it("combines typed text and audio transcript", async () => {
    const dataDir = await tempDataDir();
    const discord = new FakeDiscordGateway();
    const codex = new FakeCodexClient();
    const transcriber = new FakeTranscriber({
      "https://cdn.example.test/voice.ogg": "transcribed voice"
    });
    await new CodexDiscordBot(
      configFor(dataDir, { transcription: enabledTranscription() }),
      discord,
      codex,
      new ThreadStateStore(dataDir),
      transcriber
    ).start("gateway-auth-value");

    await discord.emitMessage(
      message("message-1", "typed text", [
        attachment("https://cdn.example.test/voice.ogg", "audio/ogg")
      ])
    );

    expect(codex.turns.map((turn) => turn.input[0]?.text)).toEqual([
      "typed text\ntranscribed voice"
    ]);
  });

  it("drops a voice-only message when transcription fails", async () => {
    const dataDir = await tempDataDir();
    const discord = new FakeDiscordGateway();
    const codex = new FakeCodexClient();
    const transcriber = new FakeTranscriber({
      "https://cdn.example.test/voice.ogg": null
    });
    await new CodexDiscordBot(
      configFor(dataDir, { transcription: enabledTranscription() }),
      discord,
      codex,
      new ThreadStateStore(dataDir),
      transcriber
    ).start("gateway-auth-value");

    await discord.emitMessage(
      message("message-1", "", [
        attachment("https://cdn.example.test/voice.ogg", "audio/ogg")
      ])
    );

    expect(transcriber.calls).toEqual(["https://cdn.example.test/voice.ogg"]);
    expect(codex.turns).toEqual([]);
  });

  it("ignores non-audio attachments and treats the message as plain text", async () => {
    const dataDir = await tempDataDir();
    const discord = new FakeDiscordGateway();
    const codex = new FakeCodexClient();
    const transcriber = new FakeTranscriber({});
    await new CodexDiscordBot(
      configFor(dataDir, { transcription: enabledTranscription() }),
      discord,
      codex,
      new ThreadStateStore(dataDir),
      transcriber
    ).start("gateway-auth-value");

    await discord.emitMessage(
      message("message-1", "look at this", [
        attachment("https://cdn.example.test/image.png", "image/png")
      ])
    );

    expect(transcriber.calls).toEqual([]);
    expect(codex.turns.map((turn) => turn.input[0]?.text)).toEqual([
      "look at this"
    ]);
  });

  it("ignores audio attachments when transcription is disabled", async () => {
    const dataDir = await tempDataDir();
    const discord = new FakeDiscordGateway();
    const codex = new FakeCodexClient();
    const transcriber = new FakeTranscriber({
      "https://cdn.example.test/voice.ogg": "ignored transcript"
    });
    await new CodexDiscordBot(
      configFor(dataDir),
      discord,
      codex,
      new ThreadStateStore(dataDir),
      transcriber
    ).start("gateway-auth-value");

    await discord.emitMessage(
      message("message-1", "", [
        attachment("https://cdn.example.test/voice.ogg", "audio/ogg")
      ])
    );

    expect(transcriber.calls).toEqual([]);
    expect(codex.turns).toEqual([]);
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

  it("stops an active turn immediately without queuing or sending the command to Codex", async () => {
    vi.useFakeTimers();
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
    await discord.emitMessage(message("message-3", "!STOP"));

    expect(codex.interruptCalls).toBe(1);
    expect(codex.turns.map((turn) => turn.input[0]?.text)).toEqual(["first"]);
    expect(discord.sentMessages).toEqual([
      { channelId: "channel-1", content: "Stopped the current turn." }
    ]);
    expect(vi.getTimerCount()).toBe(0);

    await codex.emitTurnCompleted({ threadId: "thread-1" });

    expect(codex.turns.map((turn) => turn.input[0]?.text)).toEqual(["first"]);
  });

  it("sends app-server interrupt params for stop and clears queued work", async () => {
    vi.useFakeTimers();
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

    await discord.emitMessage(message("message-1", "first"));
    await discord.emitMessage(message("message-2", "second"));
    await discord.emitMessage(message("message-3", "!stop"));

    expect(
      transport
        .sentRequests()
        .filter((request) => request.method === "turn/interrupt")
    ).toMatchObject([
      {
        method: "turn/interrupt",
        params: {
          threadId: "thread-1",
          turnId: "turn-1"
        }
      }
    ]);
    expect(discord.sentMessages).toEqual([
      { channelId: "channel-1", content: "Stopped the current turn." }
    ]);
    expect(vi.getTimerCount()).toBe(0);

    transport.emitCompletedTurn({ threadId: "thread-1", turnId: "turn-1" });

    expect(turnStartTexts(transport)).toEqual(["first"]);
  });

  it("keeps the active turn and queue when stop runs before Codex has a turn id", async () => {
    vi.useFakeTimers();
    const dataDir = await tempDataDir();
    const discord = new FakeDiscordGateway();
    const codex = new FakeCodexClient();
    codex.interruptResult = false;
    await new CodexDiscordBot(
      configFor(dataDir),
      discord,
      codex,
      new ThreadStateStore(dataDir)
    ).start("gateway-auth-value");

    await discord.emitMessage(message("message-1", "first"));
    await discord.emitMessage(message("message-2", "second"));
    await discord.emitMessage(message("message-3", "!stop"));

    expect(codex.interruptCalls).toBe(1);
    expect(codex.turns.map((turn) => turn.input[0]?.text)).toEqual(["first"]);
    expect(discord.sentMessages).toEqual([
      {
        channelId: "channel-1",
        content: "The turn is still starting up - try !stop again in a moment."
      }
    ]);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await codex.emitTurnCompleted({ threadId: "thread-1" });

    expect(codex.turns.map((turn) => turn.input[0]?.text)).toEqual([
      "first",
      "second"
    ]);
  });

  it("reports that nothing is running when stop is requested with no active turn", async () => {
    const dataDir = await tempDataDir();
    const discord = new FakeDiscordGateway();
    const codex = new FakeCodexClient();
    await new CodexDiscordBot(
      configFor(dataDir),
      discord,
      codex,
      new ThreadStateStore(dataDir)
    ).start("gateway-auth-value");

    await discord.emitMessage(message("message-1", "!cancel"));

    expect(codex.interruptCalls).toBe(0);
    expect(codex.turns).toEqual([]);
    expect(discord.sentMessages).toEqual([
      { channelId: "channel-1", content: "Nothing is running." }
    ]);
  });

  it("compacts the current thread without starting a Codex turn", async () => {
    const dataDir = await tempDataDir();
    const discord = new FakeDiscordGateway();
    const codex = new FakeCodexClient();
    await new CodexDiscordBot(
      configFor(dataDir),
      discord,
      codex,
      new ThreadStateStore(dataDir)
    ).start("gateway-auth-value");

    await discord.emitMessage(message("message-1", "!compact"));

    expect(codex.compactedThreadIds).toEqual(["thread-1"]);
    expect(codex.turns).toEqual([]);
    expect(discord.sentMessages).toEqual([
      { channelId: "channel-1", content: "Compacted the conversation." }
    ]);
  });

  it("posts compact success only after the app-server completion notification", async () => {
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

    const compactCommand = discord.emitMessage(message("message-1", "!compact"));
    await flushAsyncProtocol();

    expect(transport.sentRequests().at(-1)).toMatchObject({
      method: "thread/compact/start",
      params: { threadId: "thread-1" }
    });
    expect(discord.sentMessages).toEqual([]);

    transport.emitCompletedCompaction({ threadId: "thread-1" });

    await compactCommand;
    expect(discord.sentMessages).toEqual([
      { channelId: "channel-1", content: "Compacted the conversation." }
    ]);
  });

  it("reports compact timeout without posting success", async () => {
    vi.useFakeTimers();
    const dataDir = await tempDataDir();
    const discord = new FakeDiscordGateway();
    const transport = new FakeAppServerTransport();
    const codex = new AppServerCodexClient(transport);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await new CodexDiscordBot(
      configFor(dataDir),
      discord,
      codex,
      new ThreadStateStore(dataDir)
    ).start("gateway-auth-value");

    const compactCommand = discord.emitMessage(message("message-1", "!compact"));
    await flushAsyncProtocol();

    expect(discord.sentMessages).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    await compactCommand;

    expect(consoleError).toHaveBeenCalled();
    expect(discord.sentMessages).toEqual([
      {
        channelId: "channel-1",
        content:
          "Couldn't compact the conversation: Timed out waiting for Codex compaction to finish for thread thread-1"
      }
    ]);
  });

  it("asks the operator to stop before compacting an active turn", async () => {
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
    await discord.emitMessage(message("message-2", "!compact"));

    expect(codex.compactedThreadIds).toEqual([]);
    expect(codex.turns.map((turn) => turn.input[0]?.text)).toEqual(["first"]);
    expect(discord.sentMessages).toEqual([
      {
        channelId: "channel-1",
        content: "A turn is running. Send !stop before !compact."
      }
    ]);
  });

  it("starts and persists a fresh thread on reset while clearing active state and queue", async () => {
    vi.useFakeTimers();
    const dataDir = await tempDataDir();
    const discord = new FakeDiscordGateway();
    const codex = new FakeCodexClient();
    codex.nextThreadIds = ["thread-1", "thread-2"];
    const state = new ThreadStateStore(dataDir);
    await new CodexDiscordBot(configFor(dataDir), discord, codex, state).start(
      "gateway-auth-value"
    );

    await discord.emitMessage(message("message-1", "first"));
    await discord.emitMessage(message("message-2", "second"));
    await discord.emitMessage(message("message-3", "!new"));

    expect(codex.startedThreads).toHaveLength(2);
    await expect(state.readThreadId()).resolves.toBe("thread-2");
    expect(discord.sentMessages).toEqual([
      {
        channelId: "channel-1",
        content: "Started a fresh thread (history cleared)."
      }
    ]);
    expect(vi.getTimerCount()).toBe(0);

    await codex.emitTurnCompleted({ threadId: "thread-1" });

    expect(codex.turns.map((turn) => turn.input[0]?.text)).toEqual(["first"]);
  });

  it("posts help locally without starting a Codex turn", async () => {
    const dataDir = await tempDataDir();
    const discord = new FakeDiscordGateway();
    const codex = new FakeCodexClient();
    await new CodexDiscordBot(
      configFor(dataDir),
      discord,
      codex,
      new ThreadStateStore(dataDir)
    ).start("gateway-auth-value");

    await discord.emitMessage(message("message-1", "!help"));

    expect(codex.turns).toEqual([]);
    expect(discord.sentMessages).toEqual([
      {
        channelId: "channel-1",
        content:
          "**Commands**\n" +
          "`!stop` / `!cancel` — interrupt the current turn\n" +
          "`!compact` — compact the conversation (frees up context)\n" +
          "`!reset` / `!new` — start a fresh thread (clears history)\n" +
          "`!context` — show context-window usage\n" +
          "`!model` — show the model and reasoning effort in use\n" +
          "`!status` — show whether a turn is running and its progress\n" +
          "`!help` — show this help"
      }
    ]);
  });

  it("lists every control command in help", async () => {
    const dataDir = await tempDataDir();
    const discord = new FakeDiscordGateway();
    const codex = new FakeCodexClient();
    await new CodexDiscordBot(
      configFor(dataDir),
      discord,
      codex,
      new ThreadStateStore(dataDir)
    ).start("gateway-auth-value");

    await discord.emitMessage(message("message-1", "!help"));

    const help = discord.sentMessages[0]?.content ?? "";
    expect(help).toContain("!stop");
    expect(help).toContain("!cancel");
    expect(help).toContain("!compact");
    expect(help).toContain("!reset");
    expect(help).toContain("!new");
    expect(help).toContain("!context");
    expect(help).toContain("!help");
  });

  it("posts context usage locally during an active turn without starting another turn", async () => {
    const dataDir = await tempDataDir();
    const discord = new FakeDiscordGateway();
    const codex = new FakeCodexClient();
    codex.tokenUsage = tokenUsage({
      totalTokens: 1_200_000,
      inputTokens: 45_000,
      modelContextWindow: 272_000
    });
    await new CodexDiscordBot(
      configFor(dataDir),
      discord,
      codex,
      new ThreadStateStore(dataDir)
    ).start("gateway-auth-value");

    await discord.emitMessage(message("message-1", "first"));
    await discord.emitMessage(message("message-2", "!context"));

    expect(codex.turns.map((turn) => turn.input[0]?.text)).toEqual(["first"]);
    expect(discord.sentMessages).toEqual([
      {
        channelId: "channel-1",
        content:
          "Context: ~45K / 272K (17% of window)\nSession total: 1.2M tokens"
      }
    ]);
  });

  it("posts context usage after an app-server token usage notification", async () => {
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

    transport.emit({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        tokenUsage: tokenUsage({
          totalTokens: 1_200_000,
          inputTokens: 45_000,
          modelContextWindow: 272_000
        })
      }
    });
    await discord.emitMessage(message("message-1", "!context"));

    expect(turnStartTexts(transport)).toEqual([]);
    expect(discord.sentMessages).toEqual([
      {
        channelId: "channel-1",
        content:
          "Context: ~45K / 272K (17% of window)\nSession total: 1.2M tokens"
      }
    ]);
  });

  it("reports when no context usage data has been received yet without starting a turn", async () => {
    const dataDir = await tempDataDir();
    const discord = new FakeDiscordGateway();
    const codex = new FakeCodexClient();
    await new CodexDiscordBot(
      configFor(dataDir),
      discord,
      codex,
      new ThreadStateStore(dataDir)
    ).start("gateway-auth-value");

    await discord.emitMessage(message("message-1", "!context"));

    expect(codex.turns).toEqual([]);
    expect(discord.sentMessages).toEqual([
      {
        channelId: "channel-1",
        content: "No usage data yet — send a message first."
      }
    ]);
  });

  it("posts context usage without a window denominator when the window is unknown", async () => {
    const dataDir = await tempDataDir();
    const discord = new FakeDiscordGateway();
    const codex = new FakeCodexClient();
    codex.tokenUsage = tokenUsage({
      totalTokens: 1_200_000,
      inputTokens: 45_000,
      modelContextWindow: null
    });
    await new CodexDiscordBot(
      configFor(dataDir),
      discord,
      codex,
      new ThreadStateStore(dataDir)
    ).start("gateway-auth-value");

    await discord.emitMessage(message("message-1", "!context"));

    expect(codex.turns).toEqual([]);
    expect(discord.sentMessages).toEqual([
      {
        channelId: "channel-1",
        content:
          "Context: ~45K used (window size unknown)\nSession total: 1.2M tokens"
      }
    ]);
  });

  it("ignores control commands from messages that fail access control", async () => {
    const dataDir = await tempDataDir();
    const discord = new FakeDiscordGateway();
    const codex = new FakeCodexClient();
    await new CodexDiscordBot(
      configFor(dataDir),
      discord,
      codex,
      new ThreadStateStore(dataDir)
    ).start("gateway-auth-value");

    await discord.emitMessage({
      ...message("message-1", "!compact"),
      authorId: "user-2"
    });

    expect(codex.compactedThreadIds).toEqual([]);
    expect(codex.turns).toEqual([]);
    expect(discord.sentMessages).toEqual([]);
  });

  it("treats command text embedded in a sentence as normal input", async () => {
    const dataDir = await tempDataDir();
    const discord = new FakeDiscordGateway();
    const codex = new FakeCodexClient();
    await new CodexDiscordBot(
      configFor(dataDir),
      discord,
      codex,
      new ThreadStateStore(dataDir)
    ).start("gateway-auth-value");

    await discord.emitMessage(message("message-1", "please !stop now"));

    expect(codex.turns.map((turn) => turn.input[0]?.text)).toEqual([
      "please !stop now"
    ]);
    expect(codex.interruptCalls).toBe(0);
  });

  it("reports interrupt failures without crashing", async () => {
    const dataDir = await tempDataDir();
    const discord = new FakeDiscordGateway();
    const codex = new FakeCodexClient();
    codex.interruptError = new Error("interrupt unavailable");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await new CodexDiscordBot(
      configFor(dataDir),
      discord,
      codex,
      new ThreadStateStore(dataDir)
    ).start("gateway-auth-value");

    await discord.emitMessage(message("message-1", "first"));

    await expect(
      discord.emitMessage(message("message-2", "!stop"))
    ).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalled();
    expect(discord.sentMessages).toEqual([
      {
        channelId: "channel-1",
        content: "Couldn't stop the turn: interrupt unavailable"
      }
    ]);
  });

  it("reports compact failures without crashing", async () => {
    const dataDir = await tempDataDir();
    const discord = new FakeDiscordGateway();
    const codex = new FakeCodexClient();
    codex.compactError = new Error("compact unavailable");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await new CodexDiscordBot(
      configFor(dataDir),
      discord,
      codex,
      new ThreadStateStore(dataDir)
    ).start("gateway-auth-value");

    await expect(
      discord.emitMessage(message("message-1", "!compact"))
    ).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalled();
    expect(discord.sentMessages).toEqual([
      {
        channelId: "channel-1",
        content: "Couldn't compact the conversation: compact unavailable"
      }
    ]);
  });

  it("reports reset failures without crashing", async () => {
    const dataDir = await tempDataDir();
    const discord = new FakeDiscordGateway();
    const codex = new FakeCodexClient();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await new CodexDiscordBot(
      configFor(dataDir),
      discord,
      codex,
      new ThreadStateStore(dataDir)
    ).start("gateway-auth-value");
    codex.startThreadError = new Error("start unavailable");

    await expect(
      discord.emitMessage(message("message-1", "!reset"))
    ).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalled();
    expect(discord.sentMessages).toEqual([
      {
        channelId: "channel-1",
        content: "Couldn't reset the conversation: start unavailable"
      }
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

function configFor(
  dataDir: string,
  options: { transcription?: BotConfig["transcription"] } = {}
): BotConfig {
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
    },
    transcription: options.transcription ?? {
      enabled: false,
      binary: "transcribe"
    }
  };
}

function enabledTranscription(): BotConfig["transcription"] {
  return {
    enabled: true,
    binary: "fake-transcribe"
  };
}

function attachment(url: string, contentType: string): DiscordAttachment {
  return {
    url,
    contentType
  };
}

function message(
  id: string,
  content: string,
  attachments: DiscordAttachment[] = []
): DiscordMessage {
  return {
    id,
    authorId: "user-1",
    channelId: "channel-1",
    isDirectMessage: false,
    content,
    attachments
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

function tokenUsage({
  totalTokens,
  inputTokens,
  modelContextWindow
}: {
  totalTokens: number;
  inputTokens: number;
  modelContextWindow: number | null;
}): TestThreadTokenUsage {
  return {
    total: tokenBreakdown({ totalTokens }),
    last: tokenBreakdown({ inputTokens }),
    modelContextWindow
  };
}

function tokenBreakdown(
  overrides: Partial<TestTokenUsageBreakdown>
): TestTokenUsageBreakdown {
  return {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    ...overrides
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

async function flushAsyncProtocol(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

class FakeDiscordGateway implements DiscordGateway {
  startedToken: string | undefined;
  sentMessages: Array<{ channelId: string; content: string }> = [];
  typingCalls: Array<{ channelId: string }> = [];
  typingError: Error | undefined;
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

  async sendTyping(channelId: string): Promise<void> {
    this.typingCalls.push({ channelId });
    if (this.typingError) {
      throw this.typingError;
    }
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

class FakeTranscriber implements Transcriber {
  readonly calls: string[] = [];

  constructor(private readonly transcriptsByUrl: Record<string, string | null>) {}

  async transcribe(audioUrl: string): Promise<string | null> {
    this.calls.push(audioUrl);
    return this.transcriptsByUrl[audioUrl] ?? null;
  }
}

class FakeCodexClient implements CodexClient {
  connectCalls = 0;
  startedThreads: CodexThreadOptions[] = [];
  startThreadError: Error | undefined;
  nextThreadIds = ["thread-1"];
  resumedThreads: string[] = [];
  turns: CodexStartTurnRequest[] = [];
  interruptCalls = 0;
  interruptResult = true;
  interruptError: Error | undefined;
  compactedThreadIds: string[] = [];
  compactError: Error | undefined;
  tokenUsage: TestThreadTokenUsage | undefined;
  approvalResponses: Array<{ rpcId: string; response: Record<string, unknown> }> =
    [];
  private readonly finalHandlers: CodexFinalMessageHandler[] = [];
  private readonly turnCompletedHandlers: CodexTurnCompletedHandler[] = [];
  private readonly approvalHandlers: CodexApprovalRequestHandler[] = [];

  async connect(): Promise<void> {
    this.connectCalls += 1;
  }

  async startThread(options: CodexThreadOptions): Promise<string> {
    if (this.startThreadError) {
      throw this.startThreadError;
    }
    this.startedThreads.push(options);
    return this.nextThreadIds.shift() ?? `thread-${this.startedThreads.length}`;
  }

  async resumeThread(threadId: string): Promise<string> {
    this.resumedThreads.push(threadId);
    return threadId;
  }

  async startTurn(request: CodexStartTurnRequest): Promise<void> {
    this.turns.push(request);
  }

  async interrupt(): Promise<boolean> {
    this.interruptCalls += 1;
    if (this.interruptError) {
      throw this.interruptError;
    }
    return this.interruptResult;
  }

  async compact(threadId: string): Promise<void> {
    if (this.compactError) {
      throw this.compactError;
    }
    this.compactedThreadIds.push(threadId);
  }

  getTokenUsage(): TestThreadTokenUsage | undefined {
    return this.tokenUsage;
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
