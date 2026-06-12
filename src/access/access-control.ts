import type { BotConfig } from "../config/types.js";

export interface DiscordAccessMessage {
  authorId: string;
  channelId: string;
  isDirectMessage: boolean;
}

export function isUserAllowlisted(
  access: BotConfig["access"],
  userId: string
): boolean {
  return access.allowUserIds.includes(userId);
}

export function isMessageAllowed(
  access: BotConfig["access"],
  message: DiscordAccessMessage
): boolean {
  if (!isUserAllowlisted(access, message.authorId)) {
    return false;
  }
  if (message.isDirectMessage) {
    return true;
  }
  return access.channels.includes(message.channelId);
}
