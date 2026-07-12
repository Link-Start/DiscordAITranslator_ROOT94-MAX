# Recovery Plan

> **For agentic workers:** Execute this plan task by task with test-driven development. Keep the BetterDiscord distribution installable after every phase.

**Goal:** Stabilize automatic translation, eliminate silent message loss and stale display state, complete the approved product backlog, then split the source without changing the single-file distribution contract.

**Architecture:** Live messages and loaded historical messages use separate paths. Historical messages are owned by one channel-scoped, ID-keyed job that may use multiple transport requests internally but performs one atomic display commit. Lifecycle generation tokens prevent late callbacks from mutating stopped, disabled, switched, or edited sessions.

**Tech Stack:** BetterDiscord, BDFDB, JavaScript, Node.js built-in test runner.

## Why Regressions Keep Returning

The current work is a large uncommitted change set on top of `master`. Runtime behavior, architecture extraction, settings migration, documentation, and tests changed together without stable commit checkpoints.

The historical translation path is controlled by many shared closure variables, timers, maps, and boolean flags. It currently has multiple competing completion paths: progressive staging flush, final batch completion, and delayed post-batch rescanning. Tests frequently replace internal plugin methods, so they can pass while the real provider, queue, cache, and Discord render path is wired incorrectly.

## Recovery Rules

1. Freeze behavior changes until the current state is checkpointed.
2. One phase changes one behavior or extracts one module, never both.
3. Every asynchronous translation job has an identity and generation token.
4. Late results from cancelled jobs are discarded.
5. No message is silently dropped. Every item ends as translated, legitimately skipped, failed with a visible reason, or cancelled.
6. Tests remain outside the BetterDiscord distribution and are not loaded by Discord.
7. Remove obsolete or duplicate tests only after replacement coverage exists.

## Historical Translation Contract

Historical messages within the configured count form one logical `HistoricalTranslationJob`.

```text
collecting -> translating -> repairing -> ready -> committed
                                    \-> cancelled
```

Each job owns:

- Job ID and channel ID
- Configuration generation and provider selection
- Immutable message snapshots keyed by Discord message ID
- Original-content signature for every message
- Per-item state: pending, translated, skipped, retrying, failed, or cancelled
- Validated translated content and protected-placeholder metadata
- Attempt count and provider error information

Provider requests may be internally split to respect item, character, timeout, and rate-limit constraints. This internal splitting must not change display behavior.

Before commit, the job validates:

- Every returned ID belongs to the request
- No duplicate IDs exist
- Missing or empty results enter repair
- Protected placeholders are complete and unchanged
- The target language is plausible
- The source message and settings signature are still current

Repair order:

1. Retry missing items in a smaller primary-provider request.
2. Retry unresolved items one at a time with plain translation instructions.
3. Use the configured backup provider.
4. Mark unresolved items failed with a visible count and retry action; never cache them as successful or silently skipped.

When all items reach a terminal state, commit valid translations to cache and display state together, then request exactly one Discord message-list rerender. Live new messages use a separate live path and never wait for a historical job.

### Accepted Interaction Rules

- New messages translate immediately through the live path, even while a historical job is running.
- The configured loaded-message count is the maximum candidate count for one historical job.
- Messages loaded by scrolling upward never join an immutable running job. They form the next job after scrolling becomes idle.
- Historical network work may continue while the user types or scrolls, but display commit waits until recent input and scrolling activity are idle.
- A historical job performs exactly one message-list rerender when it commits.
- A live message performs at most one completion rerender and never triggers a historical rescan.
- Every queued received message renders one CSS-animated loading icon beside its content or translation watermark. CSS animation must not require timer-driven React rerenders.
- Loading icons disappear only when the item is translated, legitimately skipped, failed, or cancelled.
- Changing channel, disabling automatic translation, editing source content, or stopping the plugin invalidates the relevant job generation. Late results are discarded.
- Failed items remain original and are reported in the job status. They are never silently cached as skipped.

## Target Modules

The repository keeps one installable `DiscordAITranslator.plugin.js`, generated from source modules.

```text
src/runtime/historical-translation-job.js
src/runtime/live-translation-queue.js
src/runtime/translation-cache.js
src/display/message-display.js
src/display/discord-render-adapter.js
src/lifecycle/message-edit-adapter.js
src/lifecycle/plugin-stop-adapter.js
src/providers/provider-registry.js
src/providers/batch-response-validator.js
```

`HistoricalTranslationJob` is the first deep module. Its interface should accept a message snapshot and dependencies, then return one commit result. Callers must not manage its timers, retries, staging maps, or per-item flags.

## Execution Phases

## Recovery Baseline

- Date: 2026-07-12
- Branch: `codex/two`
- Baseline commit: `85ad579`
- Source version: `0.3.36`
- Installed version: `0.3.36`
- Source and installed SHA-256: `BB7D28268101174CE791F2F9D4AD30A44A47AF63F1AE645A3049AF11C4D6829F`
- Baseline limitation: historical translation still uses shared global batch state and progressive request-block display.

### Phase 0: Safe Baseline

- [x] Checkpoint the current repository and deployed plugin on the current recovery branch.
- [x] Record the exact BetterDiscord file hash and installed version.
- [x] Stop version bumps until a phase passes all gates.
- [x] Add a manual Discord smoke-test checklist to this document.

### Phase 1: Characterization

- [ ] Replace the progressive-display test with an atomic-commit test that asserts exactly one rerender.
- [ ] Add real parser tests for unknown, duplicate, missing, empty, and malformed IDs.
- [ ] Add a persistent skip-cache version test using pre-existing user data.
- [ ] Add render-node reuse coverage that starts with translated CSS class and color variables.
- [ ] Add integration coverage for channel switching, channel disable, plugin stop, edits, scroll-loaded messages, and short words.
- [ ] Unskip historical entry-flow and scroll-order tests before implementation is considered complete.

### Phase 2: Historical Job

- [ ] Introduce one channel-scoped `HistoricalTranslationJob` interface without changing the live path.
- [ ] Move snapshot IDs, item states, staging results, attempts, counters, and generation into the job.
- [ ] Replace rerender-driven rescanning with explicit visible-message collection.
- [ ] Validate response IDs and protected placeholders before accepting any result.
- [ ] Repair unresolved items with smaller batches, forced single translation, then the global backup provider.
- [ ] Commit cache and display state only when all items are terminal and the source signatures are current.
- [ ] Wait for typing and scroll idle before one atomic rerender.
- [ ] Remove progressive flush, attempted-message maps, post-batch rescan scheduling, and superseded batch globals.

### Phase 3: Message Lifecycle

- [ ] Invalidate old snapshots and cache entries when another user edits a message.
- [ ] Re-translate edited received content using a new signature.
- [ ] Restore editable original text for sent messages and translate the replacement after submit.
- [ ] Restore original messages, replies, and embeds on plugin stop.
- [ ] Ignore every late provider callback after stop, disable, channel switch, or source edit.

### Phase 4: Translation Correctness

- [ ] Guarantee short conversational words enter translation when source and target differ.
- [ ] Separate translation instructions from skip decisions.
- [ ] Version the skip-decision cache and invalidate incompatible old entries.
- [ ] Validate protected placeholders and glossary terms after every provider response.
- [ ] Remove translated classes, variables, watermark, and injected blocks when no active translation exists.
- [ ] Add completeness checks for batch results.

### Phase 5: Providers And Settings

- [ ] Add an official OpenAI adapter for OpenAI API models.
- [ ] Add a native Gemini adapter using Gemini request and response schemas.
- [ ] Retain a clearly named OpenAI-compatible adapter for third-party and self-hosted endpoints.
- [ ] Keep Google Free keyless and Google Cloud responsible for official API keys.
- [ ] Add the language detection strategy selector with local detection and Google Free fallback.
- [ ] Remove the duplicate global language detection helper while retaining global detection strategy settings.
- [ ] Consolidate overlapping display settings under one canonical key per behavior.
- [ ] Update English metadata and the repository-linked author field.

### Phase 6: Remaining Product Coverage

- [ ] Translate forum and thread titles with the current channel configuration.
- [ ] Profile provider latency, queue latency, validation latency, commit wait, and Discord render latency separately.
- [ ] Add the CSS-only per-message loading indicator for live and historical work.
- [ ] Complete repository documentation and remove obsolete runtime branches.

### Phase 7: Cleanup

- [ ] Generate the single installable plugin file deterministically from `src/`.
- [ ] Remove superseded inline implementations.
- [ ] Consolidate duplicated test setup and delete obsolete tests only when replacement coverage passes.
- [ ] Keep high-value contract, state-machine, parser, lifecycle, and integration tests in the repository.
- [ ] Confirm test files are excluded from the BetterDiscord artifact and do not affect runtime size.

## Manual Discord Smoke Checklist

- [ ] Current-channel right-click toggle does not affect another channel.
- [ ] Live messages translate while a historical job is running.
- [ ] Every queued item shows a loading icon without visible layout movement.
- [ ] One historical job reveals all validated translations in one refresh.
- [ ] Typing remains uninterrupted during network work and commit.
- [ ] Dragging or scrolling remains stable; commit waits until idle.
- [ ] Scrolling upward creates the next bounded job without reprocessing the previous job.
- [ ] `hi`, `ok`, and other short foreign words translate when target language differs.
- [ ] Same-language messages retain normal Discord styling.
- [ ] Editing a received message replaces the stale translation.
- [ ] Editing a sent translated message starts from the original editable text.
- [ ] Disabling a channel during a request prevents late results from appearing.
- [ ] Switching channel during a request cannot contaminate the new channel.
- [ ] Stopping and reloading the plugin restores original message, reply, and embed content.
- [ ] Forum and thread titles follow the current channel translation setting.

## Release Gate

Every phase requires:

1. Focused red-green regression tests.
2. `npm run verify` with zero failures.
3. Real provider response parsing tests.
4. Deployment with a timestamped backup and matching SHA-256.
5. DiscordPTB checks for channel toggle, atomic historical reveal, short words, message edits, channel switching, plugin stop, and reload.
6. A small commit containing only that phase.

No release is complete while required manual Discord checks are unverified.
