/**
 * F2 / t17 regression: the token vault's master key used to default to a
 * FRESH RANDOM key every process start (`buildPipeline`'s
 * `randomLocalKeyProvider()`, never overridden by `createAppContext`), so
 * EVERY connected account's sealed token failed to decrypt
 * (`TokenManager.createContext` throwing `VaultError`, an auth-tag mismatch
 * indistinguishable from tampering) after a real restart — not just the
 * Twitch/Reddit/Mastodon OAuth-refresh case QG-2 (t15) described, but any
 * publish attempt on ANY platform, including Discord/Bluesky which never
 * even needed a token refresh.
 *
 * This is the cross-process check that was missing: a brand-new `AppContext`
 * (fresh in-process `TokenVault`, fresh `LocalKeyProvider` instance) built
 * against the SAME on-disk sqlite file AND the same user-data dir must still
 * be able to open a token sealed by a prior process.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { FastifyInstance } from 'fastify';
import { createAppContext, type AppContext } from '../src/context';
import { createServer } from '../src/server';

describe('Token vault master key survives a restart (F2)', () => {
  let dbFile: string;
  let userDataDir: string;
  let ctxA: AppContext | undefined;
  let appA: FastifyInstance | undefined;
  let ctxB: AppContext | undefined;
  let appB: FastifyInstance | undefined;
  const originalUserDataDir = process.env.SOCIAL_AUTOMATION_USER_DATA_DIR;

  beforeEach(() => {
    // See app-credentials-persistence.test.ts: reset every test so a
    // previous test's already-closed instances are never double-closed.
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

  it('a Discord webhook token sealed in one AppContext still decrypts in a fresh AppContext against the same DB (real restart, not just an in-process refresh)', async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    dbFile = path.join(os.tmpdir(), `vault-restart-${stamp}.sqlite`);
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-restart-userdata-'));
    process.env.SOCIAL_AUTOMATION_USER_DATA_DIR = userDataDir;

    // --- "Before restart": pair a Discord account (real seal via TokenVault). ---
    ctxA = await createAppContext({ dbFile });
    appA = await createServer(ctxA);
    const pair = await appA.inject({
      method: 'POST',
      url: '/api/accounts/pair/token',
      payload: { platformId: 'discord', token: 'real-webhook-value', tokenType: 'webhook', remoteId: 'chan-restart-1' },
    });
    expect(pair.statusCode).toBe(201);
    const accountId = pair.json().account.id as string;

    // Sanity: decryption works within the SAME process (this always worked,
    // even before the fix — the bug only manifests across a restart).
    const before = await ctxA.pipeline.tokenManager.createContext(accountId);
    expect(before.token.accessToken).toBe('real-webhook-value');

    await appA.close();
    ctxA.close();
    appA = undefined;
    ctxA = undefined;

    // --- "After restart": a brand-new AppContext (fresh TokenVault, fresh
    // LocalKeyProvider instance) against the identical DB file + user-data dir. ---
    ctxB = await createAppContext({ dbFile });
    appB = await createServer(ctxB);

    // This is the line that used to throw VaultError before the fix.
    const after = await ctxB.pipeline.tokenManager.createContext(accountId);
    expect(after.token.accessToken).toBe('real-webhook-value');

    // And the same holds through the HTTP surface: "test this connection"
    // must at least get far enough to reach the connector (a network error
    // reaching the fake webhook URL is expected/fine in this sandbox — the
    // point is it's not a VaultError from a bad key).
    const test = await appB.inject({ method: 'POST', url: `/api/accounts/${accountId}/test` });
    expect(test.statusCode).toBe(200);
    expect(test.json().message.toLowerCase()).not.toContain('vaulterror');
  });

  it('an in-memory (test/ephemeral) AppContext never writes a real key file, even though it also builds a TokenVault', async () => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-untouched-'));
    dbFile = ':memory:';
    process.env.SOCIAL_AUTOMATION_USER_DATA_DIR = userDataDir;

    ctxA = await createAppContext({ dbFile: ':memory:' });
    appA = await createServer(ctxA);
    await appA.inject({
      method: 'POST',
      url: '/api/accounts/pair/token',
      payload: { platformId: 'discord', token: 'x', tokenType: 'webhook', remoteId: 'chan-mem-1' },
    });

    expect(fs.existsSync(path.join(userDataDir, 'secrets', 'app-credentials.key'))).toBe(false);
  });
});
