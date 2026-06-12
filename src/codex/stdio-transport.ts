import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

import type { JsonRpcMessage, JsonRpcTransport } from "./json-rpc.js";

export interface StdioJsonRpcTransportOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export class StdioJsonRpcTransport implements JsonRpcTransport {
  private child: ChildProcessWithoutNullStreams | undefined;
  private messageHandler: ((message: JsonRpcMessage) => void) | undefined;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly options: StdioJsonRpcTransportOptions
  ) {}

  onMessage(handler: (message: JsonRpcMessage) => void): void {
    this.messageHandler = handler;
  }

  async start(): Promise<void> {
    if (this.child) {
      return;
    }

    const child = spawn(this.command, this.args, {
      cwd: this.options.cwd,
      env: this.options.env ?? process.env,
      stdio: "pipe"
    });
    this.child = child;

    createInterface({ input: child.stdout }).on("line", (line) => {
      if (!line.trim()) {
        return;
      }
      this.messageHandler?.(JSON.parse(line) as JsonRpcMessage);
    });

    const [event] = await Promise.race([
      once(child, "spawn").then(() => ["spawn"] as const),
      once(child, "error").then((error) => ["error", error] as const),
      once(child, "exit").then(([code]) => ["exit", code] as const)
    ]);

    if (event !== "spawn") {
      throw new Error(`Failed to start app-server command: ${this.command}`);
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) {
      return;
    }

    this.child = undefined;
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
  }

  async send(message: JsonRpcMessage): Promise<void> {
    const child = this.child;
    if (!child) {
      throw new Error("Cannot send JSON-RPC message before transport start");
    }

    const canContinue = child.stdin.write(`${JSON.stringify(message)}\n`);
    if (!canContinue) {
      await once(child.stdin, "drain");
    }
  }
}
