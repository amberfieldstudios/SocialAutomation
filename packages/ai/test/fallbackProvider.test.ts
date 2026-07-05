import { describe, expect, it, vi } from 'vitest';
import { FallbackContentProvider, isFallbackTrigger } from '../src/fallbackProvider';
import { MockProvider } from '../src/mockProvider';
import { AiConfigError, AiProviderError, AiRefusalError } from '../src/errors';
import type { ContentGenerationTask, ContentProvider } from '../src/types';
import type { LogFields, StructuredLogger } from '@social/core';

const task: ContentGenerationTask = {
  kind: 'body',
  platform: 'discord',
  brief: { description: 'We are live tonight with the new release.' },
  toneInstruction: 'Write a punchy Discord announcement.',
  maxLength: 200,
};

/** A logger that records every call so we can assert on structured log output. */
function recordingLogger(): { logger: StructuredLogger; warns: Array<{ msg: string; fields?: LogFields }>; debugs: number } {
  const warns: Array<{ msg: string; fields?: LogFields }> = [];
  let debugs = 0;
  const make = (): StructuredLogger => ({
    child: () => make(),
    trace: () => {},
    debug: () => {
      debugs += 1;
    },
    info: () => {},
    warn: (msg: string, fields?: LogFields) => {
      warns.push({ msg, ...(fields ? { fields } : {}) });
    },
    error: () => {},
  });
  return { logger: make(), warns, get debugs() {
    return debugs;
  } };
}

/** A primary provider whose every method throws `error`. */
function throwingProvider(error: unknown): ContentProvider {
  const thrower = async (): Promise<string> => {
    throw error;
  };
  return { name: 'local', generate: thrower, rewrite: thrower, shorten: thrower, expand: thrower };
}

describe('isFallbackTrigger', () => {
  it('is true for model-availability and inference failures', () => {
    expect(isFallbackTrigger(new AiConfigError('no model'))).toBe(true);
    expect(isFallbackTrigger(new AiProviderError('inference failed'))).toBe(true);
  });

  it('is false for unrelated errors (so genuine bugs are not masked)', () => {
    expect(isFallbackTrigger(new AiRefusalError('refused'))).toBe(false);
    expect(isFallbackTrigger(new TypeError('boom'))).toBe(false);
    expect(isFallbackTrigger('nope')).toBe(false);
  });
});

describe('FallbackContentProvider', () => {
  it('uses the primary provider when it succeeds (no fallback, no warning)', async () => {
    const { logger, warns } = recordingLogger();
    const primary: ContentProvider = {
      name: 'local',
      generate: vi.fn(async () => 'from primary'),
      rewrite: async () => 'x',
      shorten: async () => 'x',
      expand: async () => 'x',
    };
    const provider = new FallbackContentProvider(primary, new MockProvider(), { logger });

    expect(await provider.generate(task)).toBe('from primary');
    expect(primary.generate).toHaveBeenCalledOnce();
    expect(warns).toHaveLength(0);
  });

  it('names itself "<primary>+<fallback>"', () => {
    const { logger } = recordingLogger();
    const provider = new FallbackContentProvider(throwingProvider(new AiConfigError('x')), new MockProvider(), { logger });
    expect(provider.name).toBe('local+mock');
  });

  it('degrades to the template fallback on AiConfigError (model absent/unloadable/too weak)', async () => {
    const { logger } = recordingLogger();
    const provider = new FallbackContentProvider(
      throwingProvider(new AiConfigError('model missing')),
      new MockProvider(),
      { logger },
    );
    const result = await provider.generate(task);
    // The template provider returns genuine, non-empty copy from the brief.
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain('live tonight');
  });

  it('degrades to the fallback on AiProviderError (inference failure) too', async () => {
    const { logger } = recordingLogger();
    const provider = new FallbackContentProvider(
      throwingProvider(new AiProviderError('inference exploded')),
      new MockProvider(),
      { logger },
    );
    await expect(provider.generate(task)).resolves.toContain('live tonight');
  });

  it('degrades across every operation (generate/rewrite/shorten/expand)', async () => {
    const { logger } = recordingLogger();
    const provider = new FallbackContentProvider(
      throwingProvider(new AiConfigError('no model')),
      new MockProvider(),
      { logger },
    );
    const src = { ...task, sourceText: 'Original post text about the release.' };
    await expect(provider.generate(task)).resolves.toBeTruthy();
    await expect(provider.rewrite(src)).resolves.toBeTruthy();
    await expect(provider.shorten(src)).resolves.toBeTruthy();
    await expect(provider.expand(src)).resolves.toBeTruthy();
  });

  it('propagates non-trigger errors instead of masking them', async () => {
    const { logger } = recordingLogger();
    const provider = new FallbackContentProvider(throwingProvider(new TypeError('real bug')), new MockProvider(), { logger });
    await expect(provider.generate(task)).rejects.toBeInstanceOf(TypeError);
  });

  it('logs the degrade at warn exactly once, then at debug', async () => {
    const rec = recordingLogger();
    const provider = new FallbackContentProvider(
      throwingProvider(new AiConfigError('no model')),
      new MockProvider(),
      { logger: rec.logger },
    );
    await provider.generate(task);
    await provider.generate(task);
    await provider.generate(task);
    expect(rec.warns).toHaveLength(1);
    expect(rec.warns[0]!.msg).toBe('ai.fallback_degrade');
    expect(rec.warns[0]!.fields).toMatchObject({ from: 'local', to: 'mock', errorName: 'AiConfigError' });
    expect(rec.debugs).toBe(2);
  });

  it('honors a custom shouldFallback predicate', async () => {
    const { logger } = recordingLogger();
    const provider = new FallbackContentProvider(
      throwingProvider(new AiProviderError('inference failed')),
      new MockProvider(),
      { logger, shouldFallback: (e) => e instanceof AiConfigError }, // only config errors
    );
    // AiProviderError is no longer a trigger under this predicate → propagates.
    await expect(provider.generate(task)).rejects.toBeInstanceOf(AiProviderError);
  });
});
