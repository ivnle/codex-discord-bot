# codex-discord-bot

Discord gateway for local Codex CLI sessions driven through `codex app-server`.

## Usage

Install dependencies and build the project:

```bash
npm install
npm run build
```

Create a YAML config based on [examples/bot.yaml](examples/bot.yaml), set the
Discord token in the environment variable named by `discord_token_env`, then run
one bot process for that config file:

```bash
export DISCORD_BOT_TOKEN=...
npm run build
node dist/main.js examples/bot.yaml
```

The bot launches the configured local `codex app-server --stdio` command, starts
or resumes one Codex thread, accepts messages only from allowlisted users and
opted-in channels, queues turns FIFO, and posts final assistant replies back to
Discord.

## Goal

Provide a standalone bot that:

- receives allowed Discord messages;
- forwards them to a local Codex thread;
- preserves conversation state;
- sends Codex replies back to Discord;
- relays Codex approval requests through Discord interactions.

## Non-goals

- No Claude Code plugin dependency.
- No `--channels` protocol.
- No live Discord integration tests in the initial implementation.

## Development

```bash
npm test
npm run typecheck
npm run build
```

Tests use fake Discord and fake app-server adapters; they do not require a real
Discord token or live Discord connection.
