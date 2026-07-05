import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  LocalProvider,
  isLocalModelAvailable,
  resolveLocalModelPath,
  LOCAL_MODEL_PATH_ENV,
  type LocalChatSession,
  type LocalLlmRuntime,
  type LocalLoadedModel,
  type LocalPromptOptions,
} from '../src/localProvider';
import { CampaignGenerator } from '../src/campaignGenerator';
import { AiConfigError, AiProviderError } from '../src/errors';
import type { ContentGenerationTask } from '../src/types';
import { measureLength } from '../src/text';
import { testLogger } from './support';
import { blueskyCapabilities, discordCapabilities, twitchCapabilities } from './fixtures';

const baseTask: ContentGenerationTask = {
  kind: 'body',
  platform: 'discord',
  brief: { description: 'We are live streaming the new release tonight at 8pm.', link: 'https://ex.co/live' },
  toneInstruction: 'Write a punchy Discord announcement.',
  maxLength: 200,
  targetLength: 150,
};

/**
 * A fully in-memory `LocalLlmRuntime`. It records every prompt it is asked to
 * complete and returns whatever `respond(prompt, systemPrompt)` produces, so a
 * test can prove exactly what text LocalProvider sent the model — no native
 * binary, no GGUF file. This is the stub the task calls for.
 */
function stubRuntime(
  respond: (prompt: string, systemPrompt: string, options: LocalPromptOptions) => string,
) {
  const prompts: Array<{ prompt: string; systemPrompt: string; options: LocalPromptOptions }> = [];
  let loadCount = 0;
  let sessionCount = 0;
  let disposed = false;

  const runtime: LocalLlmRuntime = {
    async loadModel(modelPath: string): Promise<LocalLoadedModel> {
      loadCount += 1;
      void modelPath;
      return {
        async createSession(systemPrompt: string): Promise<LocalChatSession> {
          sessionCount += 1;
          return {
            async prompt(prompt: string, options: LocalPromptOptions): Promise<string> {
              prompts.push({ prompt, systemPrompt, options });
              return respond(prompt, systemPrompt, options);
            },
          };
        },
        async dispose(): Promise<void> {
          disposed = true;
        },
      };
    },
  };

  return {
    runtime,
    prompts,
    get loadCount() {
      return loadCount;
    },
    get sessionCount() {
      return sessionCount;
    },
    get disposed() {
      return disposed;
    },
  };
}

function makeProvider(respond: (prompt: string, systemPrompt: string) => string, extra: Record<string, unknown> = {}) {
  const stub = stubRuntime((p, s) => respond(p, s));
  const provider = new LocalProvider({
    logger: testLogger(),
    modelPath: '/fake/model.gguf',
    runtime: stub.runtime,
    ...extra,
  });
  return { provider, stub };
}

describe('LocalProvider — configuration & lazy loading', () => {
  it('requires a model path (no credentials, but a model is mandatory)', () => {
    const original = process.env[LOCAL_MODEL_PATH_ENV];
    delete process.env[LOCAL_MODEL_PATH_ENV];
    try {
      expect(() => new LocalProvider({ logger: testLogger() })).toThrow(AiConfigError);
    } finally {
      if (original !== undefined) process.env[LOCAL_MODEL_PATH_ENV] = original;
    }
  });

  it('constructing never loads the model (no native binary touched at import/construct time)', () => {
    const { stub } = makeProvider(() => 'x');
    expect(stub.loadCount).toBe(0);
  });

  it('reports its stable name as "local" and needs no API key', () => {
    const { provider } = makeProvider(() => 'x');
    expect(provider.name).toBe('local');
  });

  it('loads the model at most once across many calls (memoised)', async () => {
    const { provider, stub } = makeProvider(() => 'body text');
    await provider.generate(baseTask);
    await provider.rewrite({ ...baseTask, sourceText: 'src' });
    await provider.generate(baseTask);
    expect(stub.loadCount).toBe(1);
  });
});

describe('LocalProvider — prompt construction goes through promptBuilder', () => {
  it('generate() sends the brief and the shared SYSTEM_PROMPT', async () => {
    const { provider, stub } = makeProvider(() => 'Tune in tonight!');
    const result = await provider.generate(baseTask);

    expect(result).toBe('Tune in tonight!');
    expect(stub.prompts).toHaveLength(1);
    expect(stub.prompts[0]!.prompt).toContain('We are live streaming the new release tonight at 8pm.');
    // The link must be referenced in the prompt (preserved verbatim, not invented).
    expect(stub.prompts[0]!.prompt).toContain('https://ex.co/live');
    expect(stub.prompts[0]!.systemPrompt).toContain('platform-native social media copy');
  });

  it('rewrite()/shorten()/expand() build op-specific prompts', async () => {
    const { provider, stub } = makeProvider(() => 'ok');
    const source = 'Original post body text here.';
    await provider.rewrite({ ...baseTask, sourceText: source });
    await provider.shorten({ ...baseTask, sourceText: source });
    await provider.expand({ ...baseTask, sourceText: source });

    const prompts = stub.prompts.map((p) => p.prompt);
    expect(prompts[0]).toMatch(/Rewrite the following text/);
    expect(prompts[1]).toMatch(/Shorten the following text/);
    expect(prompts[2]).toMatch(/Expand the following text/);
  });

  it('passes the configured sampling options to the session', async () => {
    const { provider, stub } = makeProvider(() => 'x', { maxTokens: 128, temperature: 0.5, topP: 0.7 });
    await provider.generate(baseTask);
    expect(stub.prompts[0]!.options).toEqual({ maxTokens: 128, temperature: 0.5, topP: 0.7 });
  });
});

describe('LocalProvider — output post-processing (ContentProvider contract)', () => {
  it('truncates model output to task.maxLength as a safety net', async () => {
    const { provider } = makeProvider(() => 'x'.repeat(500));
    const result = await provider.generate({ ...baseTask, maxLength: 50 });
    expect(result.length).toBeLessThanOrEqual(50);
  });

  it('never trims grapheme-counted output past the Bluesky budget', async () => {
    const { provider } = makeProvider(() => '🎉'.repeat(400));
    const result = await provider.generate({ ...baseTask, maxLength: 300, countGraphemes: true });
    expect(measureLength(result, true)).toBeLessThanOrEqual(300);
  });
});

describe('LocalProvider — failure surfaces for the fallback chain (t5)', () => {
  it('maps a model-load failure to AiConfigError (so a caller can fall back)', async () => {
    const runtime: LocalLlmRuntime = {
      async loadModel(): Promise<LocalLoadedModel> {
        throw new Error('node-llama-cpp native binary not found');
      },
    };
    const provider = new LocalProvider({ logger: testLogger(), modelPath: '/fake/model.gguf', runtime });
    await expect(provider.generate(baseTask)).rejects.toBeInstanceOf(AiConfigError);
  });

  it('retries the load on a subsequent call after a load failure', async () => {
    let attempts = 0;
    const runtime: LocalLlmRuntime = {
      async loadModel(): Promise<LocalLoadedModel> {
        attempts += 1;
        if (attempts === 1) throw new Error('transient');
        return {
          async createSession(): Promise<LocalChatSession> {
            return { async prompt(): Promise<string> {
              return 'recovered';
            } };
          },
          async dispose(): Promise<void> {},
        };
      },
    };
    const provider = new LocalProvider({ logger: testLogger(), modelPath: '/fake/model.gguf', runtime });
    await expect(provider.generate(baseTask)).rejects.toBeInstanceOf(AiConfigError);
    await expect(provider.generate(baseTask)).resolves.toBe('recovered');
    expect(attempts).toBe(2);
  });

  it('maps an inference failure (model loaded, prompt throws) to a non-retryable AiProviderError', async () => {
    const runtime: LocalLlmRuntime = {
      async loadModel(): Promise<LocalLoadedModel> {
        return {
          async createSession(): Promise<LocalChatSession> {
            return { async prompt(): Promise<string> {
              throw new Error('inference exploded');
            } };
          },
          async dispose(): Promise<void> {},
        };
      },
    };
    const provider = new LocalProvider({ logger: testLogger(), modelPath: '/fake/model.gguf', runtime });
    const caught = await provider.generate(baseTask).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(AiProviderError);
    expect((caught as AiProviderError).retryable).toBe(false);
  });
});

describe('LocalProvider — drives CampaignGenerator with per-platform formatting', () => {
  // Feed a realistic model that just echoes the brief; CampaignGenerator applies
  // the platform profile (limits, hashtag rules, titleOnly, etc.). This proves
  // the provider satisfies the same contract the mock/claude providers do.
  function campaignProvider() {
    const stub = stubRuntime((prompt) => {
      // Emulate a hashtag-kind response when the prompt asks for hashtags.
      if (/Generate up to \d+ relevant hashtags/.test(prompt)) return 'gaming release live';
      return 'We are live tonight with the brand new release — come hang out!';
    });
    return new LocalProvider({ logger: testLogger(), modelPath: '/fake/model.gguf', runtime: stub.runtime });
  }

  const brief = {
    description: 'We just shipped multiplayer racing across ten tracks, live today.',
    link: 'https://example.com/racing',
    tags: ['racing'],
    cta: 'Try it now',
  };

  it('Discord variant: within limit, no fabricated hashtags, link preserved', async () => {
    const gen = new CampaignGenerator(campaignProvider(), testLogger());
    const { payload } = await gen.generateVariant(brief, {
      platform: 'discord',
      accountId: 'a-discord',
      capabilities: discordCapabilities,
    });
    expect(measureLength(payload.text ?? '')).toBeLessThanOrEqual(discordCapabilities.characterLimit);
    expect(payload.tags).toBeUndefined();
    expect(payload.text ?? '').toContain('https://example.com/racing');
  });

  it('Bluesky variant: within the 300-grapheme limit', async () => {
    const gen = new CampaignGenerator(campaignProvider(), testLogger());
    const { payload } = await gen.generateVariant(brief, {
      platform: 'bluesky',
      accountId: 'a-bsky',
      capabilities: blueskyCapabilities,
    });
    expect(measureLength(payload.text ?? '', true)).toBeLessThanOrEqual(blueskyCapabilities.characterLimit);
  });

  it('Twitch variant: title-only field within the title limit', async () => {
    const gen = new CampaignGenerator(campaignProvider(), testLogger());
    const { payload } = await gen.generateVariant(brief, {
      platform: 'twitch',
      accountId: 'a-twitch',
      capabilities: twitchCapabilities,
    });
    const titleLimit = twitchCapabilities.titleCharacterLimit ?? twitchCapabilities.characterLimit;
    expect(payload.title).toBeDefined();
    expect(measureLength(payload.title ?? '')).toBeLessThanOrEqual(titleLimit);
  });
});

describe('model-presence helpers (the seam for the download manager, t4)', () => {
  it('resolveLocalModelPath prefers the explicit arg, then the env var', () => {
    const original = process.env[LOCAL_MODEL_PATH_ENV];
    try {
      process.env[LOCAL_MODEL_PATH_ENV] = '/from/env.gguf';
      expect(resolveLocalModelPath('/explicit.gguf')).toBe('/explicit.gguf');
      expect(resolveLocalModelPath()).toBe('/from/env.gguf');
      delete process.env[LOCAL_MODEL_PATH_ENV];
      expect(resolveLocalModelPath()).toBeUndefined();
    } finally {
      if (original !== undefined) process.env[LOCAL_MODEL_PATH_ENV] = original;
      else delete process.env[LOCAL_MODEL_PATH_ENV];
    }
  });

  it('isLocalModelAvailable is false for undefined / missing files', () => {
    expect(isLocalModelAvailable(undefined)).toBe(false);
    expect(isLocalModelAvailable('/definitely/not/here/model.gguf')).toBe(false);
  });

  it('isLocalModelAvailable is true for an existing regular file', () => {
    // This test file itself is a regular file that exists.
    expect(isLocalModelAvailable(fileURLToPath(import.meta.url))).toBe(true);
  });
});
