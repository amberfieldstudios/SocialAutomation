/**
 * `FallbackContentProvider` — the credential-free generation fallback chain
 * (task t5).
 *
 * It wraps a PRIMARY `ContentProvider` (normally the on-device `LocalProvider`)
 * and a FALLBACK `ContentProvider` (the deterministic `MockProvider` template
 * generator). Every generate/rewrite/shorten/expand call is attempted on the
 * primary first; if the primary reports that it cannot serve the request —
 * because the model is absent, still downloading, corrupt, or the machine is
 * too weak to load it (`AiConfigError`), or an inference call failed
 * (`AiProviderError`) — the call transparently degrades to the fallback so the
 * pipeline ALWAYS returns usable copy and NEVER errors for lack of an API key
 * or a model.
 *
 * Only availability/inference failures from the underlying model trigger the
 * degrade; any other error (a genuine bug, an unexpected throw) propagates
 * unchanged rather than being silently masked. The first degrade is logged at
 * `warn` (with the reason) so operators can see the app is running on the
 * template fallback; subsequent degrades log at `debug` to avoid log spam.
 */

import type { StructuredLogger } from '@social/core';
import { AiConfigError, AiProviderError } from './errors';
import type { ContentGenerationTask, ContentProvider } from './types';

/** Errors that mean "the primary model can't serve this — use the fallback". */
export function isFallbackTrigger(error: unknown): boolean {
  return error instanceof AiConfigError || error instanceof AiProviderError;
}

export interface FallbackContentProviderOptions {
  logger: StructuredLogger;
  /**
   * Predicate deciding whether a primary error should degrade to the fallback.
   * Defaults to `isFallbackTrigger` (model-availability + inference failures).
   */
  shouldFallback?: (error: unknown) => boolean;
}

export class FallbackContentProvider implements ContentProvider {
  readonly name: string;
  private readonly primary: ContentProvider;
  private readonly fallback: ContentProvider;
  private readonly logger: StructuredLogger;
  private readonly shouldFallback: (error: unknown) => boolean;
  /** Whether we have already logged (at warn) that we degraded to the fallback. */
  private hasDegraded = false;

  constructor(primary: ContentProvider, fallback: ContentProvider, options: FallbackContentProviderOptions) {
    this.primary = primary;
    this.fallback = fallback;
    this.logger = options.logger.child({ component: 'ai.fallback_provider' });
    this.shouldFallback = options.shouldFallback ?? isFallbackTrigger;
    this.name = `${primary.name}+${fallback.name}`;
  }

  generate(task: ContentGenerationTask): Promise<string> {
    return this.run('generate', task, (p) => p.generate(task));
  }

  rewrite(task: ContentGenerationTask): Promise<string> {
    return this.run('rewrite', task, (p) => p.rewrite(task));
  }

  shorten(task: ContentGenerationTask): Promise<string> {
    return this.run('shorten', task, (p) => p.shorten(task));
  }

  expand(task: ContentGenerationTask): Promise<string> {
    return this.run('expand', task, (p) => p.expand(task));
  }

  private async run(
    op: string,
    task: ContentGenerationTask,
    call: (provider: ContentProvider) => Promise<string>,
  ): Promise<string> {
    try {
      return await call(this.primary);
    } catch (error) {
      if (!this.shouldFallback(error)) throw error;
      this.logDegrade(op, task, error);
      return call(this.fallback);
    }
  }

  private logDegrade(op: string, task: ContentGenerationTask, error: unknown): void {
    const fields = {
      op,
      platform: task.platform,
      kind: task.kind,
      from: this.primary.name,
      to: this.fallback.name,
      errorName: error instanceof Error ? error.name : typeof error,
      reason: error instanceof Error ? error.message : String(error),
    };
    if (this.hasDegraded) {
      this.logger.debug('ai.fallback_degrade', fields);
      return;
    }
    this.hasDegraded = true;
    this.logger.warn('ai.fallback_degrade', {
      ...fields,
      note: 'On-device model unavailable; serving deterministic template copy (no API key required).',
    });
  }
}
