/**
 * Ports/DTOs the scheduling engine is written against. `SchedulesPort` is the
 * narrow slice of `@social/db`'s `SqliteSchedulesRepo` the engine needs — kept
 * as a structural interface (not an import of the concrete class) so tests can
 * supply an in-memory fake instead of standing up a real SQLite DB.
 */

export type ScheduleMode = 'immediate' | 'scheduled' | 'recurring';
export type ScheduleStatus = 'pending' | 'active' | 'paused' | 'completed' | 'cancelled';

export interface ScheduleRecord {
  id: string;
  postId: string | null;
  postVariantId: string | null;
  mode: ScheduleMode;
  runAt: string | null;
  timezone: string;
  recurrenceRule: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  status: ScheduleStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateScheduleInput {
  postId?: string | null;
  postVariantId?: string | null;
  mode: ScheduleMode;
  runAt?: string | null;
  timezone?: string;
  recurrenceRule?: string | null;
  nextRunAt?: string | null;
  status?: ScheduleStatus;
}

export interface SchedulesPort {
  create(input: CreateScheduleInput): ScheduleRecord;
  get(id: string): ScheduleRecord | undefined;
  list(): ScheduleRecord[];
  listDue(now: Date): ScheduleRecord[];
  claimOccurrence(
    id: string,
    expectedNextRunAt: string,
    occurrenceAt: string,
    newNextRunAt: string | null,
  ): { claimed: boolean; schedule: ScheduleRecord };
  setStatus(id: string, status: ScheduleStatus): ScheduleRecord;
}

/**
 * The outcome of submitting one materialized occurrence — deliberately loose
 * (`Record<string, unknown>`-shaped via index signature) since the concrete
 * shape depends on which pipeline entrypoint the injected `submit` function
 * wraps (`PublishService.submitPost` vs `CampaignService.composeAndSubmit`).
 */
export interface ScheduleSubmitResult {
  [key: string]: unknown;
  postVariantId?: string;
  jobId?: string;
  deduped?: boolean;
}

export interface ScheduleSubmitInput {
  schedule: ScheduleRecord;
  /** The UTC instant of the occurrence being materialized. */
  occurrenceAt: Date;
  /**
   * Stable per-occurrence identity: the occurrence's UTC instant, ISO-8601.
   * Callers MUST thread this into the eventual `@social/queue` idempotency
   * key (`${postVariantId}:${operation}:${occurrenceKey}`, see
   * `@social/queue/src/idempotency.ts`) so recurring occurrences dedupe
   * correctly across retries and re-enqueues — the materializer's own
   * `claimOccurrence` CAS guards against double-*submission*, but the queue's
   * idempotency key is what guards against double-*publishing* if `submit`
   * itself is retried or re-run.
   */
  occurrenceKey: string;
}

export type ScheduleSubmitFn = (input: ScheduleSubmitInput) => Promise<ScheduleSubmitResult>;
