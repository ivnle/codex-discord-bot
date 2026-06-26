import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export function codexSessionsDir(): string {
  const home = process.env.CODEX_HOME ?? path.join(homedir(), ".codex");
  return path.join(home, "sessions");
}

// Find the rollout JSONL whose filename embeds this threadId. Codex names
// rollouts `rollout-<timestamp>-<threadId>.jsonl` under sessions/YYYY/MM/DD/.
export async function findRolloutForThread(
  threadId: string,
  sessionsDir: string = codexSessionsDir()
): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await readdir(sessionsDir, { recursive: true });
  } catch {
    return undefined;
  }
  const matches = entries.filter(
    (rel) => rel.endsWith(".jsonl") && rel.includes(threadId)
  );
  if (matches.length === 0) {
    return undefined;
  }
  // Sort lexically; rollout filenames are timestamp-prefixed so the last is newest.
  matches.sort();
  return path.join(sessionsDir, matches[matches.length - 1]!);
}
