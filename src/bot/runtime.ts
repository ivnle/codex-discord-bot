import { isMessageAllowed } from "../access/access-control.js";
import {
  mapApprovalChoice,
  mapServerRequestToApproval,
  renderApprovalPrompt,
  type ApprovalRequest
} from "../approvals/approval-bridge.js";
import type { CodexClient, CodexThreadOptions } from "../codex/client.js";
import type { BotConfig } from "../config/types.js";
import type {
  DiscordApprovalChoice,
  DiscordAttachment,
  DiscordGateway,
  DiscordMessage
} from "../discord/gateway.js";
import { chunkReply } from "../replies/chunk.js";
import type { ThreadStateStore } from "../state/thread-state.js";
import { CliTranscriber, type Transcriber } from "../transcription/transcriber.js";
import { formatContextUsage } from "./context-usage.js";
import { formatModelInfo, readModelInfo } from "./model-info.js";
import { formatTurnStatus, readTurnStatus } from "./turn-status.js";

const TYPING_REFRESH_MS = 8000;
const CONTROL_HELP =
  "**Commands**\n" +
  "`!stop` / `!cancel` — interrupt the current turn\n" +
  "`!compact` — compact the conversation (frees up context)\n" +
  "`!reset` / `!new` — start a fresh thread (clears history)\n" +
  "`!context` — show context-window usage\n" +
  "`!model` — show the model and reasoning effort in use\n" +
  "`!status` — show whether a turn is running and its progress\n" +
  "`!help` — show this help";

type ControlCommand =
  | "stop"
  | "compact"
  | "reset"
  | "context"
  | "model"
  | "status"
  | "help";

interface QueuedMessage {
  message: DiscordMessage;
}

export class CodexDiscordBot {
  private threadId: string | undefined;
  private activeTurn = false;
  private activeReplyChannelId: string | undefined;
  private typingInterval: ReturnType<typeof setInterval> | undefined;
  private readonly queue: QueuedMessage[] = [];
  private readonly approvalsById = new Map<string, ApprovalRequest>();

  constructor(
    private readonly config: BotConfig,
    private readonly discord: DiscordGateway,
    private readonly codex: CodexClient,
    private readonly state: ThreadStateStore,
    private readonly transcriber: Transcriber = new CliTranscriber(
      config.transcription.binary
    )
  ) {}

  async start(discordToken: string): Promise<void> {
    this.discord.onMessage((message) => this.handleMessage(message));
    this.discord.onApprovalChoice((choice) => this.handleApprovalChoice(choice));
    this.codex.onFinalMessage((message) => this.handleFinalMessage(message));
    this.codex.onTurnCompleted((message) => this.handleTurnCompleted(message));
    this.codex.onApprovalRequest((request) =>
      this.handleApprovalRequest(request)
    );

    await this.state.init();
    await this.codex.connect();
    await this.initializeThread();
    await this.discord.start(discordToken);
  }

  async stop(): Promise<void> {
    this.stopTypingKeepAlive();
    await this.discord.stop();
    await this.codex.stop?.();
  }

  private async initializeThread(): Promise<void> {
    const storedThreadId = await this.state.readThreadId();
    if (storedThreadId) {
      try {
        this.threadId = await this.codex.resumeThread(
          storedThreadId,
          this.threadOptions()
        );
      } catch (error) {
        if (!isUnresumableThreadError(error)) {
          throw error;
        }
        this.threadId = await this.codex.startThread(this.threadOptions());
        await this.state.writeThreadId(this.threadId);
      }
      return;
    }

    this.threadId = await this.codex.startThread(this.threadOptions());
    await this.state.writeThreadId(this.threadId);
  }

  private async handleMessage(message: DiscordMessage): Promise<void> {
    if (!isMessageAllowed(this.config.access, message)) {
      return;
    }

    const controlCommand = parseControlCommand(message.content);
    if (controlCommand) {
      await this.handleControlCommand(message, controlCommand);
      return;
    }

    const turnMessage = await this.messageWithTranscripts(message);
    if (turnMessage.content.trim().length === 0) {
      return;
    }

    if (this.activeTurn) {
      this.queue.push({ message: turnMessage });
      return;
    }

    await this.startTurn(turnMessage);
  }

  private async handleControlCommand(
    message: DiscordMessage,
    command: ControlCommand
  ): Promise<void> {
    switch (command) {
      case "stop":
        await this.stopActiveTurn(message.channelId);
        return;
      case "compact":
        await this.compactThread(message.channelId);
        return;
      case "reset":
        await this.resetThread(message.channelId);
        return;
      case "context":
        await this.discord.sendMessage(
          message.channelId,
          formatContextUsage(this.codex.getTokenUsage())
        );
        return;
      case "model":
        await this.discord.sendMessage(
          message.channelId,
          formatModelInfo(
            await readModelInfo(this.threadId, this.config.codex.model)
          )
        );
        return;
      case "status":
        await this.discord.sendMessage(
          message.channelId,
          formatTurnStatus(
            await readTurnStatus(this.threadId, this.activeTurn),
            Date.now()
          )
        );
        return;
      case "help":
        await this.discord.sendMessage(message.channelId, CONTROL_HELP);
        return;
    }
  }

  private async stopActiveTurn(channelId: string): Promise<void> {
    if (!this.activeTurn) {
      await this.discord.sendMessage(channelId, "Nothing is running.");
      return;
    }

    try {
      const interrupted = await this.codex.interrupt();
      if (!interrupted) {
        await this.discord.sendMessage(
          channelId,
          "The turn is still starting up - try !stop again in a moment."
        );
        return;
      }
      this.clearActiveTurnState();
      this.clearQueuedMessages();
      this.approvalsById.clear();
      await this.discord.sendMessage(channelId, "Stopped the current turn.");
    } catch (error) {
      console.error("Failed to stop Codex turn", error);
      await this.discord.sendMessage(
        channelId,
        `Couldn't stop the turn: ${errorMessage(error)}`
      );
    }
  }

  private async compactThread(channelId: string): Promise<void> {
    if (this.activeTurn) {
      await this.discord.sendMessage(
        channelId,
        "A turn is running. Send !stop before !compact."
      );
      return;
    }

    if (!this.threadId) {
      await this.discord.sendMessage(
        channelId,
        "Couldn't compact the conversation: no Codex thread is initialized"
      );
      return;
    }

    try {
      await this.codex.compact(this.threadId);
      await this.discord.sendMessage(channelId, "Compacted the conversation.");
    } catch (error) {
      console.error("Failed to compact Codex thread", error);
      await this.discord.sendMessage(
        channelId,
        `Couldn't compact the conversation: ${errorMessage(error)}`
      );
    }
  }

  private async resetThread(channelId: string): Promise<void> {
    try {
      const threadId = await this.codex.startThread(this.threadOptions());
      await this.state.writeThreadId(threadId);
      this.threadId = threadId;
      this.clearActiveTurnState();
      this.clearQueuedMessages();
      this.approvalsById.clear();
      await this.discord.sendMessage(
        channelId,
        "Started a fresh thread (history cleared)."
      );
    } catch (error) {
      console.error("Failed to reset Codex thread", error);
      await this.discord.sendMessage(
        channelId,
        `Couldn't reset the conversation: ${errorMessage(error)}`
      );
    }
  }

  private async messageWithTranscripts(
    message: DiscordMessage
  ): Promise<DiscordMessage> {
    if (!this.config.transcription.enabled) {
      return message;
    }

    const audioAttachments = message.attachments.filter(isAudioAttachment);
    if (audioAttachments.length === 0) {
      return message;
    }

    const transcripts: string[] = [];
    for (const attachment of audioAttachments) {
      const transcript = await this.transcriber.transcribe(attachment.url);
      if (transcript && transcript.trim().length > 0) {
        transcripts.push(transcript);
      }
    }

    return {
      ...message,
      content: [message.content, ...transcripts]
        .filter((part) => part.trim().length > 0)
        .join("\n")
    };
  }

  private async startTurn(message: DiscordMessage): Promise<void> {
    if (!this.threadId) {
      throw new Error("Cannot start a Codex turn before thread initialization");
    }

    this.activeTurn = true;
    this.activeReplyChannelId = message.channelId;
    this.startTypingKeepAlive(message.channelId);
    await this.codex.startTurn({
      threadId: this.threadId,
      clientUserMessageId: message.id,
      input: [{ type: "text", text: message.content, text_elements: [] }],
      cwd: this.config.codex.cwd,
      ...(this.config.codex.model ? { model: this.config.codex.model } : {}),
      ...(this.config.codex.approvalPolicy
        ? { approvalPolicy: this.config.codex.approvalPolicy }
        : {})
    });
  }

  private async handleFinalMessage(message: {
    threadId: string;
    text: string;
  }): Promise<void> {
    if (message.threadId !== this.threadId || !this.activeReplyChannelId) {
      return;
    }

    const channelId = this.activeReplyChannelId;
    try {
      for (const chunk of chunkReply(message.text)) {
        await this.discord.sendMessage(channelId, chunk);
      }
    } finally {
      this.stopTypingKeepAlive();
    }
  }

  private async handleTurnCompleted(message: { threadId: string }): Promise<void> {
    if (message.threadId !== this.threadId || !this.activeTurn) {
      return;
    }
    this.clearActiveTurnState();
    await this.startNextQueuedTurn();
  }

  private async startNextQueuedTurn(): Promise<void> {
    const next = this.queue.shift();
    if (!next) {
      return;
    }
    await this.startTurn(next.message);
  }

  private async handleApprovalRequest(
    request: Record<string, unknown>
  ): Promise<void> {
    const approval = mapServerRequestToApproval(request);
    this.approvalsById.set(approval.approvalId, approval);

    const channelId = this.activeReplyChannelId;
    if (!channelId) {
      return;
    }

    await this.discord.sendApprovalPrompt(
      channelId,
      approval.approvalId,
      renderApprovalPrompt(approval)
    );
  }

  private async handleApprovalChoice(
    choice: DiscordApprovalChoice
  ): Promise<void> {
    const approval = this.approvalsById.get(choice.approvalId);
    if (!approval) {
      return;
    }

    const result = mapApprovalChoice(
      approval,
      choice.choice,
      choice.userId,
      this.config.access
    );
    if (!result.authorized) {
      return;
    }

    await this.codex.sendApprovalResponse(result.rpcId, result.response);
    this.approvalsById.delete(choice.approvalId);
  }

  private startTypingKeepAlive(channelId: string): void {
    this.stopTypingKeepAlive();
    void this.sendTypingBestEffort(channelId);
    this.typingInterval = setInterval(() => {
      void this.sendTypingBestEffort(channelId);
    }, TYPING_REFRESH_MS);
  }

  private stopTypingKeepAlive(): void {
    if (!this.typingInterval) {
      return;
    }
    clearInterval(this.typingInterval);
    this.typingInterval = undefined;
  }

  private async sendTypingBestEffort(channelId: string): Promise<void> {
    try {
      await this.discord.sendTyping(channelId);
    } catch (error) {
      console.error(
        `Failed to send Discord typing indicator to channel ${channelId}`,
        error
      );
    }
  }

  private clearActiveTurnState(): void {
    this.stopTypingKeepAlive();
    this.activeTurn = false;
    this.activeReplyChannelId = undefined;
  }

  private clearQueuedMessages(): void {
    this.queue.splice(0, this.queue.length);
  }

  private threadOptions(): CodexThreadOptions {
    return {
      cwd: this.config.codex.cwd,
      ...(this.config.codex.model ? { model: this.config.codex.model } : {}),
      ...(this.config.codex.sandbox
        ? { sandbox: this.config.codex.sandbox }
        : {}),
      ...(this.config.codex.approvalPolicy
        ? { approvalPolicy: this.config.codex.approvalPolicy }
        : {})
    };
  }
}

function isAudioAttachment(attachment: DiscordAttachment): boolean {
  return attachment.contentType?.startsWith("audio/") ?? false;
}

function parseControlCommand(content: string): ControlCommand | undefined {
  switch (content.trim().toLowerCase()) {
    case "!stop":
    case "!cancel":
      return "stop";
    case "!compact":
      return "compact";
    case "!reset":
    case "!new":
      return "reset";
    case "!context":
      return "context";
    case "!model":
      return "model";
    case "!status":
      return "status";
    case "!help":
      return "help";
    default:
      return undefined;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  if (typeof error === "string" && error.length > 0) {
    return error;
  }
  return "unknown error";
}

function isUnresumableThreadError(error: unknown): boolean {
  const errorRecord =
    typeof error === "object" && error !== null && !Array.isArray(error)
      ? (error as Record<string, unknown>)
      : {};
  const message =
    typeof errorRecord.message === "string"
      ? errorRecord.message
      : error instanceof Error
        ? error.message
        : "";

  return (
    errorRecord.code === -32600 ||
    message.toLowerCase().includes("no rollout found")
  );
}
