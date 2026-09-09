# Changes through Gengar

In Discord's daddy-game channel, describe a bug, an improvement, or a new game.
Gengar acknowledges the request, prepares the change, checks the full game library,
and publishes successful changes to the usual game address. Its status message
shows Working, Checking, Publishing, Checking live game, and Done. Follow-up
requests are queued. Stop cancels checking; if publishing has started, Gengar
finishes verification or restores the previous version before stopping.

After a release, Undo restores the preceding version. Saved creations remain on
the same origin. Refresh, or close and reopen the installed app, to get an update.
Devices need a connection to download an update; downloaded games still work offline.

## Automatic change boundary

Game code, art, styles, documentation, and new game registrations can change.
Existing games and their tests must remain. Deployment settings, dependencies,
shared storage, service workers, and changes to stored data require Ivan's review.
The coding agent cannot read publishing credentials or edit the release controller.
Checks and publishing run separately from the coding agent.

New games must include a data-only gameplay scenario in
`release-checks/<game-id>.json`. `game` is the exact library tile label. Steps use
CSS selectors and the actions `click` and `expectVisible`. Include a real gameplay
interaction and finish by checking its visible result. For example:

```json
{
  "game": "My New Game",
  "steps": [
    { "action": "click", "selector": "button[aria-label='Start playing']" },
    { "action": "expectVisible", "selector": "[data-game-state='playing']" }
  ]
}
```

The controller also runs all existing gameplay, offline, persistence, build, and
layout checks. Automated checks catch regressions; the family still judges whether
an idea feels good to play. A failed check gets up to two repair attempts. A change
that cannot pass stays unpublished with its work saved.
