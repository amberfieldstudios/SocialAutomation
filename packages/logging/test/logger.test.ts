import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logger';
import { isSecretKey, redactFields } from '../src/redact';

function captureLogger(level: 'trace' | 'debug' | 'info' | 'warn' | 'error' = 'trace') {
  const lines: string[] = [];
  const logger = createLogger({ level, sink: (line) => lines.push(line) });
  return { logger, lines, parsed: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

describe('JsonStructuredLogger', () => {
  it('emits one JSON object per line with level and message', () => {
    const { logger, parsed } = captureLogger();
    logger.info('hello world', { accountId: 'acct_1' });
    const [line] = parsed();
    expect(line).toBeDefined();
    expect(line?.level).toBe('info');
    expect(line?.message).toBe('hello world');
    expect(line?.accountId).toBe('acct_1');
    expect(typeof line?.ts).toBe('string');
  });

  it('redacts an access token in the log payload', () => {
    const { logger, parsed } = captureLogger();
    logger.info('token issued', { accessToken: 'super-secret-value', accountId: 'acct_1' });
    const [line] = parsed();
    expect(line?.accessToken).toBe('[REDACTED]');
    expect(line?.accountId).toBe('acct_1');
  });

  it('redacts nested secrets (e.g. a whole TokenSet under "token")', () => {
    const { logger, parsed } = captureLogger();
    logger.error('publish failed', {
      token: { accessToken: 'abc', refreshToken: 'def', scopes: ['posts'] },
      clientSecret: 'shh',
    });
    const [line] = parsed();
    expect(line?.token).toBe('[REDACTED]');
    expect(line?.clientSecret).toBe('[REDACTED]');
  });

  it('redacts bearer-token-shaped string values under unrelated keys', () => {
    const { logger, parsed } = captureLogger();
    logger.info('request made', { authHeaderPreview: 'Bearer abc.def.ghi' });
    const [line] = parsed();
    expect(line?.authHeaderPreview).toBe('[REDACTED]');
  });

  it('drops lines below the configured level', () => {
    const { logger, lines } = captureLogger('warn');
    logger.info('should be dropped');
    logger.warn('should appear');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string).message).toBe('should appear');
  });

  it('child() carries forward bindings and still redacts', () => {
    const { logger, parsed } = captureLogger();
    const child = logger.child({ traceId: 'trace-1', accessToken: 'bound-secret' });
    child.info('child log line');
    const [line] = parsed();
    expect(line?.traceId).toBe('trace-1');
    expect(line?.accessToken).toBe('[REDACTED]');
  });
});

describe('redactFields', () => {
  it('flags common secret key names', () => {
    expect(isSecretKey('accessToken')).toBe(true);
    expect(isSecretKey('refresh_token')).toBe(true);
    expect(isSecretKey('clientSecret')).toBe(true);
    expect(isSecretKey('Authorization')).toBe(true);
    expect(isSecretKey('token')).toBe(true);
    expect(isSecretKey('accountId')).toBe(false);
    expect(isSecretKey('platform')).toBe(false);
  });

  it('handles circular references without throwing', () => {
    const obj: Record<string, unknown> = { name: 'x' };
    obj.self = obj;
    expect(() => redactFields(obj)).not.toThrow();
  });
});
