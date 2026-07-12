# Product Behavior

## Purpose

DiscordAITranslator translates sent messages, received messages, reply previews, and supported embedded message content while preserving Discord markup and the user's original text.

The primary user is not expected to understand provider APIs or repository internals. Common channel actions must be available next to the Discord message input; advanced defaults and credentials belong in BetterDiscord settings.

## Current Channel Interaction

- Left-clicking the translator icon opens current-channel translation settings.
- Right-clicking the translator icon toggles automatic translation only for the current channel.
- Turning a channel off removes automatic received translations and pending work for that channel.
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

## Message Lifecycle

- Editing a translated sent message must open editable original text and save a correctly translated replacement.
- When another user edits a received message, stale cache and display data must be invalidated and the new content translated.
- Stopping or uninstalling the plugin must restore original message, reply, and embed content.
- Reloading the plugin must not reuse stale display state left by an earlier runtime session.

## Planned Coverage

- Automatic translation of Discord forum and thread titles
- Official OpenAI provider
- Native Gemini provider
- Clear OpenAI-compatible provider for self-hosted and third-party APIs
- Configurable language detection strategy

These items remain incomplete until their roadmap tasks and regression tests pass.
