# ADR-0002: Generate The Single-File Plugin From Modular Source

## Status

Proposed

## Context

The shipped plugin has grown to approximately 10,700 lines and 618 KB. Translation policy, provider transport, runtime queues, settings, persistence, Discord patches, display state, and lifecycle cleanup are physically coupled in one hand-maintained file.

The direct-download BetterDiscord installation contract remains valuable, but hand-maintaining the distribution file prevents clear module ownership, reliable build verification, and safe deletion of replaced code.

ADR-0001 intentionally deferred build-system work during early stabilization. The project now requires modular source to address recurring display regressions and make later provider, queue, and settings changes local and testable.

## Decision

Maintain readable production source under `src/` and generate one root `DiscordAITranslator.plugin.js` file with a deterministic esbuild script.

The generated file remains the only user-installed runtime artifact. BetterDiscord users do not install the `src/` tree or any runtime dependency.

The build must:

- Preserve the BetterDiscord metadata header
- Produce CommonJS output compatible with the current BetterDiscord runtime
- Exclude tests, local diagnostics, source maps, credentials, and development configuration from the release artifact
- Produce identical bytes from identical source and lockfile inputs
- Fail verification when the committed artifact is out of date

## Consequences

- Developers edit `src/`; they do not hand-edit the generated plugin after migration begins.
- Module interfaces become the primary test seams.
- Packaging and runtime behavior are verified independently.
- Every migration commit still produces one installable BetterDiscord file.
- The repository adds a build dependency and lockfile that must be reviewed and maintained.
- Source extraction occurs incrementally; the current runtime is not deleted until generated replacements pass automated and DiscordPTB gates.
