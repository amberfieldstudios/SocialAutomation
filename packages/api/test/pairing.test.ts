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

describe('app credentials (wizard "app registration" step)', () => {
  it('reports a platform as unconfigured until credentials are saved, never echoes them back', async () => {
    const before = await app.inject({ method: 'GET', url: '/api/app-credentials/twitch' });
    expect(before.json()).toEqual({ platformId: 'twitch', configured: false });

    const save = await app.inject({
      method: 'POST',
      url: '/api/app-credentials',
      payload: { platformId: 'twitch', clientId: 'abc123', clientSecret: 'shh-secret', redirectUri: 'http://localhost:3000/api/accounts/pair/callback/twitch' },
    });
    expect(save.statusCode).toBe(204);
    expect(save.body.toLowerCase()).not.toContain('shh-secret');

    const after = await app.inject({ method: 'GET', url: '/api/app-credentials/twitch' });
    expect(after.json()).toEqual({ platformId: 'twitch', configured: true });
  });

  it('requires platformId and clientId', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/app-credentials', payload: { platformId: 'reddit' } });
    expect(res.statusCode).toBe(400);
  });
});

describe('redirect pairing (twitch / reddit / mastodon)', () => {
  it('begin returns an authorize URL and the poll endpoint starts pending', async () => {
    const begin = await app.inject({
      method: 'POST',
      url: '/api/accounts/pair/begin',
      payload: { platformId: 'twitch', operations: ['publish'] },
    });
    expect(begin.statusCode).toBe(200);
    const body = begin.json();
    expect(body.kind).toBe('authorize_url');
    expect(typeof body.authorizeUrl).toBe('string');
    expect(typeof body.state).toBe('string');

    const poll = await app.inject({ method: 'GET', url: `/api/accounts/pair/poll/${body.state}` });
    expect(poll.json()).toEqual({ status: 'pending' });
  });

  it('an unknown callback state fails closed with a plain-language message, never a stack trace', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/accounts/pair/callback/twitch?code=fake-code&state=not-a-real-state',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Connection failed');
    expect(res.body.toLowerCase()).not.toContain('fake-code');
  });

  it('rejects an unknown platform with a 400, not a crash', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/accounts/pair/begin',
      payload: { platformId: 'not-a-platform', operations: ['publish'] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBeTruthy();
  });
});

describe('direct token pairing (discord bot token / webhook)', () => {
  it('pairs an account directly with no redirect, and the response carries no secret', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/accounts/pair/token',
      payload: {
        platformId: 'discord',
        token: 'fake-webhook-token-value',
        tokenType: 'webhook',
        remoteId: 'channel-123',
        displayName: 'Stream Announcements',
      },
    });
    expect(res.statusCode).toBe(201);
    const { account } = res.json();
    expect(account.platformId).toBe('discord');
    expect(account.status).toBe('active');
    const raw = res.body.toLowerCase();
    for (const forbidden of ['fake-webhook-token-value', 'accesstoken', 'ciphertext']) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it('requires platformId, token, and tokenType', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/accounts/pair/token', payload: { platformId: 'discord' } });
    expect(res.statusCode).toBe(400);
  });
});

describe('test this connection', () => {
  it('reports a plain-language failure instead of throwing when the credential is fake', async () => {
    const pair = await app.inject({
      method: 'POST',
      url: '/api/accounts/pair/token',
      payload: { platformId: 'discord', token: 'fake-webhook-token', tokenType: 'webhook', remoteId: 'channel-test' },
    });
    const { account } = pair.json();

    const res = await app.inject({ method: 'POST', url: `/api/accounts/${account.id}/test` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.ok).toBe('boolean');
    expect(typeof body.message).toBe('string');
    // Whatever the outcome (network may or may not be reachable in CI), the
    // message must read as plain language, never leak the token, and never a
    // raw stack trace.
    expect(body.message.toLowerCase()).not.toContain('fake-webhook-token');
    expect(body.message).not.toContain('at Object.<anonymous>');
  });

  it('404s testing an unknown account', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/accounts/does-not-exist/test' });
    expect(res.statusCode).toBe(404);
  });
});
