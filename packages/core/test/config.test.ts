import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, redactedConfigSummary } from '../src/config';

describe('loadConfig', () => {
  it('applies dev-friendly defaults (SQLite) when nothing is set', () => {
    const config = loadConfig({ env: {} });
    expect(config.nodeEnv).toBe('development');
    expect(config.database.driver).toBe('sqlite');
    expect(config.database.url).toBe('./data/dev.sqlite');
    expect(config.plugins.globs).toEqual(['plugins/*']);
    expect(config.logLevel).toBe('info');
  });

  it('overrides defaults from environment variables', () => {
    const config = loadConfig({
      env: {
        NODE_ENV: 'production',
        SOCIAL_LOG_LEVEL: 'debug',
        SOCIAL_DB_DRIVER: 'postgres',
        SOCIAL_DB_URL: 'postgres://example/db',
        SOCIAL_PLUGIN_GLOBS: 'plugins/*, extra-plugins/*',
      },
    });
    expect(config.nodeEnv).toBe('production');
    expect(config.logLevel).toBe('debug');
    expect(config.database).toEqual({ driver: 'postgres', url: 'postgres://example/db' });
    expect(config.plugins.globs).toEqual(['plugins/*', 'extra-plugins/*']);
  });

  it('rejects an invalid value with a ConfigError', () => {
    expect(() => loadConfig({ env: { SOCIAL_LOG_LEVEL: 'not-a-level' } })).toThrow(ConfigError);
  });
});

describe('redactedConfigSummary', () => {
  it('never includes secret-shaped keys even if config is extended', () => {
    const config = loadConfig({ env: {} });
    const withSecret = { ...config, apiKey: 'super-secret' } as typeof config & { apiKey: string };
    const summary = redactedConfigSummary(withSecret);
    expect(summary.apiKey).toBe('[REDACTED]');
  });
});
