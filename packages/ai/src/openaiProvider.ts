/**
 * Real `ContentProvider` backed by the OpenAI API (`openai` npm SDK).
 *
 * Model: defaults to `gpt-5.5`, OpenAI's current mainstream flagship chat
 * model as of 2026-07-04 — confirmed against the live model catalog at
 * https://developers.openai.com/api/docs/models/all (do not guess a newer id
 * from memory; re-check that URL before bumping `DEFAULT_OPENAI_MODEL`).
 * Override via `OpenAiProviderConfig.model` (e.g. a `-mini`/`-pro` variant
 * for cost/quality tradeoffs on high-volume campaigns).
 *
 * Credentials: reads `OPENAI_API_KEY` from `config.apiKey` or
 * `process.env.OPENAI_API_KEY`. IMPORTANT — a ChatGPT Plus/Team/Pro
 * subscription does NOT include API access: API calls are billed separately,
 * per token, against a key generated at https://platform.openai.com/api-keys
 * (see packages/ai/README.md). Never logs the key or the raw prompt — only
 * platform/kind/model/prompt-length/output-length/duration land in log
 * fields, exactly like `ClaudeProvider` (see `docs/ARCHITECTURE.md` #2/#3).
 *
 * Determinism: like `ClaudeProvider`, this hits a live model and is NOT
 * deterministic. Every test in this package (and consumers of it) should run
 * against `MockProvider`, never `OpenAiProvider`, with the OpenAI SDK client
 * always injected as a fake in this package's own tests.
 *
 * Prompt construction is shared with `ClaudeProvider` via `promptBuilder.ts`
 * so the two providers never drift on what instructions they send the model.
 */

import OpenAI from 'openai';
import type { StructuredLogger } from '@social/core';
import { AiConfigError, AiProviderError, AiRefusalError } from './errors';
import type { ContentGenerationTask, ContentProvider } from './types';
import { truncateToLimit } from './text';
import { buildPrompt, SYSTEM_PROMPT } from './promptBuilder';

export const DEFAULT_OPENAI_MODEL = 'gpt-5.5';

export interface OpenAiProviderConfig {
  /** Falls back to `process.env.OPENAI_API_KEY` if omitted. */
  apiKey?: string;
  /** Defaults to `DEFAULT_OPENAI_MODEL`. */
  model?: string;
  logger: StructuredLogger;
  /** Inject a pre-built SDK client (tests / custom transport); overrides `apiKey`. */
  client?: OpenAI;
  /** Max output tokens per call. Short social copy needs very little. Default 400. */
  maxTokens?: number;
}

export class OpenAiProvider implements ContentProvider {
  readonly name = 'openai';
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly logger: StructuredLogger;
  private readonly maxTokens: number;

  constructor(config: OpenAiProviderConfig) {
    this.logger = config.logger.child({ component: 'ai.openai_provider' });
    this.model = config.model ?? DEFAULT_OPENAI_MODEL;
    this.maxTokens = config.maxTokens ?? 400;

    if (config.client) {
      this.client = config.client;
      return;
    }
    const apiKey = config.apiKey ?? process.env['OPENAI_API_KEY'];
    if (!apiKey) {
      throw new AiConfigError(
        'OpenAiProvider requires an OpenAI API key: set OPENAI_API_KEY or pass config.apiKey. ' +
          'Note: a ChatGPT Plus/Team/Pro subscription does NOT include API access — generate a ' +
          'separate, per-token-billed key at https://platform.openai.com/api-keys.',
      );
    }
    this.client = new OpenAI({ apiKey });
  }

  async generate(task: ContentGenerationTask): Promise<string> {
    return this.complete(task, buildPrompt(task, 'generate'));
  }

  async rewrite(task: ContentGenerationTask): Promise<string> {
    return this.complete(task, buildPrompt(task, 'rewrite'));
  }

  async shorten(task: ContentGenerationTask): Promise<string> {
    return this.complete(task, buildPrompt(task, 'shorten'));
  }

  async expand(task: ContentGenerationTask): Promise<string> {
    return this.complete(task, buildPrompt(task, 'expand'));
  }

  private async complete(task: ContentGenerationTask, prompt: string): Promise<string> {
    const startedAt = Date.now();
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        max_completion_tokens: this.maxTokens,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
      });

      const choice = response.choices[0];
      if (choice?.finish_reason === 'content_filter' || choice?.message?.refusal) {
        throw new AiRefusalError(
          choice?.message?.refusal ?? 'OpenAI declined to generate this content.',
          choice?.finish_reason ?? null,
        );
      }

      const raw = choice?.message?.content ?? '';
      const text = truncateToLimit(raw, task.maxLength, task.countGraphemes);

      this.logger.info('ai.openai_completion', {
        platform: task.platform,
        kind: task.kind,
        model: this.model,
        promptLength: prompt.length,
        outputLength: text.length,
        durationMs: Date.now() - startedAt,
      });
      return text;
    } catch (error) {
      if (error instanceof AiRefusalError) {
        this.logger.warn('ai.openai_refusal', { platform: task.platform, kind: task.kind, model: this.model });
        throw error;
      }
      const retryable = isRetryable(error);
      this.logger.error('ai.openai_error', {
        platform: task.platform,
        kind: task.kind,
        model: this.model,
        retryable,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      throw new AiProviderError(`OpenAI API call failed for ${task.platform}/${task.kind}.`, {
        retryable,
        cause: error,
      });
    }
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof OpenAI.RateLimitError) return true;
  if (error instanceof OpenAI.InternalServerError) return true;
  if (error instanceof OpenAI.APIConnectionError) return true;
  return false;
}
