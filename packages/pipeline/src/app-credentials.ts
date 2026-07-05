/**
 * Static `AppCredentialsResolver` (the `@social/auth` `TokenManager` port) for
 * the pipeline's per-platform developer-app credentials. A real deployment
 * would source these from `@social/core`'s config module / secrets manager;
 * for wiring + tests a simple in-memory map is enough.
 */

import type { AppCredentials } from '@social/core';

export class StaticAppCredentialsResolver {
  constructor(private readonly byPlatform: Record<string, AppCredentials>) {}

  get(platformId: string): AppCredentials {
    const creds = this.byPlatform[platformId];
    if (!creds) {
      // Empty-but-valid credentials: fine for platforms whose connector never
      // needs to reach this path in a given test (e.g. a non-expiring bot token
      // that's never refreshed).
      return { clientId: `unconfigured-${platformId}` };
    }
    return creds;
  }

  /**
   * Set/replace the developer-app credentials for a platform at runtime. Used
   * by the setup wizard (t1): a streamer pastes the Client ID/Secret they
   * copied from the platform's own developer console (Twitch/Reddit/Mastodon
   * app registration); the wizard's "Save" step calls this via
   * `POST /api/app-credentials` before starting that platform's pairing flow.
   * In-memory only — never written to disk/logs. A future task may back this
   * with `@social/db`/a secrets file so it survives a restart.
   */
  set(platformId: string, credentials: AppCredentials): void {
    this.byPlatform[platformId] = credentials;
  }

  /** Whether real (non-placeholder) app credentials have been configured for `platformId`. */
  has(platformId: string): boolean {
    return Boolean(this.byPlatform[platformId]);
  }
}
