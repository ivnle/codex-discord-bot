import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Interaction,
  type MessageCreateOptions
} from "discord.js";

import type { ApprovalChoice } from "../approvals/approval-bridge.js";
import type {
  DiscordAttachment,
  DiscordApprovalChoiceHandler,
  DiscordGateway,
  DiscordMessage,
  DiscordMessageHandler,
  DiscordPrompt
} from "./gateway.js";
import type { ConversationGateway, TaskAction, TaskCard } from "./gateway.js";

const APPROVAL_CUSTOM_ID_PREFIX = "codex-approval";

type SendableTextChannel = {
  send(payload: MessageCreateOptions): Promise<unknown>;
};

type TypingTextChannel = {
  sendTyping(): Promise<void>;
};

export interface DiscordMessageLike {
  id: string;
  author: {
    id: string;
    bot: boolean;
  };
  channelId: string;
  content: string;
  attachments: {
    values(): Iterable<DiscordAttachmentLike>;
  };
  inGuild(): boolean;
}

interface DiscordAttachmentLike {
  url: string;
  contentType?: string | null;
}

export function toGatewayMessage(
  message: DiscordMessageLike
): DiscordMessage | undefined {
  const attachments = Array.from(
    message.attachments.values(),
    toGatewayAttachment
  );
  if (
    message.author.bot ||
    (message.content.trim().length === 0 && attachments.length === 0)
  ) {
    return undefined;
  }

  return {
    id: message.id,
    authorId: message.author.id,
    channelId: message.channelId,
    content: message.content,
    attachments,
    isDirectMessage: !message.inGuild()
  };
}

function toGatewayAttachment(
  attachment: DiscordAttachmentLike
): DiscordAttachment {
  return {
    url: attachment.url,
    contentType: attachment.contentType
  };
}

export function approvalCustomId(
  approvalId: string,
  choice: ApprovalChoice
): string {
  return `${APPROVAL_CUSTOM_ID_PREFIX}:${encodeURIComponent(
    approvalId
  )}:${choice}`;
}

export function parseApprovalCustomId(
  customId: string
): { approvalId: string; choice: ApprovalChoice } | undefined {
  const parts = customId.split(":");
  const [prefix, encodedApprovalId, choice] = parts;
  if (
    parts.length !== 3 ||
    prefix !== APPROVAL_CUSTOM_ID_PREFIX ||
    !encodedApprovalId ||
    (choice !== "approve" && choice !== "deny")
  ) {
    return undefined;
  }

  return {
    approvalId: decodeURIComponent(encodedApprovalId),
    choice
  };
}

export class DiscordJsGateway implements ConversationGateway {
  private readonly messageHandlers: DiscordMessageHandler[] = [];
  private readonly approvalHandlers: DiscordApprovalChoiceHandler[] = [];
  private actionHandler?: (action: TaskAction) => Promise<string>;

  constructor(
    private readonly client = new Client({
      intents: [
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.Guilds
      ],
      partials: [Partials.Channel]
    })
  ) {
    this.client.on(Events.MessageCreate, (message) => {
      void this.handleMessage(message).catch(() => console.error("Discord message handling failed"));
    });
    this.client.on(Events.InteractionCreate, (interaction) => {
      void this.handleInteraction(interaction).catch(() => console.error("Discord interaction handling failed"));
    });
  }

  onMessage(handler: DiscordMessageHandler): void {
    this.messageHandlers.push(handler);
  }

  onApprovalChoice(handler: DiscordApprovalChoiceHandler): void {
    this.approvalHandlers.push(handler);
  }

  async start(token: string): Promise<void> {
    await this.client.login(token);
  }

  async stop(): Promise<void> {
    this.client.destroy();
  }

  async sendMessage(channelId: string, content: string): Promise<void> {
    await this.sendToChannel(channelId, { content });
  }

  onAction(handler: (action: TaskAction) => Promise<string>): void {
    this.actionHandler = handler;
  }

  async messagesAfter(channelId:string, afterId:string):Promise<DiscordMessage[]> {
    const channel=await this.client.channels.fetch(channelId);
    if(!channel?.isTextBased() || !("messages" in channel))throw new Error("Cannot read saved channel history.");
    const result:DiscordMessage[]=[];
    let before:string|undefined;
    for(let page=0;page<100;page++) {
      const batch=await channel.messages.fetch({limit:100,...(before?{before}:{})});
      if(!batch.size) return result.sort((a,b)=>BigInt(a.id)<BigInt(b.id)?-1:1);
      const sorted=[...batch.values()].sort((a,b)=>BigInt(a.id)<BigInt(b.id)?-1:1);
      for(const raw of sorted) if(BigInt(raw.id)>BigInt(afterId)) {const message=toGatewayMessage(raw);if(message)result.push(message);}
      before=sorted[0]!.id;
      if(BigInt(before)<=BigInt(afterId) || batch.size<100)return result.sort((a,b)=>BigInt(a.id)<BigInt(b.id)?-1:1);
    }
    throw new Error("Too much channel history to recover automatically; Ivan needs to review missed requests.");
  }

  async putStatus(channelId: string, messageId: string | undefined, card: TaskCard): Promise<string> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !("send" in channel)) throw new Error("Channel unavailable");
    const components = card.actions.length ? [new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...card.actions.map((action) => new ButtonBuilder()
        .setCustomId(`ispy:${action.id}`).setLabel(action.label).setStyle(ButtonStyle.Secondary))
    )] : [];
    const payload = { content: card.content, components, allowedMentions: { parse: [] as [] } };
    if (messageId) {
      try {
        const message = await channel.messages.fetch(messageId);
        await message.edit(payload);
        return message.id;
      } catch (error) {
        // Replace deleted cards; don't duplicate cards for transient failures.
        if (!(typeof error === "object" && error !== null && "code" in error && error.code === 10008)) throw error;
      }
    }
    return (await channel.send(payload)).id;
  }

  async sendTyping(channelId: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (
        !channel ||
        !channel.isTextBased() ||
        !("sendTyping" in channel) ||
        typeof channel.sendTyping !== "function"
      ) {
        throw new Error(`Discord channel ${channelId} is not text based`);
      }
      await (channel as TypingTextChannel).sendTyping();
    } catch (error) {
      console.error(
        `Failed to send Discord typing indicator to channel ${channelId}`,
        error
      );
    }
  }

  async sendApprovalPrompt(
    channelId: string,
    approvalId: string,
    prompt: DiscordPrompt
  ): Promise<void> {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(approvalCustomId(approvalId, "approve"))
        .setLabel("Approve")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(approvalCustomId(approvalId, "deny"))
        .setLabel("Deny")
        .setStyle(ButtonStyle.Danger)
    );

    await this.sendToChannel(channelId, {
      content: prompt.content,
      components: [row]
    });
  }

  private async handleMessage(message: DiscordMessageLike): Promise<void> {
    const gatewayMessage = toGatewayMessage(message);
    if (!gatewayMessage) {
      return;
    }

    for (const handler of this.messageHandlers) {
      await handler(gatewayMessage);
    }
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isButton()) {
      return;
    }

    if (interaction.customId.startsWith("ispy:") && this.actionHandler && interaction.channelId) {
      await interaction.deferReply({ ephemeral: true });
      const response = await this.actionHandler({
        id: interaction.customId.slice(5), userId: interaction.user.id, channelId: interaction.channelId
      });
      await interaction.editReply(response);
      return;
    }

    const parsed = parseApprovalCustomId(interaction.customId);
    if (!parsed) {
      return;
    }

    for (const handler of this.approvalHandlers) {
      await handler({
        approvalId: parsed.approvalId,
        choice: parsed.choice,
        userId: interaction.user.id
      });
    }

    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "Choice recorded.",
        ephemeral: true
      });
    }
  }

  private async sendToChannel(
    channelId: string,
    payload: MessageCreateOptions
  ): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (
      !channel ||
      !channel.isTextBased() ||
      !("send" in channel) ||
      typeof channel.send !== "function"
    ) {
      throw new Error(`Discord channel ${channelId} is not text based`);
    }
    await (channel as SendableTextChannel).send({ ...payload, allowedMentions: { parse: [] } });
  }
}
