/**
 * Encrypted-at-rest persistence for OAuth app credentials (Twitch/Reddit/
 * Mastodon developer-app Client ID + Client Secret, docs/AUTH.md §10.5) —
 * t15 / QG-2: `StaticAppCredentialsResolver` (`app-credentials.ts`) keeps
 * these in memory only, so after a process restart `refreshToken()` breaks
 * once the short-lived access token expires (the app secret needed to refresh
 * it is gone). Wizard-collected app credentials now also land here, sealed,
 * and are reloaded on startup.
 *
 * SEALING: reuses `@social/auth`'s pure AES-256-GCM primitives (`sealBytes`/
 * `openBytes`) — THE SAME algorithm/nonce/tag scheme the token vault uses —
 * without touching `TokenVault`/`TokenManager`/the account-token schema at
 * all. This is a deliberately separate, narrow module: `@social/auth`'s
 * vault seals *account tokens* keyed by `accountId`; this seals *developer
 * app* credentials keyed by `platformId`, a different secret with a
 * different lifecycle (one per platform, set once via the wizard, not
 * rotated per-refresh). Storage is `@social/db`'s existing generic
 * `app_settings` key/value store (migration 0007, t2) — no new migration.
 *
 * KEY MANAGEMENT — important distinction from the token vault: today
 * `@social/pipeline`'s `buildPipeline` seeds `TokenVault` with
 * `randomLocalKeyProvider()` when no `keyProvider` option is supplied (see
 * `pipeline.ts`), which mints a FRESH random key every process start — i.e.
 * `@social/auth`'s vault key itself is not currently persisted across a real
 * restart. (Verified directly during t15 investigation: pairing an account in
 * one `AppContext` and reading it back from a second `AppContext` against the
 * same DB file throws `VaultError` — a tag-mismatch, because the second
 * process's `TokenVault` has a different random key. This is broader than
 * QG-2 and was flagged separately to the producer rather than silently
 * patched here, per the "stop and report" instruction — it needs its own
 * task, since fixing it touches every account's token encryption, not just
 * app credentials.) This module does NOT depend on that key: it manages its
 * OWN persisted 32-byte key (`loadOrCreatePersistentKeyProvider`), stored as
 * base64 in a file under the user-data dir (the same
 * `SOCIAL_AUTOMATION_USER_DATA_DIR` convention `packages/ai`'s model manager
 * and `packages/api/src/prod.ts` already use), generated once on first use
 * and reused thereafter — so THIS secret store does survive a real restart,
 * independent of the broader vault-key gap.
 *
 * `loadOrCreatePersistentKeyProvider` is opt-in, not automatic: this file's
 * `SecureAppCredentialsStore` takes a `KeyProvider` as a REQUIRED
 * constructor option and does no filesystem I/O itself. `buildPipeline`
 * defaults to an ephemeral in-process key (deliberately mirroring the
 * vault's own default above) so a bare `buildPipeline()` call — every test
 * in this repo, and any future direct caller — never writes a real key file
 * to the machine running it; only `@social/api`'s `createAppContext`, the
 * actual app entrypoint, opts into `loadOrCreatePersistentKeyProvider()` for
 * a real (non-`:memory:`) database.
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { LocalKeyProvider, openBytes, sealBytes, type KeyProvider } from '@social/auth';
import type { AppCredentials, StructuredLogger } from '@social/core';
import type { SettingsStore } from '@social/db';

const SETTINGS_KEY_PREFIX = 'app_credentials:';
const AEAD_ALG = 'aes-256-gcm';

/**
 * Resolves the user-data directory: `SOCIAL_AUTOMATION_USER_DATA_DIR` (set by
 * the packaged launcher to a per-user folder OUTSIDE the replaceable app
 * dir), else a per-user OS data dir — the same fallback
 * `packages/ai/src/modelDownloadManager.ts#resolveModelStorageDir` uses, kept
 * independent here (this package has no dependency on `@social/ai`) rather
 * than shared, since it's three lines and pulling in a cross-package import
 * for it would be a worse trade.
 */
export function resolveUserDataDir(explicit?: string): string {
  if (explicit && explicit.length > 0) return explicit;
  const fromEnv = process.env.SOCIAL_AUTOMATION_USER_DATA_DIR;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local')
      : process.env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share');
  return path.join(base, 'SocialAutomation');
}

function resolveKeyFilePath(userDataDir?: string): string {
  return path.join(resolveUserDataDir(userDataDir), 'secrets', 'app-credentials.key');
}

/**
 * Loads the persisted 32-byte master key for sealing app credentials, or
 * generates and persists one on first use. The file holds only base64 key
 * material — never a credential — and its permissions are tightened to
 * owner-only where the OS honors POSIX mode bits (a best-effort no-op on
 * Windows' ACL model; the parent directory is still outside any web-served
 * path either way).
 */
export function loadOrCreatePersistentKeyProvider(userDataDir?: string): KeyProvider {
  const keyPath = resolveKeyFilePath(userDataDir);
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });

  let keyBase64: string;
  if (fs.existsSync(keyPath)) {
    keyBase64 = fs.readFileSync(keyPath, 'utf8').trim();
  } else {
    keyBase64 = randomBytes(32).toString('base64');
    fs.writeFileSync(keyPath, keyBase64, { mode: 0o600 });
  }
  try {
    fs.chmodSync(keyPath, 0o600);
  } catch {
    // Best-effort: platforms without POSIX permission bits (Windows) no-op here.
  }
  return new LocalKeyProvider({ v1: Buffer.from(keyBase64, 'base64') }, 'v1');
}

interface SealedAppCredentialsRow {
  ciphertext: string;
  nonce: string;
  authTag: string;
  keyRef: string;
  alg: string;
}

export interface SecureAppCredentialsStoreOptions {
  settings: SettingsStore;
  /**
   * REQUIRED, and deliberately not defaulted here: this class does no
   * filesystem I/O of its own. `@social/pipeline`'s `buildPipeline` decides
   * the default (an ephemeral in-process key, matching the token vault's own
   * `keyProvider` default — see that file's `randomLocalKeyProvider`); only
   * `@social/api`'s `createAppContext` (the real app entrypoint, for a real
   * on-disk DB) opts into `loadOrCreatePersistentKeyProvider()` for actual
   * cross-restart persistence. Keeping the choice at the entrypoint means a
   * test or a direct `buildPipeline()` caller (e.g. `@social/pipeline`'s own
   * test harness) never silently writes a real key file to the machine
   * running it.
   */
  keyProvider: KeyProvider;
  logger?: StructuredLogger;
}

/**
 * Seals/opens `AppCredentials` (Client ID + Client Secret + redirect URI +
 * extras) per platform, persisted via the injected `SettingsStore`
 * (`@social/db`'s `app_settings` table). Fails closed: a tag mismatch or an
 * unresolvable key returns `undefined` from `get`/`loadAll` (never throws
 * into a caller that then might fall back to a stale/partial value) and is
 * logged — the platform is simply treated as "not configured" until re-saved
 * via the wizard, exactly like the token vault's fail-closed rule
 * (docs/AUTH.md §7).
 */
export class SecureAppCredentialsStore {
  private readonly keyProvider: KeyProvider;

  constructor(private readonly options: SecureAppCredentialsStoreOptions) {
    this.keyProvider = options.keyProvider;
  }

  private aad(platformId: string, keyRef: string): Buffer {
    return Buffer.from(`app_credentials|${platformId}|${keyRef}|${AEAD_ALG}`, 'utf8');
  }

  async set(platformId: string, credentials: AppCredentials): Promise<void> {
    const keyRef = this.keyProvider.activeKeyRef();
    const key = await this.keyProvider.resolveKey(keyRef);
    const plaintext = Buffer.from(JSON.stringify(credentials), 'utf8');
    const sealed = sealBytes(key, plaintext, this.aad(platformId, keyRef));
    const row: SealedAppCredentialsRow = { ...sealed, keyRef, alg: AEAD_ALG };
    this.options.settings.set(`${SETTINGS_KEY_PREFIX}${platformId}`, row);
    this.options.logger?.info('pipeline.app_credentials.persisted', { platformId, keyRef });
  }

  async get(platformId: string): Promise<AppCredentials | undefined> {
    const row = this.options.settings.get<SealedAppCredentialsRow>(`${SETTINGS_KEY_PREFIX}${platformId}`);
    if (!row) return undefined;
    try {
      const key = await this.keyProvider.resolveKey(row.keyRef);
      const plaintext = openBytes(key, row, this.aad(platformId, row.keyRef));
      return JSON.parse(plaintext.toString('utf8')) as AppCredentials;
    } catch (err) {
      // Fail closed (docs/AUTH.md §7): never surface a partial/garbled
      // credential. Logged with NO secret material — only platform + keyRef.
      this.options.logger?.error('pipeline.app_credentials.decrypt_failed', {
        platformId,
        keyRef: row.keyRef,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  /** Loads every persisted credential for the given platform ids, skipping any that are unset or fail to decrypt. */
  async loadAll(platformIds: readonly string[]): Promise<Record<string, AppCredentials>> {
    const out: Record<string, AppCredentials> = {};
    for (const platformId of platformIds) {
      const creds = await this.get(platformId);
      if (creds) out[platformId] = creds;
    }
    return out;
  }
}
