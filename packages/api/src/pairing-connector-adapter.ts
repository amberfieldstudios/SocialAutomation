/**
 * Adapts `@social/pipeline`'s `PluginConnectorResolver` (hands out real
 * `PlatformConnector`s, typed against `@social/core`'s `AuthRequest`) to the
 * `PairingConnectorResolver` port `@social/auth`'s `PairingCoordinator` needs
 * (typed against the auth layer's superset `PairingAuthRequest`, which adds
 * `device_code`/`device_token` for headless pairing — see
 * `packages/auth/src/oauth/registry.ts`'s contract note routed to
 * core-architect for folding into the core contract).
 *
 * The setup wizard (t1) never drives a device-code flow (Twitch's redirect
 * `auth_code_pkce` path covers it; device-code is only an "alternate" per
 * docs/AUTH.md), so this adapter forwards every other kind straight through
 * and fails closed with a clear error on the two kinds no connector here
 * implements.
 */

import type { PlatformConnector } from '@social/core';
import type { PairingAuthRequest, PairingAuthResult, PairingConnector, PairingConnectorResolver } from '@social/auth';

class ConnectorPairingAdapter implements PairingConnector {
  constructor(private readonly connector: PlatformConnector) {}

  async authenticate(request: PairingAuthRequest): Promise<PairingAuthResult> {
    if (request.kind === 'device_code' || request.kind === 'device_token') {
      throw new Error(
        `The setup wizard does not offer a device-code connection for this platform. Please use the on-screen "Connect" button instead.`,
      );
    }
    return this.connector.authenticate(request);
  }
}

export interface PlatformConnectorResolver {
  get(platformId: string): PlatformConnector;
}

export function toPairingConnectorResolver(resolver: PlatformConnectorResolver): PairingConnectorResolver {
  return {
    get(platformId: string): PairingConnector {
      return new ConnectorPairingAdapter(resolver.get(platformId));
    },
  };
}
