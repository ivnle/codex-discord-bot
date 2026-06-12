import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

interface ThreadStateFile {
  threadId?: string;
}

export class ThreadStateStore {
  private readonly statePath: string;

  constructor(private readonly dataDir: string) {
    this.statePath = path.join(dataDir, "thread-state.json");
  }

  async init(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
  }

  async readThreadId(): Promise<string | undefined> {
    try {
      const state = JSON.parse(
        await readFile(this.statePath, "utf8")
      ) as ThreadStateFile;
      return typeof state.threadId === "string" && state.threadId.length > 0
        ? state.threadId
        : undefined;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  async writeThreadId(threadId: string): Promise<void> {
    await this.init();
    await writeFile(
      this.statePath,
      `${JSON.stringify({ threadId }, null, 2)}\n`,
      "utf8"
    );
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
