import { describe, expect, it } from "vitest";

import {
  approvalCustomId,
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
});
