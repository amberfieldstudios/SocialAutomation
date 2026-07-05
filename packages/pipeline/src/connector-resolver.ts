/**
 * PluginConnectorResolver — the seam between the plugin registry (`@social/core`)
 * and everything that needs a live `PlatformConnector` instance: the publish
 * worker (calls `.publish()`) and `@social/auth`'s `TokenManager` (calls
 * `.refreshToken()` through the narrower `TokenRefresher` shape it declares).
 *
 * One connector instance is created per platform (via the plugin's
 * `createConnector(runtime)` factory) and cached — connectors are stateless
 * aside from their capabilities/logger, so re-using one avoids re-running
 * plugin construction on every job/refresh.
 *
 * Contract-mismatch note (see docs t14 task + producer's v1.1 backlog): this
 * resolver hands out the SAME connector object for both roles. `@social/auth`
 * declares its own local `PluginConnectorResolver`/`TokenRefresher` port (see
 * `packages/auth/src/token-manager.ts`) rather than importing `@social/core`'s
 * `PlatformConnector` directly, but `PlatformConnector.refreshToken` already has
 * the exact `(input: RefreshInput) => Promise<TokenSet>` shape `TokenRefresher`
 * expects, so a `PlatformConnector` satisfies that port structurally with zero
 * adapter code. No changes to `@social/core` or `@social/auth` are needed to
 * make this work; the full contract v1.1 reconciliation (folding
 * `PairingConnector`'s superset of `AuthRequest` kinds into the core contract)
 * remains an m6 task and is out of scope here.
 */

import type { PlatformConnector, PluginRegistry, StructuredLogger } from '@social/core';
import { PluginLoadError } from '@social/core';

export interface ConnectorResolverOptions {
  registry: PluginRegistry;
  logger: StructuredLogger;
  /** Injectable clock, forwarded to every connector's `ConnectorRuntime`. */
  now?: () => Date;
  /** Per-platform static config forwarded to `ConnectorRuntime.config` (e.g. a Bluesky serviceUrl override). */
  config?: Record<string, Record<string, unknown>>;
}

/** Thrown when a platform id has no registered plugin. Mirrors `PluginLoadError`'s shape so callers can handle both uniformly. */
export class ConnectorNotFoundError extends PluginLoadError {
  constructor(platform: string) {
    super(`No connector plugin is registered for platform "${platform}".`, { details: { platform } });
    this.name = 'ConnectorNotFoundError';
  }
}

/**
 * Resolves a `PlatformConnector` for a platform id from an already-populated
 * `PluginRegistry` (populate it with `FileSystemPluginLoader.loadInto()` or by
 * registering manifests directly — this class does not do discovery itself, to
 * keep filesystem/discovery concerns separate from resolution).
 *
 * Implements the minimal `{ get(platformId) }` shape needed to plug into
 * `@social/auth`'s `TokenManager` as its `connectors` dependency.
 */
export class PluginConnectorResolver {
  private readonly cache = new Map<string, PlatformConnector>();

  constructor(private readonly options: ConnectorResolverOptions) {}

  /** Synchronously resolve (and cache) the connector for `platformId`. Throws `ConnectorNotFoundError` if unregistered. */
  resolve(platformId: string): PlatformConnector {
    const cached = this.cache.get(platformId);
    if (cached) return cached;

    const manifest = this.options.registry.get(platformId);
    if (!manifest) throw new ConnectorNotFoundError(platformId);

    const connector = manifest.createConnector({
      logger: this.options.logger.child({ platform: platformId }),
      ...(this.options.now ? { now: this.options.now } : {}),
      ...(this.options.config?.[platformId] ? { config: this.options.config[platformId] } : {}),
    });
    this.cache.set(platformId, connector);
    return connector;
  }

  /** `@social/auth` `PluginConnectorResolver` port: `get(platformId) -> TokenRefresher`. */
  get(platformId: string): PlatformConnector {
    return this.resolve(platformId);
  }
}
