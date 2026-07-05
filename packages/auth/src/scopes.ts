/**
 * Required-scope catalog + least-privilege helpers (docs/AUTH.md §5).
 *
 * This is the single source of truth for which OAuth scopes each platform
 * operation requires. Two jobs:
 *
 *  1. `resolveRequestedScopes(platform, ops)` builds the MINIMAL scope set to
 *     request at pairing — `base` plus the union of scopes for exactly the
 *     operations the user enabled on that account. We never request analytics
 *     scopes for a publish-only account, etc.
 *  2. `validateGranted(platform, ops, granted)` checks that a paired account's
 *     GRANTED scopes cover an operation's required scopes before it runs, and
 *     throws `InsufficientScopeError` (with the exact missing scope NAMES, no
 *     secrets) if not. Used both at pairing (granted vs. requested) and pre-use
 *     (stored vs. required for the specific op).
 *
 * Connectors MUST NOT invent scopes inline — they come from here so over-broad
 * requests are visible and reviewable (the auth-security review hook, §5).
 */

import type { ConnectorOperation } from '@social/core';
import { InsufficientScopeError } from './errors';

/** Per-platform scope specification. */
export interface PlatformScopeSpec {
  /** Always requested (e.g. identity/profile read needed to resolve the account). */
  base: string[];
  /** Additional scopes required per operation; requested only if the op is enabled. */
  byOperation: Partial<Record<ConnectorOperation, string[]>>;
}

/**
 * The catalog. Scope strings are the platforms' own official scope identifiers.
 * Extend as connectors land; keep it least-privilege.
 *
 * - **twitch**: OAuth2 scopes (https://dev.twitch.tv/docs/authentication/scopes).
 * - **discord**: OAuth2 scopes for the user-context path
 *   (https://discord.com/developers/docs/topics/oauth2). The bot-token/webhook
 *   posting path is NOT OAuth-scoped (the bot's permissions are set on the app /
 *   guild), so it declares no `byOperation` scopes.
 * - **bluesky**: AT Protocol app-password sessions are not OAuth-scoped — an app
 *   password grants a fixed capability set — so there are no scope strings to
 *   validate. Present with empty sets so the platform is known to the catalog.
 */
export const SCOPES: Record<string, PlatformScopeSpec> = {
  twitch: {
    // user:read:email lets us resolve the paired channel's identity/profile.
    base: ['user:read:email'],
    byOperation: {
      publish: ['channel:manage:broadcast'],
      getAnalytics: ['analytics:read:games', 'channel:read:subscriptions'],
    },
  },
  discord: {
    // identify resolves the account; guilds lets us associate the target server.
    base: ['identify', 'guilds'],
    byOperation: {
      // User-context OAuth path: the user grants us an incoming webhook to post through.
      publish: ['webhook.incoming'],
    },
  },
  bluesky: {
    base: [],
    byOperation: {},
  },
};

/** Look up a platform's spec, defaulting to empty (unknown platform = no scopes to enforce). */
function specFor(platform: string): PlatformScopeSpec {
  return SCOPES[platform] ?? { base: [], byOperation: {} };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * The MINIMAL scope set to request when pairing an account for `operations`:
 * `base` plus the union of each enabled operation's required scopes. Order is
 * stable (base first, then operations in call order) and de-duplicated.
 */
export function resolveRequestedScopes(platform: string, operations: ConnectorOperation[]): string[] {
  const spec = specFor(platform);
  const out = [...spec.base];
  for (const op of operations) {
    for (const scope of spec.byOperation[op] ?? []) out.push(scope);
  }
  return unique(out);
}

/** The scopes required for a SINGLE operation (base + that op). */
export function requiredScopesForOperation(platform: string, operation: ConnectorOperation): string[] {
  const spec = specFor(platform);
  return unique([...spec.base, ...(spec.byOperation[operation] ?? [])]);
}

/** Which of `required` are absent from `granted`. Empty array = fully covered. */
export function missingScopes(required: string[], granted: string[]): string[] {
  const have = new Set(granted);
  return required.filter((scope) => !have.has(scope));
}

/**
 * Assert `granted` covers every scope required for `operations` on `platform`.
 * Throws `InsufficientScopeError` (missing scope NAMES only) otherwise. Used at
 * pairing (operations = all enabled ops) and pre-use (operations = [the op]).
 */
export function validateGranted(
  platform: string,
  operations: ConnectorOperation[],
  granted: string[],
): void {
  const required = unique(operations.flatMap((op) => requiredScopesForOperation(platform, op)));
  const missing = missingScopes(required, granted);
  if (missing.length > 0) {
    throw new InsufficientScopeError(platform, missing, required, granted);
  }
}

/** Non-throwing variant: does `granted` cover `operation` for `platform`? */
export function hasScopesForOperation(
  platform: string,
  operation: ConnectorOperation,
  granted: string[],
): boolean {
  return missingScopes(requiredScopesForOperation(platform, operation), granted).length === 0;
}
