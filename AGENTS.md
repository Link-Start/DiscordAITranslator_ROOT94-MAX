# Repository Instructions

## Authority

Use project information in this order:

1. `docs/product.md` for user-visible behavior.
2. `docs/settings.md` for channel and global setting ownership.
3. `docs/providers.md` for translation and detection provider contracts.
4. `docs/architecture.md` for current code boundaries and migration rules.
5. `docs/recovery-plan.md` for incomplete work and implementation order.
6. Automated tests and the current runtime for behavior not yet documented.

Do not infer completion from deleted PRDs, issue files, archived documents, or old conversation summaries.

## Non-Negotiable Rules

- Preserve useful behavior unless `docs/product.md` explicitly replaces it.
- Ship one installable `DiscordAITranslator.plugin.js` file for BetterDiscord users.
- A future `src/` split must generate that single distribution file deterministically.
- Channel state, received translation cache, reply previews, queues, and display cleanup remain channel-isolated.
- The right-click input-box translator icon controls only the current channel.
- Provider credentials, endpoints, models, and the backup provider remain global.
- Do not add duplicate controls to the channel popout and BetterDiscord settings.
- Add a failing regression test before every runtime bug fix or behavior change.
- Run `npm run verify` before deployment.
- Back up the installed plugin before copying a new version into BetterDiscord.

## Repository Hygiene

- Keep README user-facing.
- Keep one canonical document per concern.
- Archive obsolete material outside the repository instead of keeping `old`, `backup`, or numbered planning copies in Git.
- Do not commit local assistant configuration, generated coverage, deployment backups, or BetterDiscord data.
- Do not mark recovery-plan items complete without verification evidence.
