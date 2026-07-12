# Architecture

## Current Runtime

The shipped implementation is `DiscordAITranslator.plugin.js`:

- Approximately 10,943 lines
- Approximately 601 KB
- BetterDiscord and BDFDB runtime
- One generated or hand-maintained distribution file
- Node.js built-in regression tests using a mocked BDFDB environment

This file is the real runtime. Documentation and roadmap entries do not override tested behavior.

## Existing Internal Boundaries

The single file already contains several logical modules:

- Translation provider registry and adapters
- Channel enablement state
- Channel primary provider overrides
- Sent translation policy
- Received translation policy and queue runtime
- Historical AI batch translation
- Translation cache and reply-preview signatures
- Translation display logic
- Text protection logic
- BetterDiscord settings and channel popout UI

These boundaries are useful but remain physically coupled through closure state and one plugin class.

## Persistent State

Important persistent data includes:

- Global settings and provider credentials
- Channel and guild language choices
- Channel automatic translation records
- Channel primary provider overrides
- Translation cache
- Protected terms, wrappers, prefixes, and favorites

Persistent channel records must be normalized on load. Runtime queues and displayed translation maps are not authoritative persistent state.

## Translation Flow

### Received Messages

1. Resolve channel state and effective provider.
2. Extract original message and embed content.
3. Build a signature from content, languages, protection policy, channel, primary provider, and backup provider.
4. Reuse a valid cache entry or evaluate pre-translation skip rules.
5. Queue live or historical work.
6. Translate through the effective primary provider, then the global backup.
7. Apply display data and rerender the affected message surface.

### Sent Messages

1. Preserve the submitted channel ID.
2. Resolve sent input and output languages for that channel.
3. Apply same-language and source-filter rules.
4. Translate through the effective channel primary provider.
5. Build the final Discord message with optional original text.

### Manual Translation

Manual translation is independent from the channel automatic translation switch. Manual results must remain distinguishable from automatic results so channel cleanup and plugin shutdown do not remove the wrong content.

## Known Architectural Risks

- The main file is too large for safe iteration.
- UI rendering, persistence, provider dispatch, and runtime cleanup still share closure state.
- Message display mutates Discord message objects and must always retain recoverable original data.
- Plugin shutdown currently needs stronger original-content restoration guarantees.
- Message edits, thread titles, and live versus historical rerenders require dedicated lifecycle adapters.
- Provider capability checks can drift unless they use one shared contract.

## Target Source Layout

The future source tree should separate responsibilities while preserving one built plugin file:

```text
src/
  plugin/
    lifecycle.js
    patches.js
  settings/
    channel-settings.js
    global-settings.js
    state-store.js
  providers/
    registry.js
    google-free.js
    google-cloud.js
    openai.js
    gemini.js
    openai-compatible.js
  translation/
    sent-policy.js
    received-policy.js
    language-detection.js
    prompt-policy.js
  runtime/
    live-queue.js
    historical-queue.js
    cache.js
  display/
    messages.js
    replies.js
    embeds.js
    thread-titles.js
  protection/
    placeholders.js
    glossary.js
```

This is a target, not the current repository structure.

## Migration Rules

- Extract one tested boundary at a time.
- Keep compatibility wrappers until all callers move.
- Do not combine source extraction with a behavior change.
- Compare focused tests before and after each extraction.
- Build output must remain directly installable by BetterDiscord.
- Delete the old inline implementation only after the generated path passes the complete suite and Discord smoke tests.
