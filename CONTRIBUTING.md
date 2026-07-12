# Contributing

## Requirements

- Node.js 20 or newer
- Discord or DiscordPTB with BetterDiscord
- BDFDB Library installed in BetterDiscord

## Development Workflow

1. Read `docs/README.md` and the relevant canonical document.
2. Reproduce the behavior with a focused test.
3. Run the test and confirm it fails for the expected reason.
4. Implement the smallest behavior change.
5. Run the focused test, then `npm run verify`.
6. Review the diff for unrelated settings, documentation, and metadata changes.
7. Back up and deploy the plugin for a Discord smoke test when runtime behavior changed.

## Commands

```powershell
npm run check
npm test
npm run verify
```

Run one test file:

```powershell
npm test -- tests/channel-primary-engine-regression.test.js
```

## Release Metadata

The BetterDiscord `@version` header in `DiscordAITranslator.plugin.js` is the runtime version source. Keep `package.json`, `README.md`, and `CHANGELOG.md` aligned with it.

The distributed plugin metadata must use an English description and include the repository through `@authorLink`, `@website`, or `@source` metadata.

## Deployment

The installed development copy is normally:

```text
%AppData%\BetterDiscord\plugins\DiscordAITranslator.plugin.js
```

Before replacing it:

1. Copy the installed file to the repository-external archive.
2. Copy the verified runtime file into the BetterDiscord plugin directory.
3. Compare SHA-256 hashes.
4. Confirm the version and basic behavior in DiscordPTB.

Do not commit deployment backups to this repository.
