/**
 * `ScheduleService` — builds `schedules` rows for the three publish modes,
 * doing the local-wall-clock -> UTC conversion (and, for recurring, the
 * first-occurrence lookup) at creation time so `next_run_at` is always a
 * ready-to-compare UTC instant for `ScheduleMaterializer.listDue()`.
 */

import type { StructuredLogger } from '@social/core';
import { firstOccurrenceAtOrAfter } from './recurrence';
import { localToUtc } from './timezone';
import type { ScheduleRecord, SchedulesPort } from './types';

export interface ScheduleImmediateInput {
  postId?: string | null;
  postVariantId?: string | null;
}

export interface ScheduleOnceInput {
  postId?: string | null;
  postVariantId?: string | null;
  /** Local wall-clock time, no offset, e.g. `'2026-07-04T09:00:00'`. */
  localDateTime: string;
  /** IANA timezone `localDateTime` is expressed in, e.g. `'Africa/Johannesburg'`. */
  timezone: string;
}

export interface ScheduleRecurringInput {
  postId?: string | null;
  postVariantId?: string | null;
  /** Local wall-clock anchor the recurrence's day/time pattern is evaluated against. */
  startLocalDateTime: string;
  timezone: string;
  /** RFC-5545 RRULE (e.g. `'FREQ=DAILY'`) or a 5-field cron expression (e.g. `'0 9 * * *'`). */
  recurrenceRule: string;
}

export interface ScheduleServiceOptions {
  schedules: SchedulesPort;
  logger: StructuredLogger;
  now?: () => Date;
}

export class ScheduleService {
  private readonly now: () => Date;

  constructor(private readonly options: ScheduleServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** Fires as soon as the materializer's next sweep picks it up. */
  scheduleImmediate(input: ScheduleImmediateInput): ScheduleRecord {
    const nowIso = this.now().toISOString();
    const record = this.options.schedules.create({
      postId: input.postId ?? null,
      postVariantId: input.postVariantId ?? null,
      mode: 'immediate',
      runAt: null,
      timezone: 'UTC',
      recurrenceRule: null,
      nextRunAt: nowIso,
    });
    this.options.logger.info('scheduler.schedule.immediate_created', { scheduleId: record.id });
    return record;
  }

  /** Fires once at `localDateTime` in `timezone`, converted to UTC now (so DST is resolved at creation time, not fire time). */
  scheduleOnce(input: ScheduleOnceInput): ScheduleRecord {
    const runAtUtc = localToUtc(input.localDateTime, input.timezone);
    const record = this.options.schedules.create({
      postId: input.postId ?? null,
      postVariantId: input.postVariantId ?? null,
      mode: 'scheduled',
      runAt: runAtUtc.toISOString(),
      timezone: input.timezone,
      recurrenceRule: null,
      nextRunAt: runAtUtc.toISOString(),
    });
    this.options.logger.info('scheduler.schedule.scheduled_created', {
      scheduleId: record.id,
      localDateTime: input.localDateTime,
      timezone: input.timezone,
      runAtUtc: record.runAt,
    });
    return record;
  }

  /**
   * Fires repeatedly per `recurrenceRule`, evaluated as a local wall-clock
   * pattern in `timezone`. `runAt` persists the anchor UTC instant (recovered
   * later via `utcToLocalIso` to reconstruct the RRULE's dtstart — see
   * `occurrence.ts`); `nextRunAt` is the first occurrence at-or-after that
   * anchor.
   */
  scheduleRecurring(input: ScheduleRecurringInput): ScheduleRecord {
    const anchorUtc = localToUtc(input.startLocalDateTime, input.timezone);
    const first = firstOccurrenceAtOrAfter(input.recurrenceRule, input.timezone, input.startLocalDateTime, anchorUtc);
    if (!first) {
      throw new Error(`recurrence rule '${input.recurrenceRule}' produced no occurrences at or after its anchor`);
    }
    const record = this.options.schedules.create({
      postId: input.postId ?? null,
      postVariantId: input.postVariantId ?? null,
      mode: 'recurring',
      runAt: anchorUtc.toISOString(),
      timezone: input.timezone,
      recurrenceRule: input.recurrenceRule,
      nextRunAt: first.toISOString(),
    });
    this.options.logger.info('scheduler.schedule.recurring_created', {
      scheduleId: record.id,
      recurrenceRule: input.recurrenceRule,
      timezone: input.timezone,
      firstOccurrenceUtc: record.nextRunAt,
    });
    return record;
  }
}
