/**
 * OAuth pairing subsystem (docs/AUTH.md §6): PKCE + CSRF state, the pairing
 * session store, per-platform flow descriptors, the device-code poll helper, and
 * the `PairingCoordinator` that ties them together.
 */

export { PKCE_METHOD, createVerifier, challengeFor, createState } from './pkce';
export {
  InMemoryPairingSessionStore,
  type PairingSession,
  type PairingSessionStore,
} from './state-store';
export {
  FLOW_REGISTRY,
  defaultFlowRegistry,
  type GrantKind,
  type FlowDescriptor,
  type FlowRegistry,
  type DeviceAuthorization,
  type PairingAuthRequest,
  type PairingAuthResult,
  type PairingConnector,
  type PairingConnectorResolver,
} from './registry';
export { pollForDeviceToken, type DevicePollOptions } from './device-flow';
export {
  PairingCoordinator,
  type PairingCoordinatorDeps,
  type BeginPairingResult,
  type BeginPairingOptions,
  type DeviceAuthorizationPublic,
  type PasswordPairingParams,
  type TokenPairingParams,
} from './flow';
