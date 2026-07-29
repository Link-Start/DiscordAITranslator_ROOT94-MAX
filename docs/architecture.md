# Architecture

## Status

This document defines the approved target architecture for the repository. The migration has not started until `src/` and the deterministic build exist in Git.

The current shipped runtime remains `DiscordAITranslator.plugin.js`. It is approximately 10,700 lines and 618 KB. It must remain installable while the source architecture is migrated.

## Distribution Contract

BetterDiscord users install exactly one file:

```text
DiscordAITranslator.plugin.js
```

The repository will contain readable source modules under `src/`. A deterministic build will bundle those modules into the root plugin file. The generated plugin is a distribution artifact and must not be edited manually after the migration begins.

The build contract is:

```text
src/plugin/index.js
        -> scripts/build-plugin.mjs
        -> DiscordAITranslator.plugin.js
```

The build uses esbuild in CommonJS bundle mode with an ES2020 runtime target, preserves the BetterDiscord metadata banner, excludes tests and release-disabled diagnostics, and produces the same bytes from the same source and dependency lockfile.

## Current Architecture

The current single file contains useful logical modules, but they share closure state and one plugin class:

- Provider registry and provider-specific request code
- Sent and received translation policies
- Live and historical translation queues
- Translation cache and skip cache
- Channel enablement and channel provider overrides
- Message, reply, embed, and thread-title display patches
- BetterDiscord settings and channel popout UI
- Plugin lifecycle and cleanup

The central mutable maps are `translatedMessages`, `oldMessages`, queue records, reply-preview records, channel title records, and several generation counters. They are not owned by one module.

## Confirmed Architectural Failure

Translation data and visible Discord output currently have different owners.

`Messages` can replace message text, while `MessageContent` independently adds translated styling and the watermark. Reply previews, embeds, and thread titles use additional patch paths. A translation can therefore reach any partial state:

- Translation exists in memory but the visible message did not rerender
- Translated text is visible without the translated watermark
- The watermark refreshes while the text remains stale
- Automatic translation is disabled but the old translated React props remain visible

The regression was exposed when a full message-list rerender was replaced with targeted component updates. Unit tests verified the update function call, but not the visible Discord result. Hovering a message causes Discord to rerender that component naturally, which reveals already-stored translation data.

The new architecture must treat a data commit and a visible render commit as separate, observable operations.

## Design Principles

1. One module owns the complete display state for every message.
2. Original Discord content is captured as an immutable snapshot and is never reconstructed from translated props.
3. Translation policy, provider transport, state commit, and Discord rendering are separate modules.
4. Message text, translated decoration, loading state, and original restoration are committed through one display transaction.
5. Runtime state is channel-isolated and generation-bound.
6. Every item ends as translated, skipped with a reason, failed with a reason, or cancelled.
7. Discord adapters may read and clone Discord objects, but domain modules never mutate Discord store objects.
8. Tests exercise module interfaces and rendered output contracts, not only internal function calls.
9. One migration phase changes one ownership boundary and remains deployable.
10. Legacy code is deleted only after the replacement passes automated and DiscordPTB verification.

## Target Source Layout

```text
src/
  plugin/
    index.js
    lifecycle.js
    discord-patches.js

  display/
    message-state-store.js
    translation-display-controller.js
    discord-render-adapter.js
    message-display-adapter.js
    reply-display-adapter.js
    embed-display-adapter.js
    thread-title-display-adapter.js

  translation/
    orchestrator.js
    received-policy.js
    sent-policy.js
    language-detection.js
    prompt-policy.js
    result-validator.js

  runtime/
    live-translation-queue.js
    historical-translation-job.js
    translation-cache.js
    lifecycle-generation.js

  providers/
    provider-registry.js
    provider-client.js
    google-free.js
    google-cloud.js
    deepl.js
    microsoft.js
    openai.js
    gemini.js
    openai-compatible.js

  settings/
    schema.js
    migrations.js
    settings-store.js
    channel-settings.js
    global-settings.js

  protection/
    placeholders.js
    protected-terms.js

scripts/
  build-plugin.mjs

tests/
  display/
  translation/
  runtime/
  providers/
  settings/
  integration/
```

The target is 25-35 production modules. Normal modules should remain under 400 lines, no production module should exceed 500 lines without an explicit architecture review, and `src/plugin/index.js` should remain under 250 lines.

## Core Message State

`MessageStateStore` is the only owner of translated message display state.

```js
{
  messageId: "123",
  channelId: "456",
  generation: 4,
  source: {
    content: "Hello",
    embeds: []
  },
  status: "translated",
  translation: {
    content: "你好",
    inputLanguage: "en",
    outputLanguage: "zh-CN"
  },
  reason: null,
  origin: "automatic"
}
```

Allowed statuses are:

```text
idle -> pending -> translating -> translated
                              \-> skipped
                              \-> failed
                              \-> cancelled
```

The `source` snapshot is immutable. A translated result never overwrites it. Disabling automatic translation changes what is rendered; it does not need to recover content from a previously mutated Discord object.

## Deep Module Interfaces

### MessageStateStore

Owns immutable source snapshots and current display state.

```text
captureSource(snapshot)
markPending(messageId, requestIdentity)
commitResult(result)
commitBatch(results)
markSkipped(messageId, reason)
markFailed(messageId, reason)
cancelChannel(channelId, generation)
restoreChannel(channelId)
restoreAll()
markRenderOutcome(outcome)
getDisplayState(messageId)
listChannel(channelId)
```

Callers do not access internal maps.

### TranslationDisplayController

Converts message states into one display transaction.

```text
renderMessage(messageId)
commitMessageResult(result)
commitHistoricalBatch(results)
restoreChannel(channelId)
restoreAll()
```

A transaction contains message text, watermark, translated style, loading state, original block, and embed/reply updates together.

### DiscordRenderAdapter

Contains all knowledge of Discord and BDFDB rendering internals.

```text
captureVisibleMessages(channelId)
applyDisplayTransaction(transaction)
refreshMessages({channelId, messageIds, views, transactionId})
refreshThreadTitles(channelId)
```

No translation policy or provider logic is allowed in this adapter. It returns `confirmedIds`, `missingIds`, `deferredIds`, and `fallbackUsed` so state commit and render commit can be measured separately. A deferred ID is outside Discord's mounted virtual list: it remains pending until a later mount can prove the exact revision, and it never triggers the full-list fallback. Revision acknowledgement applies to translated, loading, skipped, failed, cancelled, and restored-original views.

### TranslationOrchestrator

Coordinates policy, queues, providers, validation, cache, and display commits.

```text
translateLive(snapshot, context)
translateHistorical(snapshots, context)
translateManual(snapshot, context)
cancelChannel(channelId, generation)
```

It returns structured results and never edits React props.

### HistoricalTranslationJob

Owns one immutable, channel-scoped ID snapshot. Provider requests may be split internally, but terminal results are returned as one batch. The job does not render Discord directly.

### ProviderRegistry

Resolves one provider adapter by provider ID. Every adapter returns the same result type and shares timeout, retry, error normalization, and protected-placeholder validation through `provider-client.js`.

## Received Message Flow

```text
Discord patch
  -> MessageSnapshot
  -> MessageStateStore.captureSource
  -> TranslationOrchestrator
  -> live queue or HistoricalTranslationJob
  -> ProviderRegistry
  -> validated TranslationResult
  -> MessageStateStore commit
  -> TranslationDisplayController transaction
  -> DiscordRenderAdapter refresh
  -> render acknowledgement or visible failure
```

Historical results enter the state store together. One historical display transaction then refreshes the exact committed message IDs. New live messages use a separate path and do not wait for historical work.

## Disable And Stop Flow

Disabling one channel:

1. Increment the channel generation.
2. Cancel pending automatic work for that channel.
3. Mark automatic message states as hidden while retaining immutable source snapshots.
4. Build one restore transaction for messages, replies, embeds, and thread titles.
5. Refresh the affected channel and verify the original state is visible.
6. Leave manual translations untouched.

Stopping the plugin performs the same operation for every channel before unregistering patches.

## Edit Flow

An edited Discord message creates a new immutable source snapshot and a new signature. Previous pending work and display results for that message are cancelled. Sent-message editing obtains original text from the state store, never from translated React props.

## Settings And Persistence

Persistent data is split by responsibility:

```text
settings              Global behavior and display preferences
channelSettings       Channel enablement, languages, and provider override
providerCredentials   API keys, endpoints, and models
translationCache      Bounded successful translation cache
```

The global primary default, global backup provider, detection strategy, and every provider credential remain global. A channel may override only the channel-owned primary provider and language choices defined in `docs/settings.md`.

Runtime queues, message display state, scroll state, and active generations remain in memory and are never stored in the settings document.

When the user leaves a channel, `MessageStateStore` prunes records that can be reconstructed from the bounded translation cache. It retains active requests, manual translations, manual-untranslate suppression, cancelled restore records, and source archives until their owning workflow finishes. If no records remain, the channel index, display generation, and reply-preview eligibility are released too. Revisiting the channel captures the source again and commits a matching cached translation without another provider request.

Every persistent document has an explicit schema version and one migration entry point. Compatibility reads are removed after the corresponding migration has shipped and been verified.

## Build And Verification

Required commands after the build migration:

```text
npm run build
npm run check
npm test
npm run verify
```

`npm run verify` must:

1. Build the plugin from `src/`.
2. Verify the committed plugin file matches a fresh deterministic build.
3. Syntax-check the generated plugin.
4. Run unit, contract, integration, migration, and build tests.

The generated readable release target is 7,000-8,500 lines and 350-450 KB. Size is a guardrail, not a reason to remove required behavior.

## Testing Strategy

Tests are divided by confidence level:

- Domain tests verify state transitions, policy, provider parsing, and cancellation.
- Display contract tests assert complete display transactions, including text, watermark, styling, loading, and restoration.
- Discord adapter tests use captured component shapes and verify the exact message IDs requested for refresh.
- Build tests verify metadata, one-file output, deterministic bytes, and exclusion of test/debug code.
- DiscordPTB smoke tests verify hover-independent display, disable restoration, atomic historical reveal, scroll stability, edits, titles, stop, and reload.

A test that only asserts `forceAllUpdates` or another refresh helper was called is not sufficient evidence that a visible message changed.

## Observability

Debug builds expose a bounded in-memory transition journal keyed by channel ID and message ID:

```text
captured -> queued -> provider-started -> provider-finished
         -> state-committed -> render-requested -> render-confirmed
```

Skipped and failed items include a stable reason code. Diagnostic data is excluded from release output unless an explicit local debug build is requested.

## Migration Rules

- Freeze new feature work until the display vertical slice passes DiscordPTB verification.
- Introduce the build pipeline without changing runtime behavior.
- Move one deep module at a time and retain a compatibility adapter only while callers migrate.
- Do not create a second competing state map or queue.
- Do not delete legacy code in the same commit that introduces its replacement.
- Delete the legacy implementation in the next small commit after parity verification.
- Keep every migration commit deployable and reversible.
- Do not mark a phase complete from mocked tests alone when the phase changes Discord rendering.
