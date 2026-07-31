# Product Behavior

## Purpose

DiscordAITranslator translates sent messages, received messages, reply previews, supported embedded content, and enabled forum/thread titles while preserving Discord markup and the user's original text.

The primary user is not expected to understand provider APIs or repository internals. Common channel actions must be available next to the Discord message input; advanced defaults and credentials belong in BetterDiscord settings.

## Current Channel Interaction

- Left-clicking the translator icon opens current-channel translation settings.
- Right-clicking the translator icon toggles the automatic translation master switch only for the current channel.
- Turning a channel off removes automatic sent/received work, automatic display state, and translated thread title for that channel.
- Manual translations and translated sent messages are not removed by the channel toggle.
- Channel state never changes another channel or the global backup provider.

## Approved Channel Popout

The channel popout contains:

- Current-channel primary translation provider
- Restore-following-global action
- Language detection helper
- Input language for received messages
- Output language for received messages
- Input language for sent messages
- Output language for sent messages
- Existing channel, server, and global language scope lock

The channel popout does not contain:

- Automatic translation toggle
- Read-only status explanation
- Backup provider
- API key, endpoint, or model fields
- Global display or automation defaults

## Approved Global Behavior

- Channels without an explicit record default to automatic translation off.
- The current-channel right-click icon is the only automatic translation switch exposed to users.
- Existing explicit channel records must survive migration.
- The input-box translator button and message action translate button are always available and are not user settings.
- The global backup provider and provider credentials remain global.

## Translation Quality

- Short foreign words and short conversational phrases must remain translatable.
- Length alone must not produce an AI skip decision.
- URLs, mentions, Discord markup, code, commands, IDs, model names, product names, configured glossary terms, and protected placeholders must not be damaged.
- A professional term should remain untranslated when it has no accepted target-language translation; an official or widely accepted localized name may be used.
- Translation output must contain translated text only, without explanations or commentary.

## Live And Historical Messages

- Live messages use an immediate queue and never wait for loaded-history work.
- Loaded messages form one channel-scoped, ID-keyed job up to the configured limit.
- A historical job may make several provider or repair requests, but valid terminal results become visible in one atomic rerender.
- Completed translations become visible immediately even while the user is typing or scrolling.
- One historical display transaction refreshes the mounted message rows in that configured batch together while preserving the viewport anchor once; if the user changes scroll intent during paint, the plugin does not pull the viewport back. Virtualized rows render their final stored state when they mount.
- Automatic translation display never remounts the full chat list.
- The loaded-message status counts confirmed and virtualized-ready translations only; missing, retrying, rejected, and stale rows are not reported as displayed.
- Missing, duplicate, malformed, empty, wrong-language, and placeholder-damaged batch results enter repair instead of disappearing.
- Each pending message uses a fixed-size CSS loading indicator without timer-driven React rerenders.
- Disabling automatic translation restores messages, reply previews, embeds, and titles through one display transaction without a second broad repaint.

## Message Lifecycle

- Editing a translated sent message must open editable original text and save a correctly translated replacement.
- When another user edits a received message, stale cache and display data must be invalidated and the new content translated.
- Stopping or uninstalling the plugin must restore original message, reply, and embed content.
- Reloading the plugin must not reuse stale display state left by an earlier runtime session.

## Providers And Detection

- Official OpenAI uses the Responses API.
- Gemini uses its native `generateContent` API.
- Third-party and self-hosted services use the separate OpenAI-compatible provider and require an explicit endpoint and model.
- Google Free remains keyless; official Google API keys belong to Google Cloud Translation.
- Global language detection supports local-first with Google fallback, Google-only, and local-only strategies.

## Forum And Thread Titles

- Title translation follows the current thread or forum-post channel configuration.
- The plugin replaces only rendered title text and never mutates the Discord channel store object.
- Edited titles invalidate stale translations.
- Disabling the channel or stopping the plugin restores the original title and rejects late callbacks.

## Remaining Engineering Work

- Split the tested single-file implementation into source modules with deterministic build output.
- Add provider and Discord render latency instrumentation.
- Complete the remaining DiscordPTB smoke-test checklist before a version bump or release.
