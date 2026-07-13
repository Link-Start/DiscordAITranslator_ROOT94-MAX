# ADR-0001: Keep single-file plugin runtime during early refactors

## Status

Superseded by [ADR-0002](0002-generate-single-file-plugin-from-modular-source.md).

## Context

This repository distributes a BetterDiscord plugin whose user-facing install path is a direct download of `DiscordAITranslator.plugin.js`.

The codebase needs architectural improvement, but an early refactor that changes the runtime packaging model would mix two risks at once:

1. architectural changes
2. distribution and loading changes

That would make regressions harder to diagnose and would raise the chance of shipping a refactor that works in-repo but fails for end users.

## Decision

During the early refactor program, keep `DiscordAITranslator.plugin.js` as the shipped runtime entry point.

Architectural extraction is allowed, but only if it preserves the single-file runtime behavior seen by BetterDiscord users. A generated or bundled output requires a separate ADR and independent build verification.

## Consequences

- Early refactors should prefer internal module extraction and compatibility wrappers over immediate packaging changes.
- Build-system changes are explicitly out of scope for the first architecture passes.
- Runtime behavior remains easy to compare against today's release model.
