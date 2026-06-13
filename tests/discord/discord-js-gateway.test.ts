import { describe, expect, it } from "vitest";

import {
  approvalCustomId,
  DiscordJsGateway,
  parseApprovalCustomId,
  toGatewayMessage
} from "../../src/discord/discord-js-gateway.js";

describe("Discord.js gateway helpers", () => {
  it("normalizes Discord.js messages into gateway messages", () => {
    expect(
      toGatewayMessage({
        id: "message-1",
        author: { id: "user-1", bot: false },
        channelId: "channel-1",
        content: "hello",
        attachments: new Map(),
        inGuild: () => true
      })
    ).toEqual({
      id: "message-1",
      authorId: "user-1",
      channelId: "channel-1",
      content: "hello",
      attachments: [],
      isDirectMessage: false
    });
  });

  it("normalizes attachment metadata and keeps attachment-only messages", () => {
    expect(
      toGatewayMessage({
        id: "message-1",
        author: { id: "user-1", bot: false },
        channelId: "channel-1",
        content: "",
        attachments: new Map([
          [
            "attachment-1",
            {
              url: "https://cdn.example.test/voice.ogg",
              contentType: "audio/ogg"
            }
          ],
          [
            "attachment-2",
            {
              url: "https://cdn.example.test/image.png",
              contentType: "image/png"
            }
          ]
        ]),
        inGuild: () => false
      })
    ).toEqual({
      id: "message-1",
      authorId: "user-1",
      channelId: "channel-1",
      content: "",
      attachments: [
        {
          url: "https://cdn.example.test/voice.ogg",
          contentType: "audio/ogg"
        },
        {
          url: "https://cdn.example.test/image.png",
          contentType: "image/png"
        }
      ],
      isDirectMessage: true
    });
  });

  it("drops bot-authored messages", () => {
    expect(
      toGatewayMessage({
        id: "message-1",
        author: { id: "bot-1", bot: true },
        channelId: "channel-1",
        content: "hello",
        attachments: new Map(),
        inGuild: () => true
      })
    ).toBeUndefined();
  });

  it("drops empty messages without attachments", () => {
    expect(
      toGatewayMessage({
        id: "message-1",
        author: { id: "user-1", bot: false },
        channelId: "channel-1",
        content: "   ",
        attachments: new Map(),
        inGuild: () => true
      })
    ).toBeUndefined();
  });

  it("round trips approval custom ids", () => {
    const customId = approvalCustomId("rpc-1", "approve");

    expect(parseApprovalCustomId(customId)).toEqual({
      approvalId: "rpc-1",
      choice: "approve"
    });
    expect(parseApprovalCustomId("not-codex")).toBeUndefined();
  });

  it("sends typing to a fetched text channel", async () => {
    const fetchedChannelIds: string[] = [];
    const typedChannelIds: string[] = [];
    const client = {
      on: () => client,
      channels: {
        fetch: async (channelId: string) => {
          fetchedChannelIds.push(channelId);
          return {
            isTextBased: () => true,
            sendTyping: async () => {
              typedChannelIds.push(channelId);
            }
          };
        }
      },
      login: async () => "gateway-auth-value",
      destroy: () => undefined
    } as unknown as ConstructorParameters<typeof DiscordJsGateway>[0];
    const gateway = new DiscordJsGateway(client);
    const typingGateway = gateway as DiscordJsGateway & {
      sendTyping(channelId: string): Promise<void>;
    };

    expect(typeof typingGateway.sendTyping).toBe("function");

    await expect(typingGateway.sendTyping("channel-1")).resolves.toBeUndefined();

    expect(fetchedChannelIds).toEqual(["channel-1"]);
    expect(typedChannelIds).toEqual(["channel-1"]);
  });
});
