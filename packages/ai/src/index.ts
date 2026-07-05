/**
 * @social/ai — the content-generation stage: turns one content brief into
 * per-platform post variants (tone/length tuned, hashtags, emojis, CTAs,
 * titles, SEO), with rewrite/shorten/expand on an existing variant.
 *
 * `MockProvider` is deterministic and network-free — use it in every test.
 * `ClaudeProvider` is the production implementation backed by the Anthropic
 * Claude API; it requires `ANTHROPIC_API_KEY` (see claudeProvider.ts).
 * `OpenAiProvider` is an alternative real implementation backed by the
 * OpenAI API; it requires `OPENAI_API_KEY` (see openaiProvider.ts).
 * `LocalProvider` is the credential-free on-device implementation backed by
 * `node-llama-cpp` and a local GGUF model; it requires no API key, only a
 * model on disk (see localProvider.ts).
 * `createContentProvider` picks between them via `AI_PROVIDER` (see
 * providerFactory.ts).
 */

export * from './types';
export * from './errors';
export * from './text';
export * from './platformProfiles';
export * from './mockProvider';
export * from './fallbackProvider';
export * from './claudeProvider';
export * from './openaiProvider';
export * from './localProvider';
export * from './modelDownloadManager';
export * from './providerFactory';
export * from './campaignGenerator';
