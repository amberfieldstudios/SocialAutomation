import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createAppContext, type AppContext } from '../src/context';
import { createServer } from '../src/server';
import { resetUpdateCheckCacheForTests } from '../src/update-routes';
import { getAppVersion } from '../src/app-version';

let ctx: AppContext;
let app: FastifyInstance;
const originalRepoEnv = process.env.SOCIAL_AUTOMATION_UPDATE_REPO;
const originalFetch = globalThis.fetch;

beforeEach(async () => {
  ctx = await createAppContext({ dbFile: ':memory:' });
  app = await createServer(ctx);
  resetUpdateCheckCacheForTests();
});

afterEach(async () => {
  await app.close();
  ctx.close();
  if (originalRepoEnv === undefined) delete process.env.SOCIAL_AUTOMATION_UPDATE_REPO;
  else process.env.SOCIAL_AUTOMATION_UPDATE_REPO = originalRepoEnv;
  globalThis.fetch = originalFetch;
  resetUpdateCheckCacheForTests();
});

describe('GET /api/update/status', () => {
  it('reports configured:false and never calls the network when SOCIAL_AUTOMATION_UPDATE_REPO is unset', async () => {
    delete process.env.SOCIAL_AUTOMATION_UPDATE_REPO;
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const res = await app.inject({ method: 'GET', url: '/api/update/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ configured: false, updateAvailable: false, currentVersion: getAppVersion() });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports updateAvailable when the latest GitHub release tag is newer than the running version', async () => {
    process.env.SOCIAL_AUTOMATION_UPDATE_REPO = 'example-owner/social-automation';
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ tag_name: 'v999.0.0', html_url: 'https://example.test/releases/v999.0.0', name: 'v999.0.0' }),
    })) as unknown as typeof fetch;

    const res = await app.inject({ method: 'GET', url: '/api/update/status' });
    expect(res.json()).toMatchObject({
      configured: true,
      updateAvailable: true,
      latestVersion: '999.0.0',
      releaseUrl: 'https://example.test/releases/v999.0.0',
      dismissed: false,
    });
  });

  it('reports updateAvailable:false when the latest release is the same or older than the running version', async () => {
    process.env.SOCIAL_AUTOMATION_UPDATE_REPO = 'example-owner/social-automation';
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ tag_name: `v${getAppVersion()}`, html_url: 'https://example.test' }),
    })) as unknown as typeof fetch;

    const res = await app.inject({ method: 'GET', url: '/api/update/status' });
    expect(res.json()).toMatchObject({ configured: true, updateAvailable: false });
  });

  it('never throws on a network failure — returns a plain-language error instead', async () => {
    process.env.SOCIAL_AUTOMATION_UPDATE_REPO = 'example-owner/social-automation';
    globalThis.fetch = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND api.github.com');
    }) as unknown as typeof fetch;

    const res = await app.inject({ method: 'GET', url: '/api/update/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.updateAvailable).toBe(false);
    expect(body.error).toMatch(/couldn't reach/i);
    expect(body.error).not.toMatch(/ENOTFOUND/);
  });

  it('never throws on a non-OK GitHub response — returns a plain-language error instead', async () => {
    process.env.SOCIAL_AUTOMATION_UPDATE_REPO = 'example-owner/social-automation';
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;

    const res = await app.inject({ method: 'GET', url: '/api/update/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ configured: true, updateAvailable: false });
    expect(res.json().error).toMatch(/404/);
  });
});

describe('POST /api/update/dismiss', () => {
  it('persists the dismissed version server-side and status reflects it on a later check', async () => {
    process.env.SOCIAL_AUTOMATION_UPDATE_REPO = 'example-owner/social-automation';
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ tag_name: 'v999.0.0', html_url: 'https://example.test' }),
    })) as unknown as typeof fetch;

    const before = await app.inject({ method: 'GET', url: '/api/update/status' });
    expect(before.json()).toMatchObject({ dismissed: false });

    const dismiss = await app.inject({ method: 'POST', url: '/api/update/dismiss', payload: { version: '999.0.0' } });
    expect(dismiss.statusCode).toBe(200);

    resetUpdateCheckCacheForTests(); // force a fresh check, not the cached pre-dismiss result
    const after = await app.inject({ method: 'GET', url: '/api/update/status' });
    expect(after.json()).toMatchObject({ dismissed: true });
  });

  it('rejects a request with no version', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/update/dismiss', payload: {} });
    expect(res.statusCode).toBe(400);
  });
});
