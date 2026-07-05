/**
 * `ScheduleMaterializer` — the sweep that turns due schedule occurrences into
 * submitted campaigns/publish jobs.
 *
 * One sweep (`materializeDue`):
 *   1. `schedules.listDue(now)` — every `pending`/`active` schedule whose
 *      `next_run_at <= now`.
 *   2. For each, compute the NEXT `next_run_at` (`null` for one-shot
 *      immediate/scheduled; the rule's next hop for recurring).
 *   3. `schedules.claimOccurrence(...)` — a compare-and-swap `UPDATE` that
 *      only succeeds if `next_run_at` still matches what was just read. This
 *      is what makes overlapping/duplicate sweeps safe: if two sweeps (or a
 *      crash-and-restart re-sweep of the same window) both see the same due
 *      schedule, only one of them wins the claim; the loser skips it
 *      entirely — no double submit.
 *   4. Only the CLAIM WINNER calls the injected `submit()` (the pipeline
 *      port), passing `occurrenceKey` — the occurrence's UTC instant,
 *      ISO-8601 — for the caller to thread into the queue's idempotency key.
 *
 * Every occurrence's outcome (claimed/skipped/submitted/failed) is logged
 * with the schedule id, mode, and occurrence instant.
 */

import type { StructuredLogger } from '@social/core';
import { nextOccurrence } from './recurrence';
import { utcToLocalIso } from './timezone';
import type { ScheduleRecord, ScheduleSubmitFn, SchedulesPort } from './types';

export interface ScheduleMaterializerOptions {
  schedules: SchedulesPort;
  submit: ScheduleSubmitFn;
  logger: StructuredLogger;
  now?: () => Date;
}

export interface MaterializeOutcome {
  scheduleId: string;
  occurrenceAt: string;
  outcome: 'submitted' | 'skipped_lost_claim' | 'submit_failed';
  error?: string;
}

export class ScheduleMaterializer {
  private readonly now: () => Date;

  constructor(private readonly options: ScheduleMaterializerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** Sweeps all schedules due at-or-before `at` (defaults to the injected clock's current time). */
  async materializeDue(at?: Date): Promise<MaterializeOutcome[]> {
    const now = at ?? this.now();
    const log = this.options.logger.child({ op: 'scheduler.materialize' });
    const due = this.options.schedules.listDue(now);

    if (due.length === 0) {
      log.debug('scheduler.materialize.none_due', { now: now.toISOString() });
      return [];
    }

    log.info('scheduler.materialize.sweep_start', { now: now.toISOString(), dueCount: due.length });

    const outcomes: MaterializeOutcome[] = [];
    for (const schedule of due) {
      outcomes.push(await this.materializeOne(schedule, now, log));
    }

    log.info('scheduler.materialize.sweep_done', {
      now: now.toISOString(),
      submitted: outcomes.filter((o) => o.outcome === 'submitted').length,
      skippedLostClaim: outcomes.filter((o) => o.outcome === 'skipped_lost_claim').length,
      failed: outcomes.filter((o) => o.outcome === 'submit_failed').length,
    });

    return outcomes;
  }

  private async materializeOne(
    schedule: ScheduleRecord,
    now: Date,
    log: StructuredLogger,
  ): Promise<MaterializeOutcome> {
    // `listDue` already guarantees this, but a schedule with a null
    // `next_run_at` can never be "due" in the first place — narrow the type.
    const occurrenceAtIso = schedule.nextRunAt!;
    const occurrenceAt = new Date(occurrenceAtIso);
    const newNextRunAt = this.computeNextRunAt(schedule, occurrenceAt);

    const { claimed, schedule: claimedSchedule } = this.options.schedules.claimOccurrence(
      schedule.id,
      occurrenceAtIso,
      occurrenceAtIso,
      newNextRunAt,
    );

    if (!claimed) {
      log.info('scheduler.materialize.skipped_lost_claim', {
        scheduleId: schedule.id,
        mode: schedule.mode,
        occurrenceAt: occurrenceAtIso,
      });
      return { scheduleId: schedule.id, occurrenceAt: occurrenceAtIso, outcome: 'skipped_lost_claim' };
    }

    try {
      const result = await this.options.submit({
        schedule: claimedSchedule,
        occurrenceAt,
        occurrenceKey: occurrenceAtIso,
      });
      log.info('scheduler.materialize.submitted', {
        scheduleId: schedule.id,
        mode: schedule.mode,
        occurrenceAt: occurrenceAtIso,
        nextRunAt: newNextRunAt,
        postVariantId: result.postVariantId,
        jobId: result.jobId,
        deduped: result.deduped ?? false,
      });
      return { scheduleId: schedule.id, occurrenceAt: occurrenceAtIso, outcome: 'submitted' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('scheduler.materialize.submit_failed', {
        scheduleId: schedule.id,
        mode: schedule.mode,
        occurrenceAt: occurrenceAtIso,
        error: message,
      });
      return { scheduleId: schedule.id, occurrenceAt: occurrenceAtIso, outcome: 'submit_failed', error: message };
    }
  }

  private computeNextRunAt(schedule: ScheduleRecord, occurrenceAt: Date): string | null {
    if (schedule.mode !== 'recurring') return null; // immediate/scheduled are one-shot.
    if (!schedule.recurrenceRule) return null;
    // Reconstruct the RRULE dtstart's local wall-clock time from the
    // persisted anchor (`run_at`) — see `ScheduleService.scheduleRecurring`.
    // Cron rules ignore this parameter.
    const dtstartLocalIso = schedule.runAt ? utcToLocalIso(new Date(schedule.runAt), schedule.timezone) : undefined;
    const next = nextOccurrence(schedule.recurrenceRule, schedule.timezone, dtstartLocalIso, occurrenceAt);
    return next ? next.toISOString() : null;
  }
}
