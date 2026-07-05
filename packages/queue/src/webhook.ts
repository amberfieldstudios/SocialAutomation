/**
 * Outbound webhook delivery for job lifecycle events. Wire it up via
 * `Worker`'s `onEvent` option: `new Worker({ ..., onEvent: notifier.handle })`.
 *
 * Hardening (m2, t22) over the original fire-and-log skeleton:
 *   - Every delivery carries an `X-Signature` header: `sha256=<hex hmac>` of
 *     the raw JSON body, computed with a per-subscription secret. Receivers
 *     verify with `verifyWebhookSignature` (or their own constant-time HMAC
 *     compare) before trusting a payload. The secret itself is NEVER logged —
 *     only the subscription id.
 *   - A minimal in-process subscription registry (`subscribe`/`unsubscribe`/
 *     `list`) replaces the flat `urls: string[]` array, so each destination
 *     gets its own secret and optional event-type filter. `listSecrets()`
 *     intentionally does not exist; `list()` never exposes `secret`.
 *   - Delivery retries with the same exponential-backoff-with-jitter policy
 *     as job retries (`retry.ts`), scheduled via `setTimeout` so the caller
 *     (the `Worker`) is never blocked waiting on retries. Exhausting retries
 *     only logs a final failure — it NEVER touches job/store state. A
 *     subscription's delivery failures are fully independent of, and cannot
 *     affect, the outcome already persisted by the `Worker`.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { StructuredLogger } from '@social/core';
import type { JobLifecycleEvent } from './events';
import { computeBackoffDelayMs, resolveBackoffOptions, type BackoffOptions } from './retry';

export interface WebhookSubscriptionInput {
  url: string;
  /** HMAC-SHA256 signing secret for this destination. Never logged. */
  secret: string;
  /** Which event types to deliver. Defaults to all three lifecycle events. */
  eventTypes?: JobLifecycleEvent['type'][];
}

/** Public view of a subscription — deliberately omits `secret`. */
export interface WebhookSubscriptionInfo {
  id: string;
  url: string;
  eventTypes: JobLifecycleEvent['type'][];
  createdAt: string;
}

interface WebhookSubscriptionRecord extends WebhookSubscriptionInfo {
  secret: string;
}

export interface WebhookNotifierOptions {
  logger: StructuredLogger;
  /** Seed subscriptions at construction time. More can be added via `subscribe()`. */
  subscriptions?: WebhookSubscriptionInput[];
  /**
   * Back-compat convenience: destination URL(s) with no signing secret. Kept
   * for the pre-hardening call sites; prefer `subscribe()` with a secret for
   * anything new. Unsigned deliveries omit `X-Signature`.
   */
  urls?: string[];
  /** Injectable for tests; defaults to global fetch (Node 22+). */
  fetchImpl?: typeof fetch;
  backoff?: Partial<BackoffOptions>;
  /** Injectable clock/RNG, primarily for tests. */
  now?: () => Date;
  random?: () => number;
  /** Injectable scheduler for retry delays, primarily for tests. Defaults to `setTimeout`. */
  scheduleRetry?: (fn: () => void, delayMs: number) => void;
}

const ALL_EVENT_TYPES: JobLifecycleEvent['type'][] = ['job.published', 'job.retry_scheduled', 'job.dead_lettered'];

function buildBody(event: JobLifecycleEvent): string {
  return JSON.stringify({
    type: event.type,
    at: event.at,
    jobId: event.job.id,
    postVariantId: event.job.postVariantId,
    operation: event.job.operation,
    attempts: event.job.attempts,
    ...('error' in event ? { error: event.error } : {}),
    ...('nextRunAt' in event ? { nextRunAt: event.nextRunAt } : {}),
    ...('reason' in event ? { reason: event.reason } : {}),
  });
}

/** `sha256=<hex>` HMAC of `body` under `secret`. */
export function signWebhookPayload(body: string, secret: string): string {
  const digest = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  return `sha256=${digest}`;
}

/** Constant-time verification of an `X-Signature` header against `body` + `secret`. */
export function verifyWebhookSignature(body: string, secret: string, signature: string): boolean {
  const expected = signWebhookPayload(body, secret);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export class WebhookNotifier {
  private readonly logger: StructuredLogger;
  private readonly fetchImpl: typeof fetch;
  private readonly backoff: BackoffOptions;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly scheduleRetry: (fn: () => void, delayMs: number) => void;
  private readonly subscriptions = new Map<string, WebhookSubscriptionRecord>();

  constructor(options: WebhookNotifierOptions) {
    this.logger = options.logger.child({ component: 'queue.webhook' });
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.backoff = resolveBackoffOptions(options.backoff);
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.scheduleRetry = options.scheduleRetry ?? ((fn, delayMs) => {
      setTimeout(fn, delayMs);
    });

    for (const sub of options.subscriptions ?? []) {
      this.subscribe(sub);
    }
    // Back-compat: bare URLs with no secret -> unsigned deliveries.
    for (const url of options.urls ?? []) {
      this.subscribe({ url, secret: '' });
    }
  }

  /** Registers a new delivery destination. Returns the public (secret-free) subscription info. */
  subscribe(input: WebhookSubscriptionInput): WebhookSubscriptionInfo {
    const id = `whsub_${randomUUID()}`;
    const record: WebhookSubscriptionRecord = {
      id,
      url: input.url,
      secret: input.secret,
      eventTypes: input.eventTypes ?? ALL_EVENT_TYPES,
      createdAt: this.now().toISOString(),
    };
    this.subscriptions.set(id, record);
    // Never log `secret`.
    this.logger.info('webhook.subscribed', { subscriptionId: id, url: record.url, eventTypes: record.eventTypes });
    return toInfo(record);
  }

  unsubscribe(id: string): boolean {
    const existed = this.subscriptions.delete(id);
    if (existed) this.logger.info('webhook.unsubscribed', { subscriptionId: id });
    return existed;
  }

  /** Lists subscriptions. Never includes `secret`. */
  list(): WebhookSubscriptionInfo[] {
    return [...this.subscriptions.values()].map(toInfo);
  }

  /** Bind this as a `Worker`'s (or `ReclaimSweeper`'s) `onEvent` listener. */
  handle = async (event: JobLifecycleEvent): Promise<void> => {
    const body = buildBody(event);
    await Promise.all(
      [...this.subscriptions.values()]
        .filter((sub) => sub.eventTypes.includes(event.type))
        .map((sub) => this.deliverWithRetry(sub, event, body, 1)),
    );
  };

  private async deliverWithRetry(
    sub: WebhookSubscriptionRecord,
    event: JobLifecycleEvent,
    body: string,
    attempt: number,
  ): Promise<void> {
    const ok = await this.deliverOnce(sub, event, body, attempt);
    if (ok) return;

    if (attempt >= this.backoff.maxAttempts) {
      this.logger.error('webhook.delivery_exhausted', {
        subscriptionId: sub.id,
        url: sub.url,
        eventType: event.type,
        jobId: event.job.id,
        attempts: attempt,
      });
      // Delivery failure is terminal for the notification only — job state is
      // untouched, by construction (this class never calls into JobStore).
      return;
    }

    const delayMs = computeBackoffDelayMs(attempt, this.backoff, this.random);
    await new Promise<void>((resolve) => {
      this.scheduleRetry(() => {
        this.deliverWithRetry(sub, event, body, attempt + 1).then(resolve, resolve);
      }, delayMs);
    });
  }

  private async deliverOnce(
    sub: WebhookSubscriptionRecord,
    event: JobLifecycleEvent,
    body: string,
    attempt: number,
  ): Promise<boolean> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (sub.secret) {
      headers['X-Signature'] = signWebhookPayload(body, sub.secret);
    }
    try {
      const res = await this.fetchImpl(sub.url, { method: 'POST', headers, body });
      if (!res.ok) {
        this.logger.warn('webhook.delivery_failed', {
          subscriptionId: sub.id,
          url: sub.url,
          status: res.status,
          eventType: event.type,
          jobId: event.job.id,
          attempt,
        });
        return false;
      }
      this.logger.info('webhook.delivered', {
        subscriptionId: sub.id,
        url: sub.url,
        eventType: event.type,
        jobId: event.job.id,
        attempt,
      });
      return true;
    } catch (error) {
      this.logger.warn('webhook.delivery_error', {
        subscriptionId: sub.id,
        url: sub.url,
        eventType: event.type,
        jobId: event.job.id,
        attempt,
        error: String(error),
      });
      return false;
    }
  }
}

function toInfo(record: WebhookSubscriptionRecord): WebhookSubscriptionInfo {
  return { id: record.id, url: record.url, eventTypes: record.eventTypes, createdAt: record.createdAt };
}
