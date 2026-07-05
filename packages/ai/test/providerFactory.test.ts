import { describe, expect, it } from 'vitest';
import { createContentProvider } from '../src/providerFactory';
import { ClaudeProvider } from '../src/claudeProvider';
import { OpenAiProvider } from '../src/openaiProvider';
import { MockProvider } from '../src/mockProvider';
import { LocalProvider, LOCAL_MODEL_PATH_ENV } from '../src/localProvider';
import { AiConfigError } from '../src/errors';
import { testLogger } from './support';

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const original: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    original[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(original)) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}

describe('createContentProvider', () => {
  it('defaults to claude when AI_PROVIDER is unset', () => {
    withEnv({ AI_PROVIDER: undefined }, () => {
      const provider = createContentProvider({ logger: testLogger(), apiKey: 'test-key' });
      expect(provider).toBeInstanceOf(ClaudeProvider);
      expect(provider.name).toBe('claude');
    });
  });

  it('builds a MockProvider for provider: "mock" (no key required)', () => {
    const provider = createContentProvider({ provider: 'mock', logger: testLogger() });
    expect(provider).toBeInstanceOf(MockProvider);
    expect(provider.name).toBe('mock');
  });

  it('builds a LocalProvider for provider: "local" with a model path (no key required)', () => {
    const provider = createContentProvider({ provider: 'local', logger: testLogger(), modelPath: '/fake/model.gguf' });
    expect(provider).toBeInstanceOf(LocalProvider);
    expect(provider.name).toBe('local');
  });

  it('reads AI_PROVIDER=local and resolves the model path from LOCAL_MODEL_PATH', () => {
    withEnv({ AI_PROVIDER: 'local', [LOCAL_MODEL_PATH_ENV]: '/from/env/model.gguf' }, () => {
      const provider = createContentProvider({ logger: testLogger() });
      expect(provider).toBeInstanceOf(LocalProvider);
    });
  });

  it('throws AiConfigError for provider: "local" when no model path is resolvable', () => {
    withEnv({ [LOCAL_MODEL_PATH_ENV]: undefined }, () => {
      expect(() => createContentProvider({ provider: 'local', logger: testLogger() })).toThrow(AiConfigError);
    });
  });

  it('builds an OpenAiProvider for provider: "openai"', () => {
    const provider = createContentProvider({ provider: 'openai', logger: testLogger(), apiKey: 'test-key' });
    expect(provider).toBeInstanceOf(OpenAiProvider);
    expect(provider.name).toBe('openai');
  });

  it('reads AI_PROVIDER from the environment when not passed explicitly', () => {
    withEnv({ AI_PROVIDER: 'openai' }, () => {
      const provider = createContentProvider({ logger: testLogger(), apiKey: 'test-key' });
      expect(provider).toBeInstanceOf(OpenAiProvider);
    });
  });

  it('throws AiConfigError for an unknown AI_PROVIDER value', () => {
    withEnv({ AI_PROVIDER: 'bogus' }, () => {
      expect(() => createContentProvider({ logger: testLogger() })).toThrow(AiConfigError);
    });
  });

  it('propagates the underlying provider missing-key AiConfigError for claude', () => {
    withEnv({ ANTHROPIC_API_KEY: undefined }, () => {
      expect(() => createContentProvider({ provider: 'claude', logger: testLogger() })).toThrow(AiConfigError);
    });
  });

  it('propagates the underlying provider missing-key AiConfigError for openai', () => {
    withEnv({ OPENAI_API_KEY: undefined }, () => {
      expect(() => createContentProvider({ provider: 'openai', logger: testLogger() })).toThrow(AiConfigError);
    });
  });
});
