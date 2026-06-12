import { describe, expect, it } from "vitest";

import { JsonRpcPeer } from "../../src/codex/json-rpc.js";
import { StdioJsonRpcTransport } from "../../src/codex/stdio-transport.js";

describe("StdioJsonRpcTransport", () => {
  it("sends newline-delimited JSON requests and receives responses", async () => {
    const script = `
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    process.stdout.write(JSON.stringify({
      id: request.id,
      result: { method: request.method, params: request.params }
    }) + "\\n");
  }
});
`;
    const transport = new StdioJsonRpcTransport(process.execPath, ["-e", script], {
      cwd: process.cwd()
    });
    const peer = new JsonRpcPeer(transport);

    await peer.start();
    const result = await peer.request("ping", { ok: true });
    await peer.stop();

    expect(result).toEqual({ method: "ping", params: { ok: true } });
  });
});
