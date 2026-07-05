# @social/ai

The content-generation stage: turns one `ContentBrief` (a single description, plus optional
title/link/tags/mentions/campaign/CTA/SEO keywords) into per-platform post variants — tone and
length tuned per platform, with hashtag generation, emoji placement, CTA generation, title
generation, and SEO-aware phrasing — via a swappable `ContentProvider`. `rewrite`/`shorten`/
`expand` operate on an already-generated variant.

## Providers

| Provider | `name` | Backing API | Determinism | Requires |
|---|---|---|---|---|
| `MockProvider` | `mock` | none (pure function) | Deterministic | nothing |
| `ClaudeProvider` | `claude` | Anthropic Messages API | Not deterministic | `ANTHROPIC_API_KEY` |
| `OpenAiProvider` | `openai` | OpenAI Chat Completions API | Not deterministic | `OPENAI_API_KEY` |

`MockProvider` is network-free and deterministic — **every test in this repo runs against
`MockProvider`**, never a real provider. `ClaudeProvider` and `OpenAiProvider` are exercised in
this package's own tests only against an injected fake SDK client (`client` config option) —
never the real network.

### Choosing a provider at runtime

```ts
import { createContentProvider } from '@social/ai';

const provider = createContentProvider({ logger });
// picks ClaudeProvider / OpenAiProvider / MockProvider based on:
//   options.provider, else the AI_PROVIDER env var, else 'claude'
```

`AI_PROVIDER=claude|openai|mock` — defaults to `claude` when unset. The matching API key env
var is required for whichever real provider is selected (`ANTHROPIC_API_KEY` for `claude`,
`OPENAI_API_KEY` for `openai`); an unset key throws `AiConfigError` from the underlying
provider's constructor. `createContentProvider` itself throws `AiConfigError` for an unrecognized
`AI_PROVIDER` value.

`packages/api`'s dashboard context (`packages/api/src/context.ts`, `server.ts`) intentionally
does **not** use this factory — it constructs `MockProvider` directly and unconditionally, by
design (see that file's doc comment): the dashboard never talks to a real AI API key. A real
production entrypoint (outside this dashboard) is where `createContentProvider` is meant to be
wired in.

### OpenAI API access vs. ChatGPT subscriptions

**A ChatGPT Plus/Team/Pro subscription does NOT include OpenAI API access.** They are billed
and provisioned completely separately:

- ChatGPT subscriptions grant access to the chat.openai.com / ChatGPT apps only.
- API access requires a separate account at https://platform.openai.com, its own API key
  (`OPENAI_API_KEY`), and its own billing (pay-per-token, prepaid credits or invoiced).

Generate a key at https://platform.openai.com/api-keys and set it as `OPENAI_API_KEY` before
selecting `AI_PROVIDER=openai` — no amount of ChatGPT subscription spend substitutes for this.

### Model defaults

- `ClaudeProvider` defaults to `claude-opus-4-8` (see `claudeProvider.ts` for the source/date
  this was checked). Override with `ClaudeProviderConfig.model`, e.g. `claude-sonnet-5` for
  cheaper high-volume generation.
- `OpenAiProvider` defaults to `gpt-5.5`, confirmed against
  https://developers.openai.com/api/docs/models/all as of 2026-07-04 (see `openaiProvider.ts`).
  Override with `OpenAiProviderConfig.model`.

Never bump either default from memory — re-check the vendor's live model catalog first.

## Errors

All three real-network failure modes are normalized to the same typed errors regardless of
provider (`errors.ts`):

- `AiConfigError` — missing/invalid configuration (e.g. no API key, unknown `AI_PROVIDER`).
- `AiProviderError` — the API call failed; `.retryable` is `true` for rate limits, 5xx, and
  connection errors, `false` otherwise.
- `AiRefusalError` — the model declined to generate the content (safety refusal). Not retryable
  with the same prompt.

## Logging

Structured logs (`ai.claude_completion` / `ai.openai_completion` etc., via the injected
`StructuredLogger`) only ever include `platform`, `kind`, `model`, `promptLength`,
`outputLength`, and `durationMs` — never the API key and never the raw prompt/brief text.
