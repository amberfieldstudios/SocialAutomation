import { MockAgent, setGlobalDispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { LogFields, OperationContext, PostPayload, StructuredLogger, TokenSet } from '@social/core';
import { NotSupportedError, RateLimitError, TokenRevokedError, ValidationFailedError, supportsOperation } from '@social/core';

import discordManifest from '../src/index';
import { DiscordConnector } from '../src/connector';
import { discordCapabilities } from '../src/capabilities';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

class CapturingLogger implements StructuredLogger {
  constructor(public readonly lines: { level: string; message: string; fields?: LogFields }[] = []) {}
  child(): StructuredLogger {
    return this; // share the same capture buffer across children for assertions
  }
  trace(message: string, fields?: LogFields): void {
    this.lines.push({ level: 'trace', message, fields });
  }
  debug(message: string, fields?: LogFields): void {
    this.lines.push({ level: 'debug', message, fields });
  }
  info(message: string, fields?: LogFields): void {
    this.lines.push({ level: 'info', message, fields });
  }
  warn(message: string, fields?: LogFields): void {
    this.lines.push({ level: 'warn', message, fields });
  }
  error(message: string, fields?: LogFields): void {
    this.lines.push({ level: 'error', message, fields });
  }
}

const BOT_TOKEN = 'super-secret-bot-token-value';
const WEBHOOK_URL = 'https://discord.com/api/webhooks/999888/webhook-secret-token';

function botToken(): TokenSet {
  return { accessToken: BOT_TOKEN, tokenType: 'bot', scopes: [], obtainedAt: new Date().toISOString() };
}

function webhookToken(): TokenSet {
  return { accessToken: WEBHOOK_URL, tokenType: 'webhook', scopes: [], obtainedAt: new Date().toISOString() };
}

function oauthToken(withRefresh = true): TokenSet {
  return {
    accessToken: 'oauth-access-secret',
    ...(withRefresh ? { refreshToken: 'oauth-refresh-secret' } : {}),
    tokenType: 'Bearer',
    scopes: ['identify'],
    expiresAt: new Date(Date.now() - 1000).toISOString(),
    obtainedAt: new Date(Date.now() - 3600_000).toISOString(),
  };
}

function ctx(token: TokenSet, logger: CapturingLogger): OperationContext {
  return { token, app: { clientId: 'app-client-id' }, accountId: 'acct-1', logger };
}

function makeConnector(logger: CapturingLogger): DiscordConnector {
  return new DiscordConnector({ logger, now: () => new Date('2026-07-04T12:00:00.000Z') });
}

let mockAgent: MockAgent;

beforeEach(() => {
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
});

afterEach(async () => {
  await mockAgent.close();
});

// ---------------------------------------------------------------------------
// Manifest / capability shape (conformance: contract completeness)
// ---------------------------------------------------------------------------

describe('plugin manifest', () => {
  it('default-exports a valid PluginManifest matching package.json socialPlugin field', () => {
    expect(discordManifest.platform).toBe('discord');
    expect(discordManifest.contractVersion).toBe('1.1.0');
    expect(discordManifest.capabilities.platform).toBe('discord');
    expect(typeof discordManifest.createConnector).toBe('function');
  });

  it('declares a boolean for all ten operations', () => {
    const ops = discordCapabilities.operations;
    for (const key of ['connect', 'authenticate', 'refreshToken', 'validatePost', 'uploadMedia', 'publish', 'delete', 'edit', 'getAnalytics', 'disconnect'] as const) {
      expect(typeof ops[key]).toBe('boolean');
    }
  });

  it('declares getAnalytics unsupported (Discord bot API has no message analytics endpoint)', () => {
    expect(discordCapabilities.operations.getAnalytics).toBe(false);
    expect(discordCapabilities.supportsAnalytics).toBe(false);
    expect(supportsOperation(discordCapabilities, 'getAnalytics')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validatePost (pure, no network)
// ---------------------------------------------------------------------------

describe('validatePost', () => {
  const connector = makeConnector(new CapturingLogger());

  it('accepts a minimal valid text message', async () => {
    const result = await connector.validatePost({ platform: 'discord', accountId: 'a', text: 'hello world' });
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects content over the 2000-character limit', async () => {
    const result = await connector.validatePost({ platform: 'discord', accountId: 'a', text: 'x'.repeat(2001) });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'text_too_long')).toBe(true);
  });

  it('rejects an empty message (no text, embed, or media)', async () => {
    const result = await connector.validatePost({ platform: 'discord', accountId: 'a' });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'empty_message')).toBe(true);
  });

  it('rejects quoteRemoteId (no native quote-post support)', async () => {
    const result = await connector.validatePost({
      platform: 'discord',
      accountId: 'a',
      text: 'hi',
      quoteRemoteId: 'channel:1:2',
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'quote_not_supported')).toBe(true);
  });

  it('rejects more than 10 embeds and embeds exceeding the 6000-char combined budget', async () => {
    const bigEmbeds = Array.from({ length: 11 }, (_, i) => ({ title: `t${i}` }));
    const result = await connector.validatePost({
      platform: 'discord',
      accountId: 'a',
      platformOptions: { embeds: bigEmbeds },
    });
    expect(result.errors.some((e) => e.code === 'too_many_embeds')).toBe(true);
  });

  it('rejects media over 10 attachments', async () => {
    const media = Array.from({ length: 11 }, (_, i) => ({
      assetId: `m${i}`,
      mimeType: 'image/png',
      uri: `data:image/png;base64,AA==`,
    }));
    const result = await connector.validatePost({ platform: 'discord', accountId: 'a', text: 'hi', media });
    expect(result.errors.some((e) => e.code === 'too_many_media')).toBe(true);
  });

  it('warns (not errors) when hashtags are supplied, since Discord has no hashtag feature', async () => {
    const result = await connector.validatePost({ platform: 'discord', accountId: 'a', text: 'hi', tags: ['launch'] });
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.code === 'hashtags_cosmetic_only')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// publish — validate-before-publish, bot path, webhook path, embeds/buttons/mentions
// ---------------------------------------------------------------------------

describe('publish', () => {
  it('refuses to publish a payload validatePost would reject (never "tries anyway")', async () => {
    const logger = new CapturingLogger();
    const connector = makeConnector(logger);
    const payload: PostPayload = { platform: 'discord', accountId: 'a', text: 'x'.repeat(3000) };
    await expect(connector.publish(payload, ctx(botToken(), logger))).rejects.toBeInstanceOf(ValidationFailedError);
    // No HTTP call should have been attempted — MockAgent has no interceptors registered,
    // so any fetch would throw a MockNotMatchedError; success here proves we short-circuited.
  });

  it('publishes via the bot API with role pings, embeds, and buttons', async () => {
    const logger = new CapturingLogger();
    const connector = makeConnector(logger);
    const pool = mockAgent.get('https://discord.com');
    let capturedBody: unknown;
    pool
      .intercept({
        path: '/api/v10/channels/555/messages',
        method: 'POST',
      })
      .reply((opts) => {
        capturedBody = JSON.parse(String(opts.body));
        return { statusCode: 200, data: JSON.stringify({ id: 'msg-1', channel_id: '555', timestamp: '2026-07-04T12:00:00.000Z' }) };
      });

    const payload: PostPayload = {
      platform: 'discord',
      accountId: 'a',
      text: 'New announcement!',
      platformOptions: {
        channelId: '555',
        roleMentionIds: ['123456789012345678'],
        embeds: [{ title: 'Big News', description: 'Details here' }],
        components: [{ type: 1, components: [{ type: 2, style: 5, label: 'Learn more', url: 'https://example.com' }] }],
      },
    };

    const result = await connector.publish(payload, ctx(botToken(), logger));
    expect(result.remoteId).toBe('msg-1');
    expect(result.target).toEqual({ channelId: '555', extra: { kind: 'channel' } });
    expect(result.remoteUrl).toContain('555/msg-1');

    const body = capturedBody as Record<string, unknown>;
    expect(body.content).toBe('<@&123456789012345678> New announcement!');
    expect((body.allowed_mentions as { roles: string[] }).roles).toContain('123456789012345678');
    expect(Array.isArray(body.embeds)).toBe(true);
    expect(Array.isArray(body.components)).toBe(true);

    // Token redaction: the raw bot token must never appear in a log line.
    const serializedLogs = JSON.stringify(logger.lines);
    expect(serializedLogs.includes(BOT_TOKEN)).toBe(false);
  });

  it('publishes via a webhook credential using the webhook execute endpoint', async () => {
    const logger = new CapturingLogger();
    const connector = makeConnector(logger);
    const pool = mockAgent.get('https://discord.com');
    pool
      .intercept({ path: '/api/webhooks/999888/webhook-secret-token?wait=true', method: 'POST' })
      .reply(200, { id: 'wh-msg-1', channel_id: '777', timestamp: '2026-07-04T12:00:00.000Z' });

    const payload: PostPayload = { platform: 'discord', accountId: 'a', text: 'via webhook' };
    const result = await connector.publish(payload, ctx(webhookToken(), logger));

    // Regression (t15/security): the webhook's secret token must NEVER appear in the persisted
    // PublishResult.remoteId/target — only the non-secret webhook id and message id.
    expect(result.remoteId).toBe('wh-msg-1');
    expect(result.target).toEqual({ extra: { kind: 'webhook', webhookId: '999888' } });
    expect(JSON.stringify(result.target)).not.toContain('webhook-secret-token');
    const serializedLogs = JSON.stringify(logger.lines);
    expect(serializedLogs.includes('webhook-secret-token')).toBe(false);
  });

  it('creates a thread from the published message when platformOptions.createThread is set (bot path)', async () => {
    const logger = new CapturingLogger();
    const connector = makeConnector(logger);
    const pool = mockAgent.get('https://discord.com');
    pool
      .intercept({ path: '/api/v10/channels/555/messages', method: 'POST' })
      .reply(200, { id: 'msg-2', channel_id: '555', timestamp: '2026-07-04T12:00:00.000Z' });
    pool
      .intercept({ path: '/api/v10/channels/555/messages/msg-2/threads', method: 'POST' })
      .reply(200, { id: 'thread-1' });

    const payload: PostPayload = {
      platform: 'discord',
      accountId: 'a',
      text: 'kicking off a thread',
      platformOptions: { channelId: '555', createThread: { name: 'Discussion' } },
    };
    const result = await connector.publish(payload, ctx(botToken(), logger));
    expect(result.remoteId).toBe('msg-2');
    expect(result.target).toEqual({ channelId: '555', extra: { kind: 'channel' } });
  });

  it('publishes a thread[] chain as sequential replies and returns all remote ids in order', async () => {
    const logger = new CapturingLogger();
    const connector = makeConnector(logger);
    const pool = mockAgent.get('https://discord.com');
    pool
      .intercept({ path: '/api/v10/channels/555/messages', method: 'POST' })
      .reply(200, { id: 'root', channel_id: '555', timestamp: '2026-07-04T12:00:00.000Z' });
    pool
      .intercept({ path: '/api/v10/channels/555/messages', method: 'POST' })
      .reply(200, { id: 'reply-1', channel_id: '555', timestamp: '2026-07-04T12:00:01.000Z' });

    const payload: PostPayload = {
      platform: 'discord',
      accountId: 'a',
      text: 'part 1',
      platformOptions: { channelId: '555' },
      thread: [{ platform: 'discord', accountId: 'a', text: 'part 2' }],
    };
    const result = await connector.publish(payload, ctx(botToken(), logger));
    expect(result.threadRemoteIds).toEqual(['root', 'reply-1']);
  });

  it('maps a 429 response into a retryable RateLimitError with retryAfterMs', async () => {
    const logger = new CapturingLogger();
    const connector = makeConnector(logger);
    const pool = mockAgent.get('https://discord.com');
    pool
      .intercept({ path: '/api/v10/channels/555/messages', method: 'POST' })
      .reply(429, { message: 'rate limited', retry_after: 1.5 }, { headers: { 'retry-after': '1.5' } });

    const payload: PostPayload = { platform: 'discord', accountId: 'a', text: 'hi', platformOptions: { channelId: '555' } };
    const error = await connector.publish(payload, ctx(botToken(), logger)).catch((e) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBe(1500);
  });

  it('maps a 401 response into a non-retryable TokenRevokedError', async () => {
    const logger = new CapturingLogger();
    const connector = makeConnector(logger);
    const pool = mockAgent.get('https://discord.com');
    pool.intercept({ path: '/api/v10/channels/555/messages', method: 'POST' }).reply(401, { message: 'Unauthorized' });

    const payload: PostPayload = { platform: 'discord', accountId: 'a', text: 'hi', platformOptions: { channelId: '555' } };
    const error = await connector.publish(payload, ctx(botToken(), logger)).catch((e) => e);
    expect(error).toBeInstanceOf(TokenRevokedError);
    expect(error.retryable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// delete / edit — typed target convention (Contract v1.1)
// ---------------------------------------------------------------------------

describe('delete + edit', () => {
  it('deletes a bot-channel message using the typed target', async () => {
    const logger = new CapturingLogger();
    const connector = makeConnector(logger);
    const pool = mockAgent.get('https://discord.com');
    pool.intercept({ path: '/api/v10/channels/555/messages/msg-1', method: 'DELETE' }).reply(204, '');

    const result = await connector.delete({ remoteId: 'msg-1', target: { channelId: '555' } }, ctx(botToken(), logger));
    expect(result.removed).toBe(true);
  });

  it('deletes a bot-channel message addressed via the legacy composite remoteId (back-compat)', async () => {
    const logger = new CapturingLogger();
    const connector = makeConnector(logger);
    const pool = mockAgent.get('https://discord.com');
    pool.intercept({ path: '/api/v10/channels/555/messages/msg-1', method: 'DELETE' }).reply(204, '');

    const result = await connector.delete({ remoteId: 'channel:555:msg-1' }, ctx(botToken(), logger));
    expect(result.removed).toBe(true);
  });

  it('deletes a webhook message by sourcing the webhook token from ctx.token, not the target/remoteId', async () => {
    const logger = new CapturingLogger();
    const connector = makeConnector(logger);
    const pool = mockAgent.get('https://discord.com');
    // Non-secret target (as produced by publish()); the token comes only from ctx.token.
    pool.intercept({ path: '/api/webhooks/999888/webhook-secret-token/messages/wh-msg-1', method: 'DELETE' }).reply(204, '');

    const result = await connector.delete(
      { remoteId: 'wh-msg-1', target: { extra: { kind: 'webhook', webhookId: '999888' } } },
      ctx(webhookToken(), logger),
    );
    expect(result.removed).toBe(true);
    const serializedLogs = JSON.stringify(logger.lines);
    expect(serializedLogs.includes('webhook-secret-token')).toBe(false);
  });

  it('edits a webhook message using the typed target, sourcing the token from ctx.token', async () => {
    const logger = new CapturingLogger();
    const connector = makeConnector(logger);
    const pool = mockAgent.get('https://discord.com');
    pool
      .intercept({ path: '/api/webhooks/999888/webhook-secret-token/messages/wh-msg-1', method: 'PATCH' })
      .reply(200, { id: 'wh-msg-1', channel_id: '777', timestamp: '2026-07-04T13:00:00.000Z' });

    const result = await connector.edit(
      {
        remoteId: 'wh-msg-1',
        target: { extra: { kind: 'webhook', webhookId: '999888' } },
        payload: { platform: 'discord', accountId: 'a', text: 'updated' },
      },
      ctx(webhookToken(), logger),
    );
    // Regression (t15/security): the returned/persisted remoteId still carries no secret token.
    expect(result.remoteId).toBe('wh-msg-1');
    const serializedLogs = JSON.stringify(logger.lines);
    expect(serializedLogs.includes('webhook-secret-token')).toBe(false);
  });

  it('refuses to delete/edit a webhook-addressed message when ctx.token is not a webhook credential', async () => {
    const logger = new CapturingLogger();
    const connector = makeConnector(logger);
    const target = { extra: { kind: 'webhook', webhookId: '999888' } };

    await expect(connector.delete({ remoteId: 'wh-msg-1', target }, ctx(botToken(), logger))).rejects.toThrow(
      /requires a webhook credential/,
    );
    await expect(
      connector.edit(
        { remoteId: 'wh-msg-1', target, payload: { platform: 'discord', accountId: 'a', text: 'updated' } },
        ctx(botToken(), logger),
      ),
    ).rejects.toThrow(/requires a webhook credential/);
  });

  it('refuses to edit a payload validatePost would reject', async () => {
    const logger = new CapturingLogger();
    const connector = makeConnector(logger);
    await expect(
      connector.edit(
        {
          remoteId: 'msg-1',
          target: { channelId: '555' },
          payload: { platform: 'discord', accountId: 'a', text: 'x'.repeat(3000) },
        },
        ctx(botToken(), logger),
      ),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });
});

// ---------------------------------------------------------------------------
// getAnalytics — declared-unsupported / NotSupportedError pairing
// ---------------------------------------------------------------------------

describe('getAnalytics (declared unsupported)', () => {
  it('throws NotSupportedError and never calls the network', async () => {
    const logger = new CapturingLogger();
    const connector = makeConnector(logger);
    await expect(connector.getAnalytics({ remoteId: 'msg-1', target: { channelId: '1' } }, ctx(botToken(), logger))).rejects.toBeInstanceOf(
      NotSupportedError,
    );
  });
});

// ---------------------------------------------------------------------------
// refreshToken — credential-shape-dependent behavior via capabilitiesFor (Contract v1.1, README "Contract v1.1" #2)
// ---------------------------------------------------------------------------

describe('refreshToken', () => {
  it('throws NotSupportedError for bot tokens, which capabilitiesFor declares unsupported', async () => {
    const logger = new CapturingLogger();
    const connector = makeConnector(logger);
    await expect(connector.refreshToken({ app: { clientId: 'app1' }, token: botToken() })).rejects.toBeInstanceOf(
      NotSupportedError,
    );
  });

  it('throws NotSupportedError for webhook tokens, which capabilitiesFor declares unsupported', async () => {
    const logger = new CapturingLogger();
    const connector = makeConnector(logger);
    await expect(connector.refreshToken({ app: { clientId: 'app1' }, token: webhookToken() })).rejects.toBeInstanceOf(
      NotSupportedError,
    );
  });

  it('capabilitiesFor declares refreshToken/disconnect false for bot tokens, true for OAuth2', () => {
    const logger = new CapturingLogger();
    const connector = makeConnector(logger);
    expect(connector.capabilitiesFor?.(botToken()).operations.refreshToken).toBe(false);
    expect(connector.capabilitiesFor?.(botToken()).operations.disconnect).toBe(false);
    expect(connector.capabilitiesFor?.(oauthToken()).operations.refreshToken).toBe(true);
    expect(connector.capabilitiesFor?.(oauthToken()).operations.disconnect).toBe(true);
  });

  it('refreshes an OAuth2 token via the documented token endpoint (form-encoded)', async () => {
    const logger = new CapturingLogger();
    const connector = makeConnector(logger);
    const pool = mockAgent.get('https://discord.com');
    let capturedBody = '';
    pool
      .intercept({ path: '/api/v10/oauth2/token', method: 'POST' })
      .reply((opts) => {
        capturedBody = String(opts.body);
        return {
          statusCode: 200,
          data: JSON.stringify({ access_token: 'new-access', token_type: 'Bearer', expires_in: 604800, refresh_token: 'new-refresh', scope: 'identify' }),
        };
      });

    const fresh = await connector.refreshToken({ app: { clientId: 'app1', clientSecret: 'shh' }, token: oauthToken() });
    expect(fresh.accessToken).toBe('new-access');
    expect(fresh.refreshToken).toBe('new-refresh');
    expect(capturedBody).toContain('grant_type=refresh_token');
    expect(capturedBody).toContain('refresh_token=oauth-refresh-secret');
  });
});

// ---------------------------------------------------------------------------
// disconnect
// ---------------------------------------------------------------------------

describe('disconnect', () => {
  it('throws NotSupportedError for a bot token, which capabilitiesFor declares unsupported', async () => {
    const logger = new CapturingLogger();
    const connector = makeConnector(logger);
    await expect(connector.disconnect(ctx(botToken(), logger))).rejects.toBeInstanceOf(NotSupportedError);
  });

  it('throws NotSupportedError for a webhook token, which capabilitiesFor declares unsupported', async () => {
    const logger = new CapturingLogger();
    const connector = makeConnector(logger);
    await expect(connector.disconnect(ctx(webhookToken(), logger))).rejects.toBeInstanceOf(NotSupportedError);
  });

  it('revokes an OAuth2 token via the documented revoke endpoint', async () => {
    const logger = new CapturingLogger();
    const connector = makeConnector(logger);
    const pool = mockAgent.get('https://discord.com');
    pool.intercept({ path: '/api/v10/oauth2/token/revoke', method: 'POST' }).reply(200, '');

    const result = await connector.disconnect(ctx(oauthToken(), logger));
    expect(result.revoked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// connect
// ---------------------------------------------------------------------------

describe('connect', () => {
  it('verifies reachability via the public /gateway endpoint when no token is supplied', async () => {
    const logger = new CapturingLogger();
    const connector = makeConnector(logger);
    const pool = mockAgent.get('https://discord.com');
    pool.intercept({ path: '/api/v10/gateway', method: 'GET' }).reply(200, { url: 'wss://gateway.discord.gg' });

    const result = await connector.connect({ app: { clientId: 'app1' } });
    expect(result.ready).toBe(true);
    expect(result.platform).toBe('discord');
  });

  it('verifies a bot token via GET /users/@me', async () => {
    const logger = new CapturingLogger();
    const connector = makeConnector(logger);
    const pool = mockAgent.get('https://discord.com');
    pool.intercept({ path: '/api/v10/users/@me', method: 'GET' }).reply(200, { id: 'bot-1', username: 'MyBot' });

    const result = await connector.connect({ app: { clientId: 'app1' }, token: botToken() });
    expect(result.ready).toBe(true);
  });
});
