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
  DiscordGateway,
  DiscordMessage
} from "../discord/gateway.js";
import { chunkReply } from "../replies/chunk.js";
import type { ThreadStateStore } from "../state/thread-state.js";

interface QueuedMessage {
  message: DiscordMessage;
}

export class CodexDiscordBot {
  private threadId: string | undefined;
  private activeTurn = false;
  private activeReplyChannelId: string | undefined;
  private readonly queue: QueuedMessage[] = [];
  private readonly approvalsById = new Map<string, ApprovalRequest>();

  constructor(
    private readonly config: BotConfig,
    private readonly discord: DiscordGateway,
    private readonly codex: CodexClient,
    private readonly state: ThreadStateStore
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

    if (this.activeTurn) {
      this.queue.push({ message });
      return;
    }

    await this.startTurn(message);
  }

  private async startTurn(message: DiscordMessage): Promise<void> {
    if (!this.threadId) {
      throw new Error("Cannot start a Codex turn before thread initialization");
    }

    this.activeTurn = true;
    this.activeReplyChannelId = message.channelId;
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
    for (const chunk of chunkReply(message.text)) {
      await this.discord.sendMessage(channelId, chunk);
    }
  }

  private async handleTurnCompleted(message: { threadId: string }): Promise<void> {
    if (message.threadId !== this.threadId || !this.activeTurn) {
      return;
    }
    this.activeTurn = false;
    this.activeReplyChannelId = undefined;
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
