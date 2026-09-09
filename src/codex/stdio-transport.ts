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
  private readonly closeHandlers: Array<() => void> = [];

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

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
    // Drain stderr so a verbose worker cannot block on a full pipe. Never relay
    // raw worker output (which can contain credentials) to Discord.
    child.stderr.resume();
    child.once("exit", () => {
      if (this.child !== child) return;
      this.child = undefined;
      this.closeHandlers.forEach((handler) => handler());
    });
    child.on("error", () => {
      if (this.child === child) this.closeHandlers.forEach((handler) => handler());
    });

    createInterface({ input: child.stdout }).on("line", (line) => {
      if (!line.trim()) {
        return;
      }
      try {
        this.messageHandler?.(JSON.parse(line) as JsonRpcMessage);
      } catch {
        child.kill("SIGTERM");
      }
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
