# Architecture Migration Plan

> This is the only repository implementation sequence. Detailed task steps are written only after the architecture design is reviewed and approved.

**Goal:** Replace the coupled single-file implementation with modular source while preserving one installable BetterDiscord plugin and all approved behavior.

**Current status:** Architecture design prepared. Runtime migration has not started.

## Current Verified Failures

The deployed runtime still has unresolved Discord display regressions:

- Stored translations may appear only after hovering a message.
- Disabling automatic translation may leave translated text visible.
- Translated text and translated watermark/styling may update separately.
- A visually untranslated item cannot currently be distinguished from a skipped, failed, pending, or unrendered item without internal inspection.

No phase that claims to solve these behaviors is complete until DiscordPTB verification observes the result.

## Noise Policy

- Keep one document per concern: product, settings, providers, architecture, and migration plan.
- Do not add recovery copies, numbered planning documents, conversation summaries, or local issue files to Git.
- Do not delete runtime code merely because it looks old. First identify its behavior, replace it behind a tested module interface, verify parity, then delete it in a separate commit.
- Do not retain compatibility wrappers after all callers have migrated and the replacement has passed release gates.
- Keep deployment backups and archived material outside the repository.

## Program Rules

1. Freeze new features until the display vertical slice is stable.
2. One phase changes one ownership boundary.
3. Every phase starts with a failing regression or characterization test at the correct interface.
4. Every commit remains buildable, installable, and reversible.
5. The generated plugin remains the only BetterDiscord install artifact.
6. Automated tests cannot complete a Discord rendering phase without the required DiscordPTB smoke checks.
7. Every translated, skipped, failed, or cancelled message has an inspectable terminal reason.
8. No new global runtime map may duplicate state already owned by a target module.

## Phase 0: Architecture Baseline

- [ ] Approve `docs/architecture.md` as the target design.
- [ ] Accept ADR-0002 and supersede the hand-maintained runtime restriction in ADR-0001.
- [ ] Capture the current deployed plugin hash, version, failing screenshots, and reproduction steps outside the repository.
- [ ] Convert the hover-only display, disable restoration, and missing-decoration reports into red-capable feedback loops.
- [x] Confirm the current repository contains no tracked backups, generated coverage, assistant configuration, or duplicate plans.

**Exit gate:** The architecture and failure reproductions are reviewable before runtime code changes.

## Phase 1: Deterministic Build Skeleton

- [ ] Add esbuild and a locked development dependency version.
- [ ] Add `scripts/build-plugin.mjs` with deterministic metadata and CommonJS output.
- [ ] Add `src/plugin/index.js` as the source entry point.
- [ ] Generate the root `DiscordAITranslator.plugin.js` without changing runtime behavior.
- [ ] Add build-contract tests for metadata, one-file output, deterministic bytes, and exclusion of tests/debug code.
- [ ] Update `npm run verify` to build first and reject an out-of-date generated plugin.

**Exit gate:** A clean checkout deterministically regenerates an installable plugin identical to the committed artifact.

## Phase 2: Display Vertical Slice

- [ ] Add `MessageStateStore` with immutable source snapshots and explicit statuses.
- [ ] Add `TranslationDisplayController` with one transaction for text, decoration, loading, and restoration.
- [ ] Add `DiscordRenderAdapter` that reports requested and confirmed message IDs.
- [ ] Route one received-message vertical slice through the new modules.
- [ ] Add regressions proving translations appear without hover.
- [ ] Add regressions proving disabling restores original text and removes translated decoration together.
- [ ] Add regressions proving a translated message cannot render without its watermark/styling state.
- [ ] Verify typing and scrolling remain stable during one display transaction.

**Exit gate:** The current reported display failures pass automated contracts and DiscordPTB smoke checks before the old display path is removed.

## Phase 3: Message Lifecycle Ownership

- [ ] Route reply previews and embeds through the display controller.
- [ ] Route thread and forum titles through channel-owned display state.
- [ ] Move edit invalidation and sent-original recovery to immutable source snapshots.
- [ ] Move channel disable, channel switch, plugin stop, and reload cleanup to generation-bound lifecycle operations.
- [ ] Delete the replaced legacy display maps and cleanup branches in a separate commit.

**Exit gate:** Messages, replies, embeds, titles, edits, disable, stop, and reload share one state owner and pass channel-isolation tests.

## Phase 4: Translation Orchestration

- [ ] Add `TranslationOrchestrator` as the only caller of policy, queues, providers, cache, and display commits.
- [ ] Move the live queue behind its module interface.
- [ ] Move `HistoricalTranslationJob` behind its module interface without changing its state-machine contract.
- [ ] Make historical jobs return structured terminal results and remove direct rendering knowledge.
- [ ] Add per-message reason codes for translated, skipped, failed, and cancelled states.
- [ ] Add latency measurements for queue, provider, validation, commit wait, and render acknowledgement.

**Exit gate:** Live and historical paths share result types and observability but retain their accepted interaction behavior.

## Phase 5: Providers And Policies

- [ ] Add the shared provider client for timeout, retry, backoff, error normalization, and placeholder validation.
- [ ] Move each provider adapter independently with parser and connection-contract tests.
- [ ] Move received, sent, language detection, prompt, protection, and result validation policies.
- [ ] Remove duplicated request and response handling after every provider uses the shared interface.

**Exit gate:** Provider migration preserves provider-specific schemas, channel provider overrides, global backup behavior, and all current language policies.

## Phase 6: Settings And Persistence

- [ ] Add versioned settings, channel settings, provider credentials, and translation cache stores.
- [ ] Move all compatibility reads into one migration entry point.
- [ ] Preserve channel/global ownership defined in `docs/settings.md`.
- [ ] Remove obsolete persistent keys only after a verified migration release.
- [ ] Route channel popout and BetterDiscord settings through the same typed settings interfaces.

**Exit gate:** Existing user data migrates without losing credentials, languages, channel enablement, or provider overrides.

## Phase 7: Legacy Removal And Repository Cleanup

- [ ] Confirm every legacy runtime responsibility has one replacement owner.
- [ ] Delete superseded inline implementations and compatibility wrappers.
- [ ] Consolidate duplicated test setup while retaining behavior coverage.
- [ ] Enforce module and generated-artifact size guardrails.
- [ ] Confirm release output contains no tests, debug journal, local configuration, or deployment data.
- [ ] Update canonical documentation to describe the implemented architecture rather than the migration.

**Exit gate:** Production source is modular, the generated plugin remains below the agreed size guardrail, and no duplicate runtime path remains.

## Required Verification For Every Phase

1. Focused red-green regression tests.
2. `npm run verify` with zero failures.
3. Standards and specification review with no unresolved P0-P2 finding.
4. Timestamped backup before BetterDiscord deployment.
5. Repository and installed SHA-256 equality.
6. Renderer log inspection after hot reload.
7. The phase-specific DiscordPTB smoke checks.
8. One small commit containing only that phase.

## DiscordPTB Smoke Gate

- [ ] Translation appears without hovering the message.
- [ ] Translated text and translated decoration appear together.
- [ ] Disabling the current channel restores original messages, replies, embeds, and title.
- [ ] The current-channel switch does not affect another channel.
- [ ] One historical job reveals all validated translations in one visible commit.
- [ ] Live messages translate while a historical job is running.
- [ ] Typing remains uninterrupted.
- [ ] Scrolling and dragging remain under user control.
- [ ] Scroll-loaded messages form the next bounded job.
- [ ] Short foreign words translate when source and target differ.
- [ ] Edited received and sent messages use the current immutable source.
- [ ] Stop and reload restore originals and reject late callbacks.
- [ ] Every missing translation has a visible pending, skipped, failed, or cancelled reason.

No release or phase is complete while its required smoke checks remain unverified.
