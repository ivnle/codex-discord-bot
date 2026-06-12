import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ThreadStateStore } from "../../src/state/thread-state.js";

const createdDirs: string[] = [];

async function tempDataDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-discord-bot-"));
  createdDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

describe("ThreadStateStore", () => {
  it("initializes the data directory and starts without a thread id", async () => {
    const store = new ThreadStateStore(await tempDataDir());

    await store.init();

    await expect(store.readThreadId()).resolves.toBeUndefined();
  });

  it("persists and reloads the current Codex thread id", async () => {
    const dataDir = await tempDataDir();
    const store = new ThreadStateStore(dataDir);
    await store.init();

    await store.writeThreadId("thread-1");

    await expect(new ThreadStateStore(dataDir).readThreadId()).resolves.toBe(
      "thread-1"
    );
  });
});
