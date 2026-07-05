import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createAppContext, type AppContext } from '../src/context';
import { createServer } from '../src/server';

let ctx: AppContext;
let app: FastifyInstance;

beforeEach(async () => {
  ctx = await createAppContext({ dbFile: ':memory:' });
  app = await createServer(ctx);
});

afterEach(async () => {
  await app.close();
  ctx.close();
});

describe('GET /api/health', () => {
  it('reports ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});

describe('accounts', () => {
  it('adds, lists, and removes an account without ever serializing secrets', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { platformId: 'discord', remoteId: 'guild-1', handle: 'test-guild', displayName: 'Test Guild' },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json();
    expect(created.account.id).toBeTruthy();
    expect(created.account.status).toBe('active');

    // Never return token/secret-shaped fields, even nested/serialized as text.
    const rawBody = create.body.toLowerCase();
    for (const forbidden of ['accesstoken', 'refreshtoken', 'ciphertext', 'nonce', 'authtag', '"token"']) {
      expect(rawBody).not.toContain(forbidden);
    }

    const list = await app.inject({ method: 'GET', url: '/api/accounts' });
    expect(list.statusCode).toBe(200);
    const { accounts } = list.json();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].platformId).toBe('discord');

    const del = await app.inject({ method: 'DELETE', url: `/api/accounts/${created.account.id}` });
    expect(del.statusCode).toBe(204);

    const listAfter = await app.inject({ method: 'GET', url: '/api/accounts' });
    expect(listAfter.json().accounts).toHaveLength(0);
  });

  it('404s reconnecting an unknown account', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/accounts/does-not-exist/reconnect' });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/compose-preview', () => {
  it('returns a per-platform generated variant and validatePost result, with no side effects', async () => {
    const account = await ctx.pipeline.accountManager.addAccount({
      platformId: 'discord',
      remoteId: 'guild-preview',
      handle: 'preview-guild',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/compose-preview',
      payload: {
        description: 'Announcing our new feature launch with lots of excitement and detail for everyone following along.',
        cta: 'Learn more',
        platforms: [{ platformId: 'discord', accountId: account.id }],
      },
    });

    expect(res.statusCode).toBe(200);
    const { results } = res.json();
    expect(results).toHaveLength(1);
    const [result] = results;
    expect(result.platform).toBe('discord');
    expect(result.status).toBe('ok');
    expect(result.payload.text).toBeTruthy();
    expect(result.validation).toBeDefined();
    expect(result.validation.ok).toBe(true);
    expect(typeof result.textLength).toBe('number');
    expect(typeof result.characterLimit).toBe('number');

    // No side effects: preview must not create post_variants/jobs.
    const jobs = await app.inject({ method: 'GET', url: '/api/jobs' });
    expect(jobs.json().jobs).toHaveLength(0);
    const history = await app.inject({ method: 'GET', url: '/api/history' });
    expect(history.json().entries).toHaveLength(0);
  });

  it('never exceeds the declared platform character limit in a generated preview', async () => {
    const account = await ctx.pipeline.accountManager.addAccount({
      platformId: 'discord',
      remoteId: 'guild-reject',
      handle: 'reject-guild',
    });

    // Force a validation failure via an explicit platformOptions embed that
    // exceeds Discord's per-field limits (title > 256 chars) — validatePost
    // is pure and runs regardless of how the payload was produced, but
    // compose-preview only exposes description-based generation. Since
    // CampaignGenerator always clamps generated text within the limit, we
    // instead assert the "ok" path's own textLength never exceeds the
    // declared characterLimit, which is the property the UI's meter relies on.
    const res = await app.inject({
      method: 'POST',
      url: '/api/compose-preview',
      payload: {
        description: 'x'.repeat(50),
        platforms: [{ platformId: 'discord', accountId: account.id }],
      },
    });
    const { results } = res.json();
    expect(results[0].textLength).toBeLessThanOrEqual(results[0].characterLimit);
  });

  it('returns an error entry for an unknown platform instead of throwing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/compose-preview',
      payload: {
        description: 'Hello world',
        platforms: [{ platformId: 'unknown-platform', accountId: 'acct-1' }],
      },
    });
    expect(res.statusCode).toBe(200);
    const { results } = res.json();
    expect(results[0].status).toBe('error');
    expect(results[0].error).toBeTruthy();
  });
});

describe('AI provider selection (AI_PROVIDER)', () => {
  const originalProvider = process.env.AI_PROVIDER;
  const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;

  afterEach(() => {
    if (originalProvider === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = originalProvider;
    if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
  });

  it('defaults to the mock provider when AI_PROVIDER is unset', async () => {
    delete process.env.AI_PROVIDER;
    const localCtx = await createAppContext({ dbFile: ':memory:' });
    try {
      expect(localCtx.contentProvider.name).toBe('mock');
    } finally {
      localCtx.close();
    }
  });

  it('fails at startup with a clear error when the chosen real provider has no API key', async () => {
    process.env.AI_PROVIDER = 'claude';
    delete process.env.ANTHROPIC_API_KEY;
    await expect(createAppContext({ dbFile: ':memory:' })).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it('rejects an unknown AI_PROVIDER value at startup', async () => {
    process.env.AI_PROVIDER = 'not-a-provider';
    await expect(createAppContext({ dbFile: ':memory:' })).rejects.toThrow(/Unknown AI_PROVIDER/);
  });
});

describe('GET /api/platforms', () => {
  it('lists loaded connector capabilities without secrets', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/platforms' });
    expect(res.statusCode).toBe(200);
    const { platforms } = res.json();
    const ids = platforms.map((p: { id: string }) => p.id);
    expect(ids).toContain('discord');
    expect(platforms[0].capabilities.characterLimit).toBeGreaterThan(0);
  });
});
