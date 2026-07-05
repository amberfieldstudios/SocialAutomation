/**
 * Shared application context: one SQLite-backed `Database` + one wired
 * `Pipeline` (from `@social/pipeline`'s `buildPipeline`), reused by every
 * route handler and by the seed script.
 *
 * The AI content provider is selected via `@social/ai`'s
 * `createContentProvider` and the `AI_PROVIDER` env var
 * (`local` | `claude` | `openai` | `mock`). Unlike the factory's own default
 * (`claude`), this app picks a CREDENTIAL-FREE default when `AI_PROVIDER` is
 * unset: it prefers the on-device `local` provider when a GGUF model is
 * already present on disk (`LOCAL_MODEL_PATH`), wrapped in a
 * `FallbackContentProvider` so that if the model is absent mid-run, corrupt, or
 * too heavy for the machine it transparently degrades to the deterministic
 * template provider (`mock`) — and when no model is present (including while it
 * is still downloading) it uses that template provider directly. Either way
 * generation stays deterministic, network-free, and zero-key, and NEVER errors
 * for lack of a key or model (see `createDefaultContentProvider`).
 * Setting `AI_PROVIDER=local` (needs a model on disk, no key),
 * `AI_PROVIDER=claude` (needs `ANTHROPIC_API_KEY`) or `AI_PROVIDER=openai`
 * (needs `OPENAI_API_KEY`) forces that provider; a missing key/model or an
 * unknown provider id throws `AiConfigError` here at startup, before the DB is
 * opened or the server listens — never mid-request. Platform credentials are
 * still mocked.
 */

import { Database } from '@social/db';
import { buildPipeline, loadOrCreatePersistentKeyProvider, type Pipeline } from '@social/pipeline';
import {
  createContentProvider,
  FallbackContentProvider,
  isLocalModelAvailable,
  resolveLocalModelPath,
  type ContentProvider,
} from '@social/ai';
import { createLogger } from '@social/logging';
import type { StructuredLogger } from '@social/core';
import { InMemoryPairingSessionStore, PairingCoordinator } from '@social/auth';
import { createPairingOutcomeStore, type PairingOutcomeStore } from './pairing-outcomes';
import { toPairingConnectorResolver } from './pairing-connector-adapter';

/**
 * The connector plugins the setup wizard (t1) and dashboard know how to
 * load/display. Discord + Twitch + Bluesky are the connectors this workspace
 * ships with real HTTP handshakes; Reddit + Mastodon (t1) require the user to
 * register a small "app" on the platform first — the wizard walks them
 * through that (docs/AUTH.md §10.5) before pairing.
 */
export const KNOWN_PLATFORM_IDS = ['discord', 'twitch', 'bluesky', 'reddit', 'mastodon'] as const;

export interface AppContext {
  db: Database;
  pipeline: Pipeline;
  /** The one provider instance shared by the pipeline and compose-preview. */
  contentProvider: ContentProvider;
  logger: StructuredLogger;
  /**
   * Orchestrates the redirect/device/password/token pairing flows the setup
   * wizard drives (@social/auth's `PairingCoordinator`, docs/AUTH.md §6). Built
   * on the SAME `accountManager`/`tokenManager`/`connectors`/`appCredentials`
   * the rest of the pipeline uses, so a wizard-paired account is
   * indistinguishable from one paired any other way.
   */
  pairing: PairingCoordinator;
  /**
   * Tracks the outcome of an in-flight redirect (`authorize_url`) pairing by
   * its `state`, so the wizard tab (which cannot receive the platform's
   * redirect directly — that lands on this server's own callback route) can
   * poll `GET /api/accounts/pair/poll/:state` for completion. Separate from
   * `PairingSessionStore` because `PairingCoordinator.completePairing`
   * consumes (single-uses) the session before the wizard has a chance to read
   * the result.
   */
  pairingOutcomes: PairingOutcomeStore;
  close(): void;
}

export interface CreateAppContextOptions {
  /** SQLite file path, or `:memory:`. Defaults to `SOCIAL_DB_FILE` env or an in-memory DB. */
  dbFile?: string;
  logger?: StructuredLogger;
}

/**
 * Build the `ContentProvider` the app wires up, credential-free by default,
 * with the fallback chain that guarantees generation NEVER errors for lack of
 * an API key or a model (task t5).
 *
 * - `AI_PROVIDER` explicitly set → honor it verbatim (the factory reads the env
 *   var and resolves `LOCAL_MODEL_PATH` for `local`, API keys for
 *   `claude`/`openai`); an explicit choice is not auto-wrapped, so a
 *   misconfiguration surfaces loudly instead of silently degrading.
 * - `AI_PROVIDER` unset → the credential-free default. When a GGUF model is
 *   present on disk (`LOCAL_MODEL_PATH`), prefer the on-device `local` provider
 *   but wrap it in a `FallbackContentProvider` backed by the deterministic
 *   template provider (`mock`), so a model that turns out to be absent mid-run,
 *   corrupt, or too heavy for the machine transparently degrades to template
 *   copy rather than failing a request. When no model is present (including
 *   while it is still downloading), use the template provider directly.
 *
 * `isLocalModelAvailable` is a cheap sync stat that never touches the native
 * `node-llama-cpp` binding, so this is safe to call at startup. The download
 * manager (t4) reports model presence by writing the model file and setting
 * `LOCAL_MODEL_PATH`.
 */
function createDefaultContentProvider(logger: StructuredLogger): ContentProvider {
  if (process.env.AI_PROVIDER) {
    return createContentProvider({ logger });
  }

  // The always-available, zero-key deterministic template generator.
  const template = createContentProvider({ logger, provider: 'mock' });

  const modelPath = resolveLocalModelPath();
  if (isLocalModelAvailable(modelPath)) {
    const local = createContentProvider({ logger, provider: 'local', ...(modelPath ? { modelPath } : {}) });
    return new FallbackContentProvider(local, template, { logger });
  }
  return template;
}

export async function createAppContext(options: CreateAppContextOptions = {}): Promise<AppContext> {
  const logger = options.logger ?? createLogger({ service: 'social-api', level: (process.env.LOG_LEVEL as never) ?? 'info' });

  // Built before the DB so a misconfigured real provider (unknown
  // AI_PROVIDER, missing ANTHROPIC_API_KEY/OPENAI_API_KEY, or AI_PROVIDER=local
  // with no model) fails startup immediately with the factory's AiConfigError.
  // When AI_PROVIDER is unset we choose the credential-free default: prefer the
  // on-device `local` provider if a GGUF model is already on disk, otherwise
  // `mock` (the factory's own unset-default is `claude`, which we never want
  // implicitly because it needs a key). Once t5's fallback chain lands, `mock`
  // here becomes the honest template provider.
  const contentProvider = createDefaultContentProvider(logger);
  logger.info('api.content_provider_selected', { provider: contentProvider.name });

  const filename = options.dbFile ?? process.env.SOCIAL_DB_FILE ?? ':memory:';
  const db = Database.sqlite({ filename }, { logger });
  db.migrate();

  // t15 (QG-2) / t17 (F2): for a REAL on-disk DB, both the OAuth app-credential
  // seal AND the token vault's own master key need to survive a restart — a
  // single persisted key file (`loadOrCreatePersistentKeyProvider`) covers
  // both; there is no reason for them to differ; loading it once and reusing
  // it for both `keyProvider` (vault) and `secureAppCredentials.keyProvider`
  // (app credentials) is simpler than managing two files.
  //
  // F2 (t17): before this, `buildPipeline` was never given a `keyProvider`
  // here, so it fell back to its own `randomLocalKeyProvider()` — a FRESH
  // random key every process start. That silently broke EVERY connected
  // account after any real restart (not just OAuth refresh): the vault seals
  // account tokens (Discord webhooks, Bluesky app passwords, every OAuth
  // token) under that key, and a new random key on the next start can never
  // open rows sealed under the old one — `TokenManager.createContext` throws
  // `VaultError` (auth-tag mismatch) for every account, indistinguishable
  // from tampering. Verified directly (see `context.persistence.test.ts`):
  // pairing an account in one `AppContext` and reading it back from a second
  // one against the same DB file used to throw; it now decrypts cleanly.
  //
  // THREAT MODEL (honest, per t17's instruction): this is a key FILE on local
  // disk (0600 where the OS honors POSIX perms; a no-op on Windows' ACL
  // model), not an OS keychain/DPAPI-protected secret. Anyone with the same
  // OS-user filesystem access as the running app can read it and therefore
  // decrypt account tokens/app secrets — the same threat model as the
  // sqlite DB file sitting right next to it. This matches the existing
  // `SOCIAL_MASTER_KEY` design documented in docs/AUTH.md §2 (an env-var/file
  // master key is the acknowledged local/self-host tier; a KMS-backed
  // `KmsKeyProvider` is the stubbed-out production upgrade path, unimplemented
  // pending a real deployment target). For `:memory:` (every test, and any
  // short-lived run) the DB itself vanishes on close anyway, so we
  // deliberately do NOT opt in here — writing a real key file to the machine
  // running the tests would be pure side-effect pollution with no
  // corresponding benefit; `buildPipeline`'s ephemeral defaults apply.
  const persistentKeyProvider = filename !== ':memory:' ? loadOrCreatePersistentKeyProvider() : undefined;

  const pipeline = await buildPipeline({
    db,
    logger,
    contentProvider,
    ...(persistentKeyProvider ? { keyProvider: persistentKeyProvider } : {}),
    ...(persistentKeyProvider ? { secureAppCredentials: { keyProvider: persistentKeyProvider } } : {}),
  });
  await pipeline.loadPlugins();

  // `accounts.platform_id` / `post_variants.platform_id` FK into `platforms`
  // (schema runs with `PRAGMA foreign_keys = ON`). The plugin loader only
  // populates the in-memory registry; upserting the `platforms` row per
  // loaded connector is normally the loader's/registration path's job (see
  // `SqlitePlatformsRepo`'s doc comment) — done here once at boot so every
  // account/campaign call downstream can rely on the FK already being
  // satisfied for every platform this dashboard knows about.
  for (const platformId of KNOWN_PLATFORM_IDS) {
    try {
      const connector = pipeline.connectors.resolve(platformId);
      db.platforms.upsert({
        id: platformId,
        displayName: connector.capabilities.displayName,
        apiBaseUrl: connector.capabilities.apiBaseUrl,
        contractVersion: connector.capabilities.contractVersion,
        capabilities: connector.capabilities,
      });
    } catch {
      // Plugin not installed in this environment — skip.
    }
  }

  const pairing = new PairingCoordinator({
    sessions: new InMemoryPairingSessionStore(),
    connectors: toPairingConnectorResolver(pipeline.connectors),
    appCredentials: pipeline.appCredentials,
    accounts: pipeline.accountManager,
    tokenManager: pipeline.tokenManager,
    logger,
  });
  const pairingOutcomes = createPairingOutcomeStore();

  return {
    db,
    pipeline,
    contentProvider,
    logger,
    pairing,
    pairingOutcomes,
    close() {
      db.close();
    },
  };
}
