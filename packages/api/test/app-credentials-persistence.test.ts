/**
 * QG-2 / t15 regression: `StaticAppCredentialsResolver` (packages/pipeline's
 * app-credentials.ts) only ever held OAuth app credentials (Twitch/Reddit/
 * Mastodon Client ID/Secret) in memory, so after a real process restart
 * `refreshToken()` would break once the short-lived access token expired.
 * These tests prove credentials saved via `POST /api/app-credentials`
 * survive a SIMULATED RESTART — a brand new `AppContext` (fresh process-level
 * state, fresh in-memory resolver) built against the SAME on-disk sqlite
 * file — and that they are sealed (never plaintext) in the underlying
 * `app_settings` row.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { FastifyInstance } from 'fastify';
import { createAppContext, type AppContext } from '../src/context';
import { createServer } from '../src/server';

describe('OAuth app credentials survive a restart, encrypted at rest (QG-2)', () => {
  let dbFile: string;
  let userDataDir: string;
  let ctxA: AppContext | undefined;
  let appA: FastifyInstance | undefined;
  let ctxB: AppContext | undefined;
  let appB: FastifyInstance | undefined;
  const originalUserDataDir = process.env.SOCIAL_AUTOMATION_USER_DATA_DIR;

  beforeEach(() => {
    // Each test manages its own contexts and may close one early (mid-test,
    // to simulate a restart) — clear all refs so a previous test's
    // already-closed instances are never double-closed by this test's afterEach.
    ctxA = undefined;
    appA = undefined;
    ctxB = undefined;
    appB = undefined;
  });

  afterEach(async () => {
    if (appA) await appA.close();
    if (appB) await appB.close();
    ctxA?.close();
    ctxB?.close();
    fs.rmSync(dbFile, { force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
    if (originalUserDataDir === undefined) delete process.env.SOCIAL_AUTOMATION_USER_DATA_DIR;
    else process.env.SOCIAL_AUTOMATION_USER_DATA_DIR = originalUserDataDir;
  });

  it('a persisted-key restart: credentials set in one AppContext are readable and decryptable in a fresh one against the same DB', async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    dbFile = path.join(os.tmpdir(), `app-creds-restart-${stamp}.sqlite`);
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-creds-userdata-'));
    process.env.SOCIAL_AUTOMATION_USER_DATA_DIR = userDataDir;

    // --- "Before restart": save Twitch app credentials. -------------------
    ctxA = await createAppContext({ dbFile });
    appA = await createServer(ctxA);
    const save = await appA.inject({
      method: 'POST',
      url: '/api/app-credentials',
      payload: { platformId: 'twitch', clientId: 'twitch-client-id', clientSecret: 'twitch-client-secret', redirectUri: 'http://localhost/cb' },
    });
    expect(save.statusCode).toBe(204);

    // The persisted row must never contain the plaintext secret.
    const rawRow = ctxA.db.raw().get<{ value: string }>("SELECT value FROM app_settings WHERE key = 'app_credentials:twitch'");
    expect(rawRow).toBeTruthy();
    expect(rawRow!.value).not.toContain('twitch-client-secret');
    expect(rawRow!.value).not.toContain('twitch-client-id');
    const parsed = JSON.parse(rawRow!.value) as { ciphertext: string; nonce: string; authTag: string; keyRef: string; alg: string };
    expect(parsed.alg).toBe('aes-256-gcm');
    expect(typeof parsed.ciphertext).toBe('string');

    await appA.close();
    ctxA.close();
    appA = undefined;
    ctxA = undefined;

    // --- "After restart": a brand-new AppContext/process against the same DB. ---
    ctxB = await createAppContext({ dbFile });
    appB = await createServer(ctxB);

    const status = await appB.inject({ method: 'GET', url: '/api/app-credentials/twitch' });
    expect(status.json()).toEqual({ platformId: 'twitch', configured: true });

    // Decryptable: the pipeline's own resolver (loaded from the persisted,
    // encrypted store on startup) returns the real secret for actual use
    // (e.g. a token refresh), even though nothing in this test process ever
    // called `.set()` on it directly.
    const resolved = ctxB.pipeline.appCredentials.get('twitch');
    expect(resolved).toEqual({
      clientId: 'twitch-client-id',
      clientSecret: 'twitch-client-secret',
      redirectUri: 'http://localhost/cb',
    });

    // And directly via the secure store too.
    const viaSecureStore = await ctxB.pipeline.secureAppCredentials.get('twitch');
    expect(viaSecureStore).toEqual(resolved);
  });

  it('an in-memory (test/ephemeral) AppContext never touches the real user-data dir on disk', async () => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-creds-untouched-'));
    dbFile = ':memory:';
    process.env.SOCIAL_AUTOMATION_USER_DATA_DIR = userDataDir;

    ctxA = await createAppContext({ dbFile: ':memory:' });
    appA = await createServer(ctxA);
    await appA.inject({
      method: 'POST',
      url: '/api/app-credentials',
      payload: { platformId: 'reddit', clientId: 'x', clientSecret: 'y' },
    });

    // No key file was written under the configured user-data dir for an
    // in-memory context — it uses a fresh in-process key instead (see
    // context.ts's `:memory:` branch), so tests never pollute the real
    // machine's persisted secret-key file.
    expect(fs.existsSync(path.join(userDataDir, 'secrets', 'app-credentials.key'))).toBe(false);
  });
});
