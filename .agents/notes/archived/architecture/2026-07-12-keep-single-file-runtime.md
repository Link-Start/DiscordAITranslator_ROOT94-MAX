# Agent Note: Keep the single-file runtime during early refactors

Status: implemented
Archived: 2026-09-17

## Problem

Users install `DiscordAITranslator.plugin.js` by direct download. Mixing architectural extraction with a new packaging/loading model during early stabilization would make regressions harder to diagnose and could produce a refactor that passed repository tests but failed in BetterDiscord.

## Decision

Keep the shipped single-file runtime entry point during the early refactor program. Internal extraction and compatibility wrappers may preserve that behavior. Build-system changes were outside those first passes; generated output required a separate decision and independent build verification.

This record preserves former ADR-0001, first recorded on 2026-07-12 in the original repository. Its temporary build deferral was superseded by [modular source and deterministic generation](../../implemented/architecture/2026-07-13-generate-single-file-plugin.md), which carries forward the user installation contract and independent packaging gate.

## Alternatives

Changing packaging during the same early architecture pass was deferred because it combined two regression risks. The old record did not enumerate other alternatives.

## Consequences

Runtime behavior remained comparable to the existing release. Early refactors preferred internal extraction and compatibility wrappers; build-system work needed a separately verified migration. This is frozen history, not an instruction to hand-maintain the generated plugin now.

## References

- [Successor decision](../../implemented/architecture/2026-07-13-generate-single-file-plugin.md)
