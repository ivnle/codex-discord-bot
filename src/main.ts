#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import path from "node:path";

import { CodexDiscordBot } from "./bot/runtime.js";
import { AppServerCodexClient } from "./codex/app-server-client.js";
import { StdioJsonRpcTransport } from "./codex/stdio-transport.js";
import { loadConfig, resolveDiscordToken } from "./config/load.js";
import { DiscordJsGateway } from "./discord/discord-js-gateway.js";
import { ThreadStateStore } from "./state/thread-state.js";

export function parseConfigPathArg(argv: string[]): string {
  const args = argv.slice(2);
  if (args.length !== 1) {
    throw new Error(
      "Usage: codex-discord-bot <config.yaml> (pass exactly one config file)"
    );
  }
  return args[0]!;
}

export async function runMain(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const configPath = parseConfigPathArg(argv);
  const config = await loadConfig(configPath);
  const token = resolveDiscordToken(config, env);

  const transport = new StdioJsonRpcTransport(
    config.codex.command,
    config.codex.args,
    {
      cwd: config.codex.cwd
    }
  );
  const codex = new AppServerCodexClient(transport);
  const discord = new DiscordJsGateway();
  const state = new ThreadStateStore(config.runtime.dataDir);
  const bot = new CodexDiscordBot(config, discord, codex, state);

  process.once("SIGINT", () => {
    void bot.stop().finally(() => {
      process.exitCode = 130;
    });
  });
  process.once("SIGTERM", () => {
    void bot.stop().finally(() => {
      process.exitCode = 143;
    });
  });

  await bot.start(token);
}

function isEntrypoint(metaUrl: string): boolean {
  const entry = process.argv[1];
  return entry ? fileURLToPath(metaUrl) === path.resolve(entry) : false;
}

if (isEntrypoint(import.meta.url)) {
  runMain().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
