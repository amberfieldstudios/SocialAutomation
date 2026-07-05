/**
 * @social/auth — encrypted token vault, key management, token refresh
 * (proactive + lazy) with cross-worker locking, and multi-account management.
 * Implements docs/AUTH.md. Depends only on `@social/core` (types/errors) and
 * `@social/db` (storage, via the ports in `store.ts`); reaches connectors via a
 * `ConnectorResolver` (the plugin registry), never by importing a plugin.
 */

export * from './errors';
export * from './types';

// Crypto / key management
export * from './crypto/aead';
export * from './crypto/keyring';
export { TokenVault } from './vault';

// Storage ports + in-memory adapters
export * from './store';

// Managers + context
export { buildOperationContext } from './context';
export {
  TokenManager,
  type TokenManagerDeps,
  type TokenRefresher,
  type ConnectorResolver,
  type AppCredentialsResolver,
} from './token-manager';
export { AccountManager, type AccountManagerDeps, profileToAccountInput } from './account-manager';

// Scope catalog (least privilege)
export {
  SCOPES,
  type PlatformScopeSpec,
  resolveRequestedScopes,
  requiredScopesForOperation,
  missingScopes,
  validateGranted,
  hasScopesForOperation,
} from './scopes';

// OAuth pairing subsystem (authorize URL / callback / device / app-password)
export * from './oauth';

// Proactive refresh scheduler
export {
  RefreshScheduler,
  type RefreshSchedulerDeps,
  type RefreshScanResult,
} from './refresh-scheduler';
