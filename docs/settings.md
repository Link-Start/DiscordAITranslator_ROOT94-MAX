# Settings Ownership

## Principle

Channel settings answer: "How should translation work in this channel right now?"

Global settings answer: "What defaults, credentials, protection rules, and display policy should the plugin use everywhere?"

A setting must have one canonical owner. The same behavior must not have editable controls in both surfaces.

## Channel Popout

| Setting | Scope | Persistence |
| --- | --- | --- |
| Primary translation provider | Current channel | Channel override; explicit restore follows global |
| Received input language | Channel, server, or global through the existing lock | Existing language scope storage |
| Received output language | Channel, server, or global through the existing lock | Existing language scope storage |
| Sent input language | Channel, server, or global through the existing lock | Existing language scope storage |
| Sent output language | Channel, server, or global through the existing lock | Existing language scope storage |
| Language detection helper | Current interaction only | Saves only when the user applies a detected language |

The backup provider is intentionally absent. A channel-specific backup would multiply provider configuration states and make failures difficult to explain.

## Global BetterDiscord Settings

| Section | Settings |
| --- | --- |
| Providers | Global primary default, global backup provider, API keys, endpoints, models, connection tests |
| Language detection | Detection strategy and provider when implemented |
| Translation rules | Source filters, AI decision mode, short-message behavior, similarity rules |
| Display | Original text presentation, translated label, translated color, reply-preview behavior |
| Protection | Protected terms, wrapper pairs, prefixes, sent and received protection scopes |
| Historical translation | New-only or loaded-message policy, batch limits, scroll behavior |

## Removed Controls

- Input-box translator button visibility
- Message action translator button visibility
- Global automatic translation default switch
- Duplicate sent-original and received-original controls in the channel popout

The two translator buttons are part of the product and remain enabled. Channels without explicit automatic translation state default to off.

## Migration Rule

When the global automatic translation default control is removed:

1. Preserve explicit per-channel true or false records.
2. Set the inherited default to false.
3. Do not convert inherited enabled channels into explicit enabled records.
4. Keep right-click changes channel-scoped.
5. Clear only the affected channel's automatic display and pending work when disabled.
