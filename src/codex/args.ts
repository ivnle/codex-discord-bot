import type { BotConfig } from "../config/types.js";

type CodexArgConfig = Pick<BotConfig["codex"], "args" | "instructionsFile">;

export function buildCodexArgs(config: CodexArgConfig): string[] {
  if (!config.instructionsFile) {
    return config.args;
  }

  return [
    "-c",
    `model_instructions_file=${config.instructionsFile}`,
    ...config.args
  ];
}
