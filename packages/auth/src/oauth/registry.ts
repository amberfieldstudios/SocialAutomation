/**
 * Per-platform flow descriptors (docs/AUTH.md §1) and the auth-layer connector
 * seam the pairing coordinator drives.
 *
 * The grant a platform uses is declared once here so the pairing code stays
 * platform-agnostic. The actual HTTP handshakes live in the connectors; this
 * layer orchestrates and persists (§0 division of responsibility).
 *
 * ── Contract note (routed to core-architect) ─────────────────────────────────
 * `@social/core`'s `AuthRequest` union covers `authorize_url | exchange_code |
 * client_credentials` and `AuthResult` covers `{ authorizeUrl, token, profile }`.
 * Device-code and app-password flows need two more request shapes and a device
 * authorization result field. We model that superset locally as
 * `PairingAuthRequest` / `PairingAuthResult` so this layer compiles and is fully
 * testable now; connectors that offer device/app-password flows must accept
 * these kinds. Recommend folding `device_code` / `device_token` / `password`
 * into the core `AuthRequest` (and `deviceAuthorization`/`pending` into
 * `AuthResult`) so the seam is identical to `PlatformConnector.authenticate`.
 */

import type { AppCredentials, AuthResult } from '@social/core';

/** The grant kinds a platform pairing can use. */
export type GrantKind =
  | 'auth_code' // authorization code (confidential client, no PKCE)
  | 'auth_code_pkce' // authorization code + PKCE (default for public clients)
  | 'device_code' // RFC 8628 device authorization grant
  | 'client_credentials' // app-level, no user context
  | 'platform_password' // direct credential exchange (AT Protocol app password)
  | 'platform_token'; // static secret, no exchange (Discord bot token / webhook)

/** How a platform is paired. Declared once; pairing code reads only this. */
export interface FlowDescriptor {
  platformId: string;
  /** The primary grant used by `beginPairing` / the direct pairing helpers. */
  grant: GrantKind;
  /** Whether the primary grant uses PKCE. */
  usesPkce: boolean;
  /** Whether tokens from this flow are refreshable (drives the refresh machinery). */
  refreshable: boolean;
  /** `token_type` stored for the current token (Bearer, bot, webhook, …). */
  defaultTokenType?: string;
  /**
   * For `platform_password`: also seal the supplied credential as a NON-CURRENT
   * bootstrap row so the session can be re-created without re-prompting
   * (docs/AUTH.md §1 Bluesky, decision A).
   */
  storeCredentialAsBootstrap?: boolean;
  bootstrapTokenType?: string;
  /** Alternate grants this platform also offers (selectable via `beginPairing`). */
  alternates?: GrantKind[];
}

/**
 * Concrete per-platform flow config for the m3 connectors (docs/AUTH.md §1).
 *
 * - **discord** — primary is `platform_token`: the posting path is a bot token
 *   or an incoming-webhook URL (static, non-expiring secrets), paired directly
 *   with no code exchange. The user-context OAuth path (`auth_code_pkce`, e.g.
 *   `webhook.incoming`) is offered as an alternate and does refresh.
 * - **twitch** — primary is `auth_code_pkce` (Twitch supports PKCE, ~4h access
 *   tokens with a rotating refresh token). `device_code` (headless) and
 *   `client_credentials` (public/read app token) are alternates.
 * - **bluesky** — `platform_password`: exchange handle + app password for an
 *   `accessJwt`/`refreshJwt` session; the app password is sealed as a
 *   non-current bootstrap row.
 */
export const FLOW_REGISTRY: Record<string, FlowDescriptor> = {
  discord: {
    platformId: 'discord',
    grant: 'platform_token',
    usesPkce: false,
    refreshable: false,
    alternates: ['auth_code_pkce'],
  },
  twitch: {
    platformId: 'twitch',
    grant: 'auth_code_pkce',
    usesPkce: true,
    refreshable: true,
    defaultTokenType: 'Bearer',
    alternates: ['device_code', 'client_credentials'],
  },
  bluesky: {
    platformId: 'bluesky',
    grant: 'platform_password',
    usesPkce: false,
    refreshable: true,
    defaultTokenType: 'Bearer',
    storeCredentialAsBootstrap: true,
    bootstrapTokenType: 'atproto_app_password',
  },
  // reddit / mastodon (t1, setup wizard): both connectors already implement
  // `authorize_url` + `exchange_code` (see plugins/reddit, plugins/mastodon),
  // so the generic PairingCoordinator redirect flow works unmodified. Per
  // docs/AUTH.md's per-platform table: reddit uses a confidential
  // authorization-code grant (no PKCE — Reddit's script/web-app flow expects a
  // client secret) with `duration=permanent` for a refresh token; mastodon
  // uses authorization-code + PKCE, after a one-time per-instance app
  // registration the wizard walks the user through.
  reddit: {
    platformId: 'reddit',
    grant: 'auth_code',
    usesPkce: false,
    refreshable: true,
    defaultTokenType: 'Bearer',
  },
  mastodon: {
    platformId: 'mastodon',
    grant: 'auth_code_pkce',
    usesPkce: true,
    refreshable: true,
    defaultTokenType: 'Bearer',
  },
};

/** A read-only registry lookup with a clear error surface for unknown platforms. */
export interface FlowRegistry {
  get(platformId: string): FlowDescriptor | undefined;
}

export const defaultFlowRegistry: FlowRegistry = {
  get: (platformId) => FLOW_REGISTRY[platformId],
};

// ---------------------------------------------------------------------------
// Auth-layer connector seam (superset of core's AuthRequest/AuthResult)
// ---------------------------------------------------------------------------

/** RFC 8628 device authorization returned when a device flow starts. */
export interface DeviceAuthorization {
  /** SECRET poll code — never logged, never shown to the user. */
  deviceCode: string;
  /** Short code the user types at `verificationUri`. */
  userCode: string;
  verificationUri: string;
  /** Pre-filled verification URL (`verification_uri_complete`), when provided. */
  verificationUriComplete?: string;
  expiresInSec: number;
  /** Minimum seconds between polls. */
  intervalSec: number;
}

/**
 * The auth-layer request union: core's three kinds plus device-code (start +
 * poll) and direct app-password exchange.
 */
export type PairingAuthRequest =
  | {
      kind: 'authorize_url';
      app: AppCredentials;
      state: string;
      scopes: string[];
      codeChallenge?: string;
    }
  | {
      kind: 'exchange_code';
      app: AppCredentials;
      code: string;
      state?: string;
      codeVerifier?: string;
    }
  | {
      kind: 'client_credentials';
      app: AppCredentials;
      scopes: string[];
    }
  | {
      /** Start a device authorization grant. */
      kind: 'device_code';
      app: AppCredentials;
      scopes: string[];
    }
  | {
      /** Poll for the token after the user approves the device code. */
      kind: 'device_token';
      app: AppCredentials;
      deviceCode: string;
    }
  | {
      /** Direct credential exchange (AT Protocol `createSession`). */
      kind: 'password';
      app: AppCredentials;
      /** e.g. a Bluesky handle. */
      identifier: string;
      /** SECRET — the app password. Never logged; sealed on success. */
      password: string;
      scopes: string[];
    };

/** The auth-layer result: core's `AuthResult` plus device-flow signals. */
export interface PairingAuthResult extends AuthResult {
  /** Present when a `device_code` request started a device authorization. */
  deviceAuthorization?: DeviceAuthorization;
  /** Present when a `device_token` poll has no token yet (RFC 8628 poll states). */
  pending?: 'authorization_pending' | 'slow_down';
}

/** The connector subset the pairing coordinator drives. */
export interface PairingConnector {
  authenticate(request: PairingAuthRequest): Promise<PairingAuthResult>;
}

/** Resolves a `PairingConnector` for a platform (from the plugin registry). */
export interface PairingConnectorResolver {
  get(platformId: string): PairingConnector | Promise<PairingConnector>;
}
