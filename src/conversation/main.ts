#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { ReleaseController, type ReleaseConfig } from "../releases/controller.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { AppServerCodexClient } from "../codex/app-server-client.js";
import { StdioJsonRpcTransport } from "../codex/stdio-transport.js";
import { loadConfig, resolveDiscordToken } from "../config/load.js";
import { DiscordJsGateway } from "../discord/discord-js-gateway.js";
import { ConversationStore } from "./store.js";
import { FamilyConversation } from "./runtime.js";

export async function runFamily(configPath: string): Promise<void> {
  const config = await loadConfig(configPath);
  const token = resolveDiscordToken(config);
  // Discord credentials belong to the bridge, not the coding subprocess.
  const workerEnv: NodeJS.ProcessEnv = {};
  for (const key of ["HOME", "PATH", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "CODEX_HOME"]) {
    if (process.env[key]) workerEnv[key] = process.env[key];
  }
  const codex = new AppServerCodexClient(new StdioJsonRpcTransport(
    config.codex.command, config.codex.args, { cwd: config.codex.cwd, env: workerEnv },
  ));
  const releases = process.env.GENGAR_RELEASE_CONFIG ? new ReleaseController(JSON.parse(await readFile(process.env.GENGAR_RELEASE_CONFIG,"utf8")) as ReleaseConfig) : undefined;
  if(releases) {
    if(!process.env.CODEX_HOME)throw new Error("Automatic releases require a dedicated Codex configuration.");
    const policy=await readFile(path.join(process.env.CODEX_HOME,"config.toml"),"utf8");
    if(!policy.includes('default_permissions = "family"') || /^sandbox_mode\s*=/m.test(policy) || /\[mcp_servers[.\]]/.test(policy)) throw new Error("Family worker isolation configuration is missing or overridden.");
  }
  const bot = new FamilyConversation(config, new DiscordJsGateway(), codex, new ConversationStore(config.runtime.dataDir), Date.now, releases);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => { void bot.stop().finally(() => { process.exitCode = 0; }); });
  }
  await bot.start(token);
  console.log("Family conversation bridge connected");
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.argv.length !== 3) throw new Error("Usage: node dist/conversation/main.js <config.yaml>");
  runFamily(process.argv[2]!).catch(() => {
    console.error("Family bridge startup failed. Check configuration, Discord access and Codex login.");
    process.exitCode = 1;
  });
}
