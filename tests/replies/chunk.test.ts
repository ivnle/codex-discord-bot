import { describe, expect, it } from "vitest";

import { chunkReply } from "../../src/replies/chunk.js";

describe("chunkReply", () => {
  it("keeps short replies intact", () => {
    expect(chunkReply("hello")).toEqual(["hello"]);
  });

  it("splits replies at Discord's 2000-character message limit", () => {
    const chunks = chunkReply("a".repeat(2001));

    expect(chunks).toHaveLength(2);
    expect(chunks.join("")).toBe("a".repeat(2001));
    expect(chunks.every((chunk) => chunk.length <= 2000)).toBe(true);
  });

  it("prefers newline boundaries when possible", () => {
    const first = "a".repeat(1990);
    const second = "b".repeat(20);

    expect(chunkReply(`${first}\n${second}`)).toEqual([first, second]);
  });
});
