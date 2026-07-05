/**
 * The PlatformConnector contract.
 *
 * Every platform plugin implements this interface exactly. The conformance
 * suite (owned by qa-review) tests real connectors against it. The core NEVER
 * imports a specific platform — it only ever holds `PlatformConnector` values
 * obtained from the plugin registry, which is what lets new platforms be added
 * without touching the core.
 *
 * NON-NEGOTIABLE for every implementation:
 *  - Official platform APIs only. No scraping, no undocumented endpoints, no
 *    browser automation.
 *  - Never persist or log raw credentials/tokens.
 *  - `publish`/`edit` MUST first pass what `validatePost` would accept — never
 *    "try anyway".
 *  - Operations declared unsupported in the CapabilityDescriptor MUST throw
 *    `NotSupportedError`.
 */

import type { StructuredLogger } from '../logging';
import type { CapabilityDescriptor } from './capabilities';
import type {
  AnalyticsQuery,
  AnalyticsSnapshot,
  AuthRequest,
  AuthResult,
  ConnectInput,
  ConnectResult,
  DeleteRequest,
  DeleteResult,
  DisconnectResult,
  EditRequest,
  EditResult,
  MediaSource,
  OperationContext,
  PostPayload,
  PublishResult,
  RefreshInput,
  TokenSet,
  UploadedMedia,
  ValidationResult,
} from './types';

export interface PlatformConnector {
  /**
   * Static declaration of what this platform supports. When support for an
   * operation depends on the SHAPE of the credential in play (e.g. Discord:
   * `refreshToken`/`disconnect` are meaningful for an OAuth2 user token but
   * not for a static bot token or webhook URL), this MUST be the most
   * permissive descriptor (i.e. `true` for anything supported by ANY
   * credential shape this connector accepts) and the connector MUST also
   * implement `capabilitiesFor` — see there for the per-credential rule.
   */
  readonly capabilities: CapabilityDescriptor;

  /**
   * Contract v1.1+, OPTIONAL: the capability descriptor for one specific
   * credential (as carried by `OperationContext.token` / `RefreshInput.token`),
   * when support varies by credential shape. Not implementing this means
   * `capabilities` applies uniformly to every credential this connector
   * accepts.
   *
   * The same "declare it AND throw" invariant as the static descriptor
   * applies here, scoped to the credential: if `capabilitiesFor(token).operations.x`
   * is `false`, calling `x` with that token MUST throw `NotSupportedError`
   * (never a plain `AuthError` — `NotSupportedError` is reserved for "this
   * operation cannot be performed with this credential/platform", which is
   * exactly this case). Callers that need to feature-detect for a specific
   * account should call `connector.capabilitiesFor?.(token) ?? connector.capabilities`
   * rather than only reading the static `capabilities` getter.
   */
  capabilitiesFor?(token: TokenSet): CapabilityDescriptor;

  /**
   * Prepare the connector for use with an account context: validate app config,
   * construct the API client, verify reachability. Non-interactive.
   */
  connect(input: ConnectInput): Promise<ConnectResult>;

  /**
   * Drive the OAuth flow: produce an authorize URL, exchange a code for a
   * TokenSet, or perform a client-credentials grant, per `request.kind`.
   */
  authenticate(request: AuthRequest): Promise<AuthResult>;

  /**
   * Exchange a refresh token for a fresh TokenSet. Implementations should throw
   * `TokenRevokedError` when the grant is no longer valid.
   */
  refreshToken(input: RefreshInput): Promise<TokenSet>;

  /**
   * Pure check of a payload against this platform's rules (character limits,
   * media counts/specs, threading). No network calls, no side effects. Returns
   * a full result; callers decide whether to proceed on warnings.
   */
  validatePost(payload: PostPayload): Promise<ValidationResult>;

  /** Stage one media rendition with the platform, returning a remote handle. */
  uploadMedia(media: MediaSource, ctx: OperationContext): Promise<UploadedMedia>;

  /**
   * Publish a post (and its thread, if present). MUST refuse payloads that
   * `validatePost` would reject (throw `ValidationFailedError`).
   */
  publish(payload: PostPayload, ctx: OperationContext): Promise<PublishResult>;

  /** Delete a previously published post. Unsupported -> `NotSupportedError`. */
  delete(request: DeleteRequest, ctx: OperationContext): Promise<DeleteResult>;

  /** Edit a published post. Unsupported -> `NotSupportedError`. */
  edit(request: EditRequest, ctx: OperationContext): Promise<EditResult>;

  /** Fetch a normalized analytics snapshot for a published post. */
  getAnalytics(query: AnalyticsQuery, ctx: OperationContext): Promise<AnalyticsSnapshot>;

  /** Revoke tokens at the platform where possible and release resources. */
  disconnect(ctx: OperationContext): Promise<DisconnectResult>;
}

/**
 * Runtime services injected into a connector at construction time by the plugin
 * loader. Deliberately minimal: connectors get a logger and config, and build
 * their own HTTP client. They do NOT get direct database/vault access — tokens
 * arrive via `OperationContext`.
 */
export interface ConnectorRuntime {
  logger: StructuredLogger;
  /** Plugin-scoped configuration (never contains raw end-user tokens). */
  config?: Readonly<Record<string, unknown>>;
  /** Clock injection for testability; defaults to `() => new Date()`. */
  now?: () => Date;
}

/** Factory a plugin exports to build its connector instance. */
export type ConnectorFactory = (runtime: ConnectorRuntime) => PlatformConnector;

/**
 * Resolves the CapabilityDescriptor that actually applies to `token` on
 * `connector` — its `capabilitiesFor(token)` override when implemented,
 * otherwise its static `capabilities`. Prefer this over reading
 * `connector.capabilities` directly whenever a specific credential is in
 * hand (see `PlatformConnector.capabilitiesFor`).
 */
export function resolveCapabilities(connector: PlatformConnector, token: TokenSet): CapabilityDescriptor {
  return connector.capabilitiesFor ? connector.capabilitiesFor(token) : connector.capabilities;
}
