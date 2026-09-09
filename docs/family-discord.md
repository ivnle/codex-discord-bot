# Family game conversation

A dedicated channel receives ordinary text messages from the configured parents.
Each request is saved before acknowledgment, gets one editable status message, and
runs in one persistent Codex conversation. Follow-ups are visibly queued. Stop
waits for the worker's completion event; failed jobs have a Retry button. A question
can be answered with a normal message. Final replies are saved and retried if
Discord delivery fails. Restart marks unfinished work Interrupted rather than
silently executing it again.

## Run

Build with `npm run build`. Start the family entry point (the old `dist/main.js`
remains the legacy command-oriented bot):

```sh
node --env-file=/absolute/path/gengar.env dist/conversation/main.js /absolute/path/bot.yaml
```

Use the existing YAML format. Family mode requires exactly one channel and a
nonempty user allowlist. DMs, other channels, other users, and bot messages are
ignored. The family entry point adds its own developer instructions and does not
replace Codex's base instructions. The Discord token is excluded from the worker's
environment. Codex uses its local login. When automatic releases are enabled, a dedicated Codex permission profile limits
tool reads and writes to the game and required runtimes. Publishing credentials,
other home directories, and the controller are inaccessible to the coding tools.
The copied conversation keeps its original thread ID; the dedicated Codex home
shares the existing login via a protected auth-file symlink.

Current local deployment:

- Bot: Gengar (`1515227481563729980`).
- Server: ivandreat (`991545197278269552`).
- Channel: daddy-game (`1547310808650747986`).
- Config and token: `~/.config/ispy-discord/bot.yaml` and `gengar.env` (private).
- Conversation and lock: `~/.local/share/ispy-discord/`.
- Game workspace: `~/repos/ispy-family`, branch `family/discord` in the ispy repo.
- Service label: `com.ivanlee.ispy-discord`.

Grant the bot View Channel, Send Messages, Read Message History, Embed Links and
Attach Files on daddy-game. No Administrator permission is needed. Message Content
intent must be enabled in the developer portal. Only the selected parents are
allowed by the local application, even if other people later join the channel.

The service uses launchd to restart after failure and login, and caffeinate to
prevent idle system sleep while running. It cannot run with the Mac shut down,
logged out, or a laptop lid forcing sleep. The bot's offline presence and the last
activity timestamp are the visible clues if the entire Mac goes offline; a local
process cannot update Discord during a network outage.

```sh
launchctl print gui/$(id -u)/com.ivanlee.ispy-discord
launchctl kickstart -k gui/$(id -u)/com.ivanlee.ispy-discord
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.ivanlee.ispy-discord.plist
```

## Automatic production releases

`GENGAR_RELEASE_CONFIG` points to a private JSON configuration outside the game
checkout. `CODEX_HOME` points to the dedicated family configuration. The controller
lives in `src/releases/`; the coding agent cannot modify it. The launchd service
sets both values. No deployment token is passed to the coding subprocess.

A completed coding turn triggers the controller, which:

1. Snapshots tracked and new files into a separate Git tree and enforces the path
   policy before executing candidate code. Existing tests, root configuration,
   dependencies, shared platform code, the service worker, and storage changes
   require owner review. Symlinks and submodules are rejected.
2. Copies the snapshot and read-only installed dependencies to a private checking
   directory. Runs `npm run verify` in a macOS sandbox without publishing
   credentials, controller write access, or public network access.
3. Runs the trusted data-only scenario runner. Every new game requires a scenario
   with an interaction that makes a previously hidden outcome visible. The full
   production smoke test covers every library tile, including new games, offline.
4. Copies the checked build into a static upload directory, omitting `_routes.json`
   so no Pages Functions are discovered. Uploads those same bytes with pinned
   Wrangler, an explicit production branch, and a unique release identity.
5. Verifies `release.json`, index and service-worker hashes at the normal game
   origin, then runs the production browser smoke test against that live origin.
6. Records the deployment and source commit. Failed post-deploy verification
   restores the preceding production deployment. The agent gets at most two
   repair attempts for a failed release; protected edits go to Ivan's review.

The status card stays active through Checking, Publishing, and Checking live game.
During the local gameplay suite it names the current game. The full suite currently
takes about 15 minutes. Stop before upload prevents publishing; Stop after upload
causes safe restoration before finishing. `Undo` or the latest release's Undo
button restores the prior deployment and its source baseline. Saved browser data
is not cleared. Undo refuses to overwrite unfinished source edits or an external
deployment. Old release buttons cannot roll back newer changes.

The source baseline is the `family/discord` branch in `~/repos/ispy-family`.
`~/repos/ispy` remains a separate main checkout. Candidates and previous commits
are retained in Git under `refs/gengar/candidates/`; no automatic remote push is
performed. Every release directory retains source, checked artifacts and logs.
`~/.local/share/ispy-discord/releases/journal.json` tracks current and pending
versions. A process lock serializes publishers. Restart reconciles interrupted
uploads, rolling back unverified deployments before accepting new work. An
ambiguous upload or an unexpected external deployment fails closed for review.

This is an automated regression gate, not a proof of game quality or data
compatibility. New storage formats and migrations need review. Public-network
access remains available to the trusted live smoke browser so it can inspect the
published site; its local credential and write restrictions still apply.

## Operational boundaries

- One coding request or release runs at a time; follow-ups visibly queue.
- On restart, channel history after the latest saved message is recovered in order
  and deduplicated against messages delivered while reconnecting.
- Questions use normal messages. Attachments alone and voice notes request text.
- A protected change leaves edits saved and reports Needs Ivan's review. Follow-up
  messages can resolve the design; they do not bypass the release policy.
- An ordinary coding reply is never enough to mark a release live.
- Status is refreshed during checks. If the whole Mac or network goes offline,
  Discord's offline presence and the last timestamp are the available signals.
- Output delivery is at least once: a crash just after delivery can duplicate a
  reply, but does not replay the coding task.
- Expired Cloudflare or Codex authentication needs Ivan to reconnect locally.
- Existing tests cannot be weakened by the agent. Owner-approved policy changes
  should be reviewed in this controller and committed in the source baseline.

## Verification

`npm test`, `npm run typecheck`, and `npm run build` cover the bridge. The family
suite exercises authorization, deduplication, queueing, stopping, disconnections,
retry, output delivery, conversational questions, blocking tool questions, stale
turn events and durable storage. A separate live app-server smoke check validated
thread initialization, health and a schema-constrained final reply without edits.
A real Discord exchange is still required when installing a new bot/channel.

Live installation verified on 2026-09-09: Gengar joined ivandreat, received
channel-specific access to daddy-game, and the launchd service started successfully.
A real message from the allowed Ivan account produced a Working card with Stop,
then a Done card and the final assistant reply. The setup check made no game-file
changes. The service was left running. Automatic production releases were added after this initial installation test.


Release verification on 2026-09-09: all 14 gameplay loops passed, as did format,
types, lint, boundaries, unit tests, bundle, production smoke, and bug-report
checks. A documentation-only release was published by the controller, verified
on the live origin (including offline reload), and successfully undone through
the real Cloudflare rollback endpoint. Live index and service-worker bytes and
source restoration were verified. The family game was left on its original live
version; the new automatic publisher was enabled in the launchd service.

The bridge tests additionally cover release policy, ambiguous uploads, crash
recovery, source-safe Undo, publishing locks, completed-release recovery,
background checking and Stop. Run the opt-in local boundary and new-game contract
checks with `scripts/check-release-boundary.mjs` and
`scripts/test-release-scenarios.mjs` after building. These print only access results,
never credential contents.
