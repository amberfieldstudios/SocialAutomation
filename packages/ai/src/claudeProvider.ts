/**
 * Real `ContentProvider` backed by the Anthropic Claude API (`@anthropic-ai/sdk`).
 *
 * Model: defaults to `claude-opus-4-8` (current top-tier Opus, per the
 * `claude-api` skill's model catalog as of 2026-07-04) — override via
 * `ClaudeProviderConfig.model` for cost-sensitive high-volume campaigns (e.g.
 * `claude-sonnet-5`, which is materially cheaper and plenty capable for short
 * social copy). Never guess a model id beyond what's configured here.
 *
 * Credentials: reads `ANTHROPIC_API_KEY` from `config.apiKey` or
 * `process.env.ANTHROPIC_API_KEY`. Never logs the key or the raw prompt —
 * only platform/kind/prompt-length/model land in log fields (see
 * `docs/ARCHITECTURE.md` #2/#3).
 *
 * Determinism: the Messages API does not accept `temperature`/`top_p`/`top_k`
 * on current Opus/Sonnet-5-tier models (non-default values 400), so this
 * provider cannot be made deterministic — that is what `MockProvider` is for.
 * Every test in this package (and consumers of it) should run against
 * `MockProvider`, never `ClaudeProvider`.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { StructuredLogger } from '@social/core';
import { AiConfigError, AiProviderError, AiRefusalError } from './errors';
import type { ContentGenerationTask, ContentProvider } from './types';
import { truncateToLimit } from './text';
import { buildPrompt, SYSTEM_PROMPT } from './promptBuilder';

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-4-8';

export interface ClaudeProviderConfig {
  /** Falls back to `process.env.ANTHROPIC_API_KEY` if omitted. */
  apiKey?: string;
  /** Defaults to `DEFAULT_CLAUDE_MODEL`. */
  model?: string;
  logger: StructuredLogger;
  /** Inject a pre-built SDK client (tests / custom transport); overrides `apiKey`. */
  client?: Anthropic;
  /** Max output tokens per call. Short social copy needs very little. Default 400. */
  maxTokens?: number;
}

export class ClaudeProvider implements ContentProvider {
  readonly name = 'claude';
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly logger: StructuredLogger;
  private readonly maxTokens: number;

  constructor(config: ClaudeProviderConfig) {
    this.logger = config.logger.child({ component: 'ai.claude_provider' });
    this.model = config.model ?? DEFAULT_CLAUDE_MODEL;
    this.maxTokens = config.maxTokens ?? 400;

    if (config.client) {
      this.client = config.client;
      return;
    }
    const apiKey = config.apiKey ?? process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) {
      throw new AiConfigError(
        'ClaudeProvider requires an Anthropic API key: set ANTHROPIC_API_KEY or pass config.apiKey.',
      );
    }
    this.client = new Anthropic({ apiKey });
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
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
      });

      if (response.stop_reason === 'refusal') {
        throw new AiRefusalError('Claude declined to generate this content.', null);
      }

      const textBlock = response.content.find((block) => block.type === 'text');
      const raw = textBlock && textBlock.type === 'text' ? textBlock.text : '';
      const text = truncateToLimit(raw, task.maxLength, task.countGraphemes);

      this.logger.info('ai.claude_completion', {
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
        this.logger.warn('ai.claude_refusal', { platform: task.platform, kind: task.kind, model: this.model });
        throw error;
      }
      const retryable = isRetryable(error);
      this.logger.error('ai.claude_error', {
        platform: task.platform,
        kind: task.kind,
        model: this.model,
        retryable,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      throw new AiProviderError(`Claude API call failed for ${task.platform}/${task.kind}.`, {
        retryable,
        cause: error,
      });
    }
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof Anthropic.RateLimitError) return true;
  if (error instanceof Anthropic.InternalServerError) return true;
  if (error instanceof Anthropic.APIConnectionError) return true;
  return false;
}
