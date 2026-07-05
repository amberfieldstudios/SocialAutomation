/**
 * `SecureAppCredentialsStore` (t15, QG-2) unit tests: seals/opens OAuth app
 * credentials with the same AES-256-GCM primitives the token vault uses,
 * fails closed on tamper/wrong key, and `loadOrCreatePersistentKeyProvider`
 * persists+reuses a key file under the user-data dir.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Database } from '@social/db';
import { LocalKeyProvider } from '@social/auth';
import {
  SecureAppCredentialsStore,
  loadOrCreatePersistentKeyProvider,
  resolveUserDataDir,
} from '../src/secure-app-credentials';

describe('SecureAppCredentialsStore', () => {
  function freshStore(keyBytes = Buffer.alloc(32, 7)): { store: SecureAppCredentialsStore; db: Database } {
    const db = Database.sqlite({ filename: ':memory:' });
    db.migrate();
    const store = new SecureAppCredentialsStore({
      settings: db.settings,
      keyProvider: new LocalKeyProvider({ v1: keyBytes }, 'v1'),
    });
    return { store, db };
  }

  it('returns undefined for a platform that was never set', async () => {
    const { store } = freshStore();
    expect(await store.get('twitch')).toBeUndefined();
  });

  it('round-trips Client ID + Secret + redirectUri + extras through set/get', async () => {
    const { store } = freshStore();
    const credentials = {
      clientId: 'abc123',
      clientSecret: 'shh-secret',
      redirectUri: 'http://localhost/cb',
      extra: { instanceUrl: 'mastodon.social' },
    };
    await store.set('mastodon', credentials);
    expect(await store.get('mastodon')).toEqual(credentials);
  });

  it('never stores the plaintext secret in the underlying settings row', async () => {
    const { store, db } = freshStore();
    await store.set('reddit', { clientId: 'reddit-id', clientSecret: 'reddit-secret' });
    const raw = db.raw().get<{ value: string }>("SELECT value FROM app_settings WHERE key = 'app_credentials:reddit'");
    expect(raw!.value).not.toContain('reddit-secret');
    expect(raw!.value).not.toContain('reddit-id');
  });

  it('loadAll skips platforms with nothing saved and returns the rest', async () => {
    const { store } = freshStore();
    await store.set('twitch', { clientId: 'twitch-id' });
    const all = await store.loadAll(['twitch', 'reddit', 'mastodon']);
    expect(all).toEqual({ twitch: { clientId: 'twitch-id' } });
  });

  it('fails closed (returns undefined, never throws) when opened under the WRONG key — never surfaces a partial credential', async () => {
    const db = Database.sqlite({ filename: ':memory:' });
    db.migrate();
    const storeA = new SecureAppCredentialsStore({ settings: db.settings, keyProvider: new LocalKeyProvider({ v1: Buffer.alloc(32, 1) }, 'v1') });
    await storeA.set('twitch', { clientId: 'x', clientSecret: 'y' });

    // Same settings row, but a store sealed under a DIFFERENT key entirely
    // (same key_ref label "v1", different bytes) — simulates a corrupted or
    // substituted key file.
    const storeB = new SecureAppCredentialsStore({ settings: db.settings, keyProvider: new LocalKeyProvider({ v1: Buffer.alloc(32, 2) }, 'v1') });
    await expect(storeB.get('twitch')).resolves.toBeUndefined();
  });

  it('fails closed on a tampered ciphertext (auth-tag verification failure)', async () => {
    const { store, db } = freshStore();
    await store.set('twitch', { clientId: 'x', clientSecret: 'y' });

    const row = db.settings.get<{ ciphertext: string }>('app_credentials:twitch')!;
    db.settings.set('app_credentials:twitch', { ...row, ciphertext: Buffer.from('tampered-bytes').toString('base64') });

    await expect(store.get('twitch')).resolves.toBeUndefined();
  });
});

describe('loadOrCreatePersistentKeyProvider + resolveUserDataDir', () => {
  let userDataDir: string;
  const originalEnv = process.env.SOCIAL_AUTOMATION_USER_DATA_DIR;

  afterEach(() => {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    if (originalEnv === undefined) delete process.env.SOCIAL_AUTOMATION_USER_DATA_DIR;
    else process.env.SOCIAL_AUTOMATION_USER_DATA_DIR = originalEnv;
  });

  it('resolveUserDataDir prefers SOCIAL_AUTOMATION_USER_DATA_DIR, then an explicit override, else an OS default', () => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secure-creds-dir-'));
    process.env.SOCIAL_AUTOMATION_USER_DATA_DIR = userDataDir;
    expect(resolveUserDataDir()).toBe(userDataDir);
    expect(resolveUserDataDir('/explicit/override')).toBe('/explicit/override');
  });

  it('creates a persisted key on first use and reuses the SAME key on a second call (a real restart)', () => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secure-creds-key-'));

    const first = loadOrCreatePersistentKeyProvider(userDataDir);
    const keyFile = path.join(userDataDir, 'secrets', 'app-credentials.key');
    expect(fs.existsSync(keyFile)).toBe(true);

    const second = loadOrCreatePersistentKeyProvider(userDataDir);
    expect(second.activeKeyRef()).toBe(first.activeKeyRef());

    // Round-trip: a credential sealed under the first instance opens cleanly
    // under a completely independent second instance loaded from the same
    // file — proving it's really the persisted key, not a fluke of object
    // identity.
    const db = Database.sqlite({ filename: ':memory:' });
    db.migrate();
    const storeA = new SecureAppCredentialsStore({ settings: db.settings, keyProvider: first });
    const storeB = new SecureAppCredentialsStore({ settings: db.settings, keyProvider: second });
    return storeA.set('twitch', { clientId: 'persisted-id', clientSecret: 'persisted-secret' }).then(async () => {
      await expect(storeB.get('twitch')).resolves.toEqual({ clientId: 'persisted-id', clientSecret: 'persisted-secret' });
    });
  });
});
