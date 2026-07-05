/**
 * Retry / backoff policy.
 *
 * Formula (equal jitter, capped exponential):
 *
 *   capped = min(maxDelayMs, baseMs * factor ^ (attempt - 1))
 *   delay  = capped / 2 + random(0, capped / 2)
 *
 * `attempt` is the 1-based attempt number that just failed (the first failure
 * is `attempt = 1`). Equal jitter guarantees a delay of at least half the
 * uncapped exponential value (so retries don't collapse toward zero the way
 * full jitter can) while still spreading a thundering herd of simultaneously
 * failing jobs. `random` is injectable so tests can assert exact values.
 */

export interface BackoffOptions {
  /** Delay before the first retry, in ms. Default 1000 (1s). */
  baseMs: number;
  /** Multiplier applied per additional attempt. Default 2. */
  factor: number;
  /** Ceiling on the (pre-jitter) exponential delay, in ms. Default 5 minutes. */
  maxDelayMs: number;
  /** Total attempts allowed before dead-lettering (matches `publish_jobs.max_attempts`). Default 5. */
  maxAttempts: number;
}

export const DEFAULT_BACKOFF_OPTIONS: BackoffOptions = {
  baseMs: 1_000,
  factor: 2,
  maxDelayMs: 5 * 60_000,
  maxAttempts: 5,
};

export function resolveBackoffOptions(overrides?: Partial<BackoffOptions>): BackoffOptions {
  return { ...DEFAULT_BACKOFF_OPTIONS, ...overrides };
}

/**
 * Computes the delay (ms) to wait before retrying after the given attempt
 * number fails. `attempt` is 1-based (the attempt that just failed).
 */
export function computeBackoffDelayMs(
  attempt: number,
  options: BackoffOptions,
  random: () => number = Math.random,
): number {
  const uncapped = options.baseMs * Math.pow(options.factor, Math.max(0, attempt - 1));
  const capped = Math.min(options.maxDelayMs, uncapped);
  const half = capped / 2;
  return Math.round(half + random() * half);
}

/** True once `attempts` (attempts made so far, including the one that just failed) has reached the cap. */
export function isRetryExhausted(attempts: number, options: BackoffOptions): boolean {
  return attempts >= options.maxAttempts;
}
