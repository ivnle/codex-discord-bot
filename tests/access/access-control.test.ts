import { describe, expect, it } from "vitest";

import { isMessageAllowed } from "../../src/access/access-control.js";

const access = {
  allowUserIds: ["user-1"],
  channels: ["channel-1"]
};

describe("isMessageAllowed", () => {
  it("allows an allowlisted user in an opted-in channel", () => {
    expect(
      isMessageAllowed(access, {
        authorId: "user-1",
        channelId: "channel-1",
        isDirectMessage: false
      })
    ).toBe(true);
  });

  it("allows direct messages from allowlisted users without a channel allowlist match", () => {
    expect(
      isMessageAllowed(access, {
        authorId: "user-1",
        channelId: "dm-channel",
        isDirectMessage: true
      })
    ).toBe(true);
  });

  it("denies unallowlisted users and non-opted-in guild channels", () => {
    expect(
      isMessageAllowed(access, {
        authorId: "user-2",
        channelId: "channel-1",
        isDirectMessage: false
      })
    ).toBe(false);
    expect(
      isMessageAllowed(access, {
        authorId: "user-1",
        channelId: "channel-2",
        isDirectMessage: false
      })
    ).toBe(false);
  });

  it("denies everyone when the user allowlist is empty", () => {
    expect(
      isMessageAllowed(
        { allowUserIds: [], channels: ["channel-1"] },
        {
          authorId: "user-1",
          channelId: "channel-1",
          isDirectMessage: false
        }
      )
    ).toBe(false);
  });
});
