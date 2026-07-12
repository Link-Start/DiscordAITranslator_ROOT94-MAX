# Provider Contracts

## Translation Provider Interface

Every provider adapter must expose the same logical inputs:

- Source language or automatic detection
- Target language
- Protected text payload
- Provider credentials and endpoint from global configuration
- Optional model identifier
- Translation callback or promise result

Provider-specific request formats stay inside the adapter. Channel code selects a provider key and must not know its HTTP schema.

## Current Providers

| Provider key | User-facing role | Credentials |
| --- | --- | --- |
| `googleapi` | Google Free translation | No key |
| `googlecloud` | Official Google Cloud Translation | Global API key |
| `microsoft` | Azure Translator | Global API key and optional region |
| `deepl` | DeepL API | Global API key |
| `deepseek` | DeepSeek AI translation | Global API key, endpoint, and model |
| `oaicompat` | OpenAI-compatible API | Global API key, endpoint, and model |
| Other legacy adapters | Compatibility providers | Existing global configuration |

## Planned Providers

### OpenAI

Add a distinct official OpenAI provider for OpenAI API models. The UI may describe it as `OpenAI (ChatGPT models)`, but documentation must state that a ChatGPT subscription is not an OpenAI API credential.

### Gemini

Add a native Gemini adapter using Gemini's request and response schema. Do not route Gemini through the OpenAI-compatible adapter unless the endpoint itself explicitly offers OpenAI compatibility.

### OpenAI-Compatible

Retain the generic provider for self-hosted gateways and third-party services. Users configure a global endpoint, API key, and model. Validation errors must name the missing field.

## Google Free And Google Cloud

Google Free translation uses the public keyless web translation endpoint. It does not accept a user API key.

Official Google credentials belong to the separate Google Cloud provider. A future custom Google Free proxy may expose a configurable endpoint, but it must not be presented as a Google Free API key.

## Backup Provider

- The backup provider is global.
- A channel primary provider may differ from the global primary.
- If the channel primary equals the global backup, the same provider must not be called twice.
- Cache and reply signatures include the effective channel primary and effective backup provider.

## Language Detection

Current behavior combines local heuristics with Google Free detection fallback.

The approved target strategy is:

1. `Auto` as the default: local detection first, Google Free only when local detection is inconclusive.
2. Optional explicit providers after provider adapters are stable: Google Free, OpenAI, Gemini, or current primary AI provider.
3. AI detection is never the default because it is slower and may consume paid tokens.
4. Translation and language detection remain separate contracts even when they use the same provider.
