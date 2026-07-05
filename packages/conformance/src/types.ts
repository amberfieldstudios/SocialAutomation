/**
 * Public types for the shared conformance harness.
 *
 * A plugin runs the suite with:
 *   runConformance(manifest.createConnector, manifest.capabilities, mockEnv)
 *
 * where `mockEnv` supplies the platform-specific fixtures (a valid + an invalid
 * payload, a live token, the official API hosts, and a canned HTTP responder).
 * The harness itself is platform-agnostic — it only knows the contract.
 */

import type { AppCredentials, PostPayload, TokenSet } from '@social/core';

/** Scenario the harness asks the mock HTTP responder to simulate. */
export type RouteScenario = 'ok' | 'rateLimited';

/** A normalized view of one outbound request the connector attempted. */
export interface RoutedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/**
 * Everything platform-specific the harness needs. Lives in each plugin's own
 * conformance test so plugin knowledge stays in the plugin.
 */
export interface ConformanceMockEnv {
  /**
   * Every official API host the connector is allowed to talk to (hostname only,
   * e.g. 'discord.com', 'api.twitch.tv'). The suite fails if any request during
   * the happy path targets a host outside this set (scraping / undocumented host
   * guard), and checks the descriptor's apiBaseUrl host is in here too.
   */
  allowedHosts: string[];

  /** A live OperationContext token for authenticated calls. */
  token: TokenSet;

  /**
   * The app credentials `OperationContext.app` carries alongside `token`
   * (Contract v1.1+). Defaults to `{ clientId: 'conformance-client' }` when
   * omitted.
   */
  app?: AppCredentials;

  /** Internal accounts.id used in the OperationContext (defaults to 'acct-conformance'). */
  accountId?: string;

  /**
   * A payload `validatePost` ACCEPTS and which, on `publish`, actually reaches
   * the network (so the happy-path / official-host / redaction checks exercise a
   * real request). Include whatever platformOptions the connector needs to route
   * (e.g. Discord's channelId).
   */
  validPayload: PostPayload;

  /**
   * A payload `validatePost` REJECTS. `publish`/`edit` must refuse it with a
   * ValidationFailedError WITHOUT making any network call.
   */
  invalidPayload: PostPayload;

  /**
   * Raw secret strings that must NEVER appear in any emitted log line
   * (access token, refresh token, webhook secret, etc.).
   */
  secrets: string[];

  /**
   * Canned HTTP responder. Called for every outbound request. `scenario` lets
   * the harness force error conditions:
   *   - 'ok'          — return success responses for the whole publish flow.
   *   - 'rateLimited' — return HTTP 429 for the terminal publish call (return
   *                     success for any prerequisite calls, e.g. token validate).
   */
  route: (req: RoutedRequest, scenario: RouteScenario) => Response | Promise<Response>;

  /**
   * A remoteId shaped the way this connector's delete/edit/getAnalytics expect.
   * Used only to probe unsupported-op throwing; defaults to 'conformance-remote-id'.
   */
  sampleRemoteId?: string;
}
