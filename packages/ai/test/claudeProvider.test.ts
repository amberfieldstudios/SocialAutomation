import { describe, expect, it, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { ClaudeProvider, DEFAULT_CLAUDE_MODEL } from '../src/claudeProvider';
import { AiConfigError, AiProviderError, AiRefusalError } from '../src/errors';
import type { ContentGenerationTask } from '../src/types';
import { testLogger } from './support';

const baseTask: ContentGenerationTask = {
  kind: 'body',
  platform: 'discord',
  brief: { description: 'We are live streaming the new release tonight at 8pm.' },
  toneInstruction: 'Write a punchy Discord announcement.',
  maxLength: 200,
  targetLength: 150,
};

/** Minimal fake `Anthropic` client — only `messages.create` is ever called by `ClaudeProvider`. */
function fakeClient(create: (...args: unknown[]) => Promise<unknown>): Anthropic {
  return { messages: { create } } as unknown as Anthropic;
}

function messageResponse(text: string, stopReason = 'end_turn') {
  return { content: [{ type: 'text', text }], stop_reason: stopReason };
}

describe('ClaudeProvider', () => {
  it('requires an API key when no client is injected', () => {
    const original = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      expect(() => new ClaudeProvider({ logger: testLogger() })).toThrow(AiConfigError);
    } finally {
      if (original !== undefined) process.env['ANTHROPIC_API_KEY'] = original;
    }
  });

  it('generate() sends a Messages API call and returns the model text', async () => {
    const create = vi.fn().mockResolvedValue(messageResponse('Tune in at 8pm for the release!'));
    const provider = new ClaudeProvider({ logger: testLogger(), client: fakeClient(create) });

    const result = await provider.generate(baseTask);

    expect(result).toBe('Tune in at 8pm for the release!');
    expect(create).toHaveBeenCalledTimes(1);
    const args = create.mock.calls[0]![0] as { model: string; system: string; messages: Array<{ content: string }> };
    expect(args.model).toBe(DEFAULT_CLAUDE_MODEL);
    expect(args.messages[0]!.content).toContain('We are live streaming the new release tonight at 8pm.');
  });

  it('rewrite()/shorten()/expand() build op-specific prompts', async () => {
    const create = vi.fn().mockResolvedValue(messageResponse('ok'));
    const provider = new ClaudeProvider({ logger: testLogger(), client: fakeClient(create) });
    const source = 'Original post body text here.';

    await provider.rewrite({ ...baseTask, sourceText: source });
    await provider.shorten({ ...baseTask, sourceText: source });
    await provider.expand({ ...baseTask, sourceText: source });

    const prompts = create.mock.calls.map((c) => (c[0] as { messages: Array<{ content: string }> }).messages[0]!.content);
    expect(prompts[0]).toMatch(/Rewrite the following text/);
    expect(prompts[1]).toMatch(/Shorten the following text/);
    expect(prompts[2]).toMatch(/Expand the following text/);
  });

  it('truncates output to task.maxLength as a safety net', async () => {
    const longText = 'x'.repeat(500);
    const create = vi.fn().mockResolvedValue(messageResponse(longText));
    const provider = new ClaudeProvider({ logger: testLogger(), client: fakeClient(create) });

    const result = await provider.generate({ ...baseTask, maxLength: 50 });

    expect(result.length).toBeLessThanOrEqual(50);
  });

  it('maps stop_reason "refusal" to AiRefusalError', async () => {
    const create = vi.fn().mockResolvedValue(messageResponse('', 'refusal'));
    const provider = new ClaudeProvider({ logger: testLogger(), client: fakeClient(create) });

    await expect(provider.generate(baseTask)).rejects.toBeInstanceOf(AiRefusalError);
  });

  it('maps a RateLimitError to a retryable AiProviderError', async () => {
    const err = Object.assign(Object.create(Anthropic.RateLimitError.prototype), new Error('rate limited'));
    const create = vi.fn().mockRejectedValue(err);
    const provider = new ClaudeProvider({ logger: testLogger(), client: fakeClient(create) });

    const caught = await provider.generate(baseTask).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(AiProviderError);
    expect((caught as AiProviderError).retryable).toBe(true);
  });

  it('maps a non-retryable error to a non-retryable AiProviderError', async () => {
    const create = vi.fn().mockRejectedValue(new Error('boom'));
    const provider = new ClaudeProvider({ logger: testLogger(), client: fakeClient(create) });

    const caught = await provider.generate(baseTask).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(AiProviderError);
    expect((caught as AiProviderError).retryable).toBe(false);
  });
});
