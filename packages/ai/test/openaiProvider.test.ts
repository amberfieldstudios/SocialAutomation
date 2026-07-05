import { describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import { OpenAiProvider, DEFAULT_OPENAI_MODEL } from '../src/openaiProvider';
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

/** Minimal fake `OpenAI` client — only `chat.completions.create` is ever called by `OpenAiProvider`. */
function fakeClient(create: (...args: unknown[]) => Promise<unknown>): OpenAI {
  return {
    chat: { completions: { create } },
  } as unknown as OpenAI;
}

function chatResponse(content: string) {
  return {
    choices: [{ message: { content }, finish_reason: 'stop' }],
  };
}

describe('OpenAiProvider', () => {
  it('requires an API key when no client is injected', () => {
    const original = process.env['OPENAI_API_KEY'];
    delete process.env['OPENAI_API_KEY'];
    try {
      expect(() => new OpenAiProvider({ logger: testLogger() })).toThrow(AiConfigError);
    } finally {
      if (original !== undefined) process.env['OPENAI_API_KEY'] = original;
    }
  });

  it('generate() sends a chat completion and returns the model text', async () => {
    const create = vi.fn().mockResolvedValue(chatResponse('Tune in at 8pm for the release!'));
    const provider = new OpenAiProvider({ logger: testLogger(), client: fakeClient(create) });

    const result = await provider.generate(baseTask);

    expect(result).toBe('Tune in at 8pm for the release!');
    expect(create).toHaveBeenCalledTimes(1);
    const args = create.mock.calls[0]![0] as { model: string; messages: Array<{ role: string; content: string }> };
    expect(args.model).toBe(DEFAULT_OPENAI_MODEL);
    expect(args.messages[0]!.role).toBe('system');
    expect(args.messages[1]!.role).toBe('user');
    expect(args.messages[1]!.content).toContain('We are live streaming the new release tonight at 8pm.');
  });

  it('rewrite()/shorten()/expand() build op-specific prompts', async () => {
    const create = vi.fn().mockResolvedValue(chatResponse('ok'));
    const provider = new OpenAiProvider({ logger: testLogger(), client: fakeClient(create) });
    const source = 'Original post body text here.';

    await provider.rewrite({ ...baseTask, sourceText: source });
    await provider.shorten({ ...baseTask, sourceText: source });
    await provider.expand({ ...baseTask, sourceText: source });

    expect(create).toHaveBeenCalledTimes(3);
    const prompts = create.mock.calls.map((c) => (c[0] as { messages: Array<{ content: string }> }).messages[1]!.content);
    expect(prompts[0]).toMatch(/Rewrite the following text/);
    expect(prompts[1]).toMatch(/Shorten the following text/);
    expect(prompts[2]).toMatch(/Expand the following text/);
  });

  it('truncates output to task.maxLength as a safety net', async () => {
    const longText = 'x'.repeat(500);
    const create = vi.fn().mockResolvedValue(chatResponse(longText));
    const provider = new OpenAiProvider({ logger: testLogger(), client: fakeClient(create) });

    const result = await provider.generate({ ...baseTask, maxLength: 50 });

    expect(result.length).toBeLessThanOrEqual(50);
  });

  it('maps a message.refusal to AiRefusalError', async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: null, refusal: 'This request violates the usage policy.' }, finish_reason: 'stop' }],
    });
    const provider = new OpenAiProvider({ logger: testLogger(), client: fakeClient(create) });

    await expect(provider.generate(baseTask)).rejects.toBeInstanceOf(AiRefusalError);
  });

  it('maps a content_filter finish_reason to AiRefusalError', async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: null }, finish_reason: 'content_filter' }],
    });
    const provider = new OpenAiProvider({ logger: testLogger(), client: fakeClient(create) });

    await expect(provider.generate(baseTask)).rejects.toBeInstanceOf(AiRefusalError);
  });

  it('maps a RateLimitError to a retryable AiProviderError', async () => {
    const err = Object.assign(Object.create(OpenAI.RateLimitError.prototype), new Error('rate limited'));
    const create = vi.fn().mockRejectedValue(err);
    const provider = new OpenAiProvider({ logger: testLogger(), client: fakeClient(create) });

    await expect(provider.generate(baseTask)).rejects.toMatchObject({ name: 'AiProviderError', retryable: true });
  });

  it('maps an InternalServerError to a retryable AiProviderError', async () => {
    const err = Object.assign(Object.create(OpenAI.InternalServerError.prototype), new Error('server error'));
    const create = vi.fn().mockRejectedValue(err);
    const provider = new OpenAiProvider({ logger: testLogger(), client: fakeClient(create) });

    const caught = await provider.generate(baseTask).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(AiProviderError);
    expect((caught as AiProviderError).retryable).toBe(true);
  });

  it('maps a non-retryable error (e.g. BadRequestError) to a non-retryable AiProviderError', async () => {
    const err = Object.assign(Object.create(OpenAI.BadRequestError.prototype), new Error('bad request'));
    const create = vi.fn().mockRejectedValue(err);
    const provider = new OpenAiProvider({ logger: testLogger(), client: fakeClient(create) });

    const caught = await provider.generate(baseTask).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(AiProviderError);
    expect((caught as AiProviderError).retryable).toBe(false);
  });
});
