# Family game conversation

A dedicated channel receives ordinary text messages from the configured parents.
Each request is saved before acknowledgment, gets one editable status message, and
runs in one persistent Codex conversation. Follow-ups are visibly queued during
coding and publishing. Once an unpublished draft is available, a follow-up pauses
its checks and continues the conversation after process cleanup. Stop
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
   directory. Runs the controller-owned `scripts/release-checks.mjs` in a macOS sandbox
   without publishing credentials, controller write access, or public network
   access. The quick phase runs formatting, code checks, one build, and a shallow
   phone-browser open/back check of affected games. The controller then uploads
   the static artifact to the non-production `gengar-preview` branch and verifies
   its immutable deployment URL before showing it on the status card.
   The full phase reuses that build and preserves all existing game, scenario,
   production and bug-report checks, with changed games first. The tested game
   bytes must match the draft artifact before production can be published.
   A changed verification command or game-check inventory fails closed until
   the trusted plan is updated.
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
During local checks it names the attempt and current stage/game. Last progress
reflects a stage start or completion, not the five-second status refresh. Each
game has an eight-minute limit; other stages have five-minute limits and preview
startup has thirty seconds. The complete check runner has a 35-minute ceiling.
Timeouts and recognized unavailable-browser errors pause for Retry without asking
Codex to edit game code. Retry reruns the saved candidate without a new coding
turn only when both its source tree and baseline are unchanged. Otherwise it asks
for owner review. Results include per-stage timings in the candidate source
directory (`.gengar-check-timings.json`). Checks still run sequentially, and a code
repair still reruns the checks on a fresh build. The full suite currently takes
about 15 minutes; changed-game failures should now surface earlier. Stop before upload prevents publishing; Stop after upload
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

Pipeline update verified on 2026-09-09: 147 bridge tests, typecheck, and build
passed. The reordered runner passed all 20 stages, including all 14 games, against
a disposable copy of the published game in the production macOS checking sandbox
(876 seconds). Potty Time ran first; no deployment occurred during validation.
The idle service then restarted cleanly and reconnected to Discord.

## Draft feedback loop

Parents can use **Try this draft** as soon as quick checks and the preview upload
finish, while the full suite continues. This is an unlisted Cloudflare Pages
preview URL, not an authenticated private site. Every deployment has its own
origin, so browser saves in a draft are separate from production and other drafts.
The usual game link is unchanged until full verification and automatic publishing
finish. There is no extra approval button.

Any follow-up while a draft is checking pauses that unpublished iteration. The
bridge waits for its processes to exit, then gives Codex the original request,
latest feedback and saved edits. Draft questions are answered before resumed
release checks finish. Follow-ups during upload/live verification queue until the
publish-or-rollback transaction finishes. Superseded status cards retain their
old draft link, clearly marked, and cannot be retried or stopped again.

This first version reruns quick/full checks after a follow-up; it does not cache
successful browser checks across iterations. The shorter feedback loop comes
from sharing the draft early, not removing production coverage. The quick browser
check proves opening/rendering/back navigation and absence of browser errors;
it is not an exhaustive test of the requested feature. Real timing, device and
saved-state coverage remains in the full phase.

Runtime checks use a pinned Homebrew tool PATH. Phase timings are saved alongside
the candidate. Draft-hosting failures pause for Retry rather than prompting code
repairs. Preview branch equality with production, unexpected URLs, source changes,
and changed build bytes all fail closed. Preview uploads never update the
production journal or Undo baseline.

Draft-loop validation on 2026-09-09: 163 bridge tests, typecheck and build passed.
A disposable copy of the current game passed quick checks in 29 seconds, was
uploaded to an immutable preview URL, and passed a browser check at that URL.
All 14 games and the other full-phase checks then passed in 849 seconds. The
post-test build hashes matched the preview artifact, and production was unchanged.
Cloudflare returned `X-Robots-Tag: noindex` on the preview. The idle bridge restarted
cleanly and reconnected after activation. No synthetic Discord request was sent.

## Real Discord preview-flow test (2026-09-10)

A real request in daddy-game exposed a domain-validation bug: the Cloudflare
project name is `ispy`, but its assigned subdomain is `ispy-f39.pages.dev`.
Preview validation now uses the authenticated project's `subdomain` field,
with HTTPS/host checks retained. The regression test and all 164 bridge tests,
typecheck, and build pass. The service was rebuilt and restarted with this fix.

The first rejected request remained in review; asking to continue unchanged
saved work did not trigger a release. For the clean retest, only the two test
color edits were restored before sending a fresh Discord request. This review
recovery limitation remains; it is distinct from the working in-flight draft
follow-up path.

The clean test changed only Pizza Kitchen's shell background and wall fill.
The lavender draft appeared about 74 seconds after the Discord request at
https://88187000.ispy-f39.pages.dev. While its full checks ran, a Discord
question plus mint revision stopped the old checks, marked the old draft
superseded, preserved the original baseline, and delivered the answer before
full verification. The revised draft appeared at
https://3933ecb0.ispy-f39.pages.dev. Headless browser checks confirmed both
colors, the old draft stayed immutable, and production remained unchanged
until publishing. Fresh-context storage probes confirmed separate localStorage
for preview and production origins.

The revised quick stages took 32 seconds. All 14 games plus interaction,
production-browser, and bug-report checks passed in 856 seconds, with no repairs
or retries. Automatic production publishing and the controller's live check
completed; an independent headless browser confirmed mint on the usual URL.
The production transaction was
`c3056ec5-f7b5-4fc6-a8f9-4f469ead449a-1789054649321`, deployment
`291a4ad9-3c54-46f5-a6c1-097ef57dbdc0`. Its saved Undo target is the original
`12127887f21567cd630f802abfc48299689fb679` / deployment
`c776c2e6-4397-4eeb-ba68-0d0cbea134e1`, including the parent's Potty Time change.
After Ivan authorized desktop control, the latest Discord Undo button restored
the exact original commit and deployment above. The bridge confirmed restoration,
the game workspace was clean, and an independent headless browser verified the
original cream background and wall fill on production. The full Discord cycle
(request, draft, question/revision, publish, Undo) is verified.
