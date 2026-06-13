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
Discord. While Codex is working on an active turn, the bot keeps Discord's
typing indicator visible in the reply channel.

### Discord control commands

Allowed Discord users can send these whole-message commands to control the
current Codex session locally. Commands are case-insensitive and are not sent to
Codex as prompts:

- `!stop` or `!cancel`: interrupt the active turn. This clears the active turn,
  stops typing, and drops queued messages so a stopped backlog does not resume.
  If no turn is active, the bot replies that nothing is running.
- `!compact`: compact the current thread. If a turn is active, the bot asks the
  operator to send `!stop` first so compaction does not race a live turn.
- `!reset` or `!new`: start a fresh thread, persist its thread id, clear active
  state, and drop queued messages.
- `!context`: show current context-window usage and cumulative session tokens.
- `!help`: show the command list.

### Custom instructions / per-bot prompt

Each bot config can opt into a custom instructions file:

```yaml
codex:
  cwd: /path/to/project
  instructions_file: .codex/bot-instructions.md
```

The bot expands `~`, resolves relative `instructions_file` paths from
`codex.cwd`, verifies the file exists during startup, and launches Codex with
`-c model_instructions_file=<absolute path>` before the `app-server` subcommand.
The setting is per bot config, so different bot processes can use different
instruction files.

`model_instructions_file` may override Codex's built-in base instructions
rather than append to them. Write the file deliberately, and confirm the
replace-vs-append behavior for the Codex version you run before relying on it.

### Voice transcription

Voice notes and audio attachments are ignored by default. To opt in, enable the
`transcription` block in the YAML config and provide a `transcribe`-compatible
CLI on `PATH`:

```yaml
transcription:
  enabled: true
  binary: transcribe
```

The bot invokes the CLI as `transcribe <audio-file> --json` and uses the
returned JSON object's `final` field as plain text input for Codex. Failed
transcriptions are skipped; a voice-only message with no successful transcript is
treated like an empty message.

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
