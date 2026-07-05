/**
 * Job lifecycle events, emitted by the `Worker` and consumable by outbound
 * webhooks/notifications (see `webhook.ts`). Every event corresponds to a
 * persisted state transition, so anything subscribed here is guaranteed to be
 * consistent with what's in `publish_jobs`/`dead_letter_jobs` at the moment of
 * emission.
 */

import type { DeadLetterJobRecord, FailureInfo, PublishJobRecord } from './types';

export type JobLifecycleEventType = 'job.published' | 'job.retry_scheduled' | 'job.dead_lettered';

export interface JobLifecycleEventBase {
  type: JobLifecycleEventType;
  /** ISO-8601 timestamp the event was emitted. */
  at: string;
  job: PublishJobRecord;
}

export interface JobPublishedEvent extends JobLifecycleEventBase {
  type: 'job.published';
  result: unknown;
}

export interface JobRetryScheduledEvent extends JobLifecycleEventBase {
  type: 'job.retry_scheduled';
  error: FailureInfo;
  nextRunAt: string;
  attempt: number;
  delayMs: number;
}

export interface JobDeadLetteredEvent extends JobLifecycleEventBase {
  type: 'job.dead_lettered';
  error: FailureInfo;
  reason: 'exhausted_retries' | 'non_retryable';
  deadLetter: DeadLetterJobRecord;
}

export type JobLifecycleEvent = JobPublishedEvent | JobRetryScheduledEvent | JobDeadLetteredEvent;

/** Sink for lifecycle events. Implementations MUST NOT throw — failures to
 * notify must never affect job outcome; catch and log internally instead. */
export type JobEventListener = (event: JobLifecycleEvent) => void | Promise<void>;
