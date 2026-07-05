/**
 * Device Authorization Grant polling helper (RFC 8628, docs/AUTH.md §6).
 *
 * After `beginPairing` starts a device flow, the user approves the code at the
 * platform's verification URL while we poll the token endpoint. This helper runs
 * the poll loop, honoring the server's interval and `slow_down` backoff, and
 * stops with `DeviceAuthorizationExpiredError` if the code expires first.
 *
 * The clock (`now`) and `sleep` are injectable so tests run without real timers.
 * SECURITY: the `deviceCode` is a secret — it is passed to the connector but
 * never logged.
 */

import type { AppCredentials } from '@social/core';
import { DeviceAuthorizationExpiredError } from '../errors';
import type { PairingAuthResult, PairingConnector } from './registry';

export interface DevicePollOptions {
  /** Server-advertised minimum seconds between polls. */
  intervalSec: number;
  /** Server-advertised lifetime of the device code, in seconds. */
  expiresInSec: number;
  /** Epoch-ms clock; defaults to `Date.now`. */
  now?: () => number;
  /** Sleep for `ms`; defaults to a real timer. Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Seconds added to the interval on each `slow_down` (RFC 8628 §3.5). Default 5. */
  slowDownIncrementSec?: number;
  /** Safety cap on poll attempts, independent of the clock. Default 1000. */
  maxAttempts?: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll the connector for the device token until it is issued, the code expires,
 * or the attempt cap is hit. Returns the `PairingAuthResult` carrying the token.
 */
export async function pollForDeviceToken(
  connector: PairingConnector,
  app: AppCredentials,
  deviceCode: string,
  platformId: string,
  options: DevicePollOptions,
): Promise<PairingAuthResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const slowDownIncrementSec = options.slowDownIncrementSec ?? 5;
  const maxAttempts = options.maxAttempts ?? 1000;

  const deadline = now() + options.expiresInSec * 1000;
  let intervalSec = options.intervalSec;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (now() >= deadline) {
      throw new DeviceAuthorizationExpiredError(platformId);
    }
    await sleep(intervalSec * 1000);

    const result = await connector.authenticate({ kind: 'device_token', app, deviceCode });
    if (result.token) {
      return result;
    }
    if (result.pending === 'slow_down') {
      intervalSec += slowDownIncrementSec;
    }
    // 'authorization_pending' (or undefined): keep polling at the current interval.
  }
  throw new DeviceAuthorizationExpiredError(platformId);
}
