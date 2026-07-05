/**
 * Config-driven `ContentProvider` selection: `AI_PROVIDER=local|claude|openai|mock`
 * picks which provider a caller wires up, so switching models is an env var,
 * not a code change. `claude` is the default when `AI_PROVIDER` is unset, per
 * the existing production wiring.
 *
 * `local` is the credential-free on-device path (`node-llama-cpp` + a GGUF
 * model on disk); it needs no API key, only a `modelPath` (or
 * `LOCAL_MODEL_PATH`). See `localProvider.ts`.
 *
 * This is a plain factory, not itself a wiring site. `packages/api`'s
 * `createAppContext` is the main consumer: when `AI_PROVIDER` is unset it
 * prefers `local` if a model is present on disk and otherwise passes an
 * explicit `provider: 'mock'`, so the dashboard's credential-free default
 * works with no keys, while `AI_PROVIDER=claude|openai` opts the running app
 * into live cloud generation (see `packages/api/src/context.ts`).
 */

import type { StructuredLogger } from '@social/core';
import { AiConfigError } from './errors';
import type { ContentProvider } from './types';
import { ClaudeProvider, DEFAULT_CLAUDE_MODEL } from './claudeProvider';
import { OpenAiProvider, DEFAULT_OPENAI_MODEL } from './openaiProvider';
import { MockProvider } from './mockProvider';
import { LocalProvider, resolveLocalModelPath } from './localProvider';

export type AiProviderId = 'local' | 'claude' | 'openai' | 'mock';

export interface CreateContentProviderOptions {
  /** Defaults to `process.env.AI_PROVIDER`, then `'claude'`. */
  provider?: AiProviderId;
  logger: StructuredLogger;
  /** Forwarded to the chosen provider; ignored for `mock`/`local`. */
  apiKey?: string;
  /** Forwarded to the chosen provider; ignored for `mock`/`local`. */
  model?: string;
  /** On-disk GGUF model path for `local`; defaults to `LOCAL_MODEL_PATH`. */
  modelPath?: string;
  maxTokens?: number;
}

function resolveProviderId(explicit: AiProviderId | undefined): AiProviderId {
  if (explicit) return explicit;
  const fromEnv = process.env['AI_PROVIDER'];
  if (fromEnv === 'local' || fromEnv === 'claude' || fromEnv === 'openai' || fromEnv === 'mock') {
    return fromEnv;
  }
  if (fromEnv) {
    throw new AiConfigError(
      `Unknown AI_PROVIDER "${fromEnv}" — expected "local", "claude", "openai", or "mock".`,
    );
  }
  return 'claude';
}

/**
 * Builds the `ContentProvider` named by `options.provider`/`AI_PROVIDER`.
 * Throws `AiConfigError` for an unknown provider id, or when the chosen
 * real provider is missing its API key (surfaced by that provider's own
 * constructor — this function does not duplicate that check).
 */
export function createContentProvider(options: CreateContentProviderOptions): ContentProvider {
  const providerId = resolveProviderId(options.provider);
  switch (providerId) {
    case 'local':
      return new LocalProvider({
        logger: options.logger,
        modelPath: options.modelPath ?? resolveLocalModelPath(),
        ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      });
    case 'claude':
      return new ClaudeProvider({
        logger: options.logger,
        ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
        model: options.model ?? DEFAULT_CLAUDE_MODEL,
        ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      });
    case 'openai':
      return new OpenAiProvider({
        logger: options.logger,
        ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
        model: options.model ?? DEFAULT_OPENAI_MODEL,
        ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      });
    case 'mock':
      return new MockProvider();
    default: {
      const exhaustive: never = providerId;
      throw new AiConfigError(`Unknown AI provider id "${String(exhaustive)}".`);
    }
  }
}
