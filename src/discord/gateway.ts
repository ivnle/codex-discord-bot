import type { ApprovalChoice } from "../approvals/approval-bridge.js";

export interface DiscordMessage {
  id: string;
  authorId: string;
  channelId: string;
  isDirectMessage: boolean;
  content: string;
  attachments: DiscordAttachment[];
}

export interface DiscordAttachment {
  url: string;
  contentType?: string | null;
}

export interface DiscordPrompt {
  content: string;
  actions: Array<{ id: ApprovalChoice; label: string }>;
}

export interface DiscordApprovalChoice {
  approvalId: string;
  choice: ApprovalChoice;
  userId: string;
}

export type DiscordMessageHandler = (
  message: DiscordMessage
) => void | Promise<void>;

export type DiscordApprovalChoiceHandler = (
  choice: DiscordApprovalChoice
) => void | Promise<void>;

export interface DiscordGateway {
  onMessage(handler: DiscordMessageHandler): void;
  onApprovalChoice(handler: DiscordApprovalChoiceHandler): void;
  start(token: string): Promise<void>;
  stop(): Promise<void>;
  sendMessage(channelId: string, content: string): Promise<void>;
  sendTyping(channelId: string): Promise<void>;
  sendApprovalPrompt(
    channelId: string,
    approvalId: string,
    prompt: DiscordPrompt
  ): Promise<void>;
}
