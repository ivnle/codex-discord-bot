# codex-discord-bot

Discord gateway for local Codex CLI sessions driven through `codex app-server`.

This repository is intentionally minimal until the first implementation task lands.

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

