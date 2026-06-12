export const DISCORD_MESSAGE_LIMIT = 2000;

export function chunkReply(
  reply: string,
  limit = DISCORD_MESSAGE_LIMIT
): string[] {
  if (reply.length <= limit) {
    return [reply];
  }

  const chunks: string[] = [];
  let remaining = reply;

  while (remaining.length > limit) {
    const boundary = remaining.lastIndexOf("\n", limit);
    const splitAt = boundary > 0 ? boundary : limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(boundary > 0 ? splitAt + 1 : splitAt);
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}
