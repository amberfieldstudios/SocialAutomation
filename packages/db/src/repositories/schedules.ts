/**
 * SQLite-backed repository over the `schedules` table (see migration 0001).
 *
 * A schedule targets either a whole `post` (fan out to its variants — not this
 * package's concern) or a single `post_variant`, and describes WHEN it should
 * fire: `immediate` (fires once, right away), `scheduled` (fires once at
 * `next_run_at`, a UTC instant computed by `@social/scheduler` from a local
 * time + IANA `timezone`), or `recurring` (fires repeatedly per
 * `recurrence_rule`, a cron expression or RFC-5545 RRULE, again evaluated in
 * `timezone` and advanced to its next UTC instant after each materialization).
 *
 * This repo only persists/reads state — it has no opinion on recurrence
 * semantics (that's `@social/scheduler`'s `ScheduleMaterializer`, which reads
 * `listDue()`, submits the occurrence, then calls `recordRun()` to advance
 * `last_run_at`/`next_run_at` (or `status = 'completed'` for one-shots).
 */

import { randomUUID } from 'node:crypto';
import type { StructuredLogger } from '@social/core';
import type { SqlDriver } from '../driver';
import { nullableText } from './rows';

export type ScheduleMode = 'immediate' | 'scheduled' | 'recurring';
export type ScheduleStatus = 'pending' | 'active' | 'paused' | 'completed' | 'cancelled';

export interface ScheduleRecord {
  id: string;
  postId: string | null;
  postVariantId: string | null;
  mode: ScheduleMode;
  /** ISO-8601 UTC instant, for `mode = 'scheduled'`. */
  runAt: string | null;
  /** IANA timezone the schedule's wall-clock time(s) are expressed in. */
  timezone: string;
  /** Cron expression or RFC-5545 RRULE, for `mode = 'recurring'`. */
  recurrenceRule: string | null;
  /** ISO-8601 UTC — the next instant `ScheduleMaterializer` should fire this schedule. */
  nextRunAt: string | null;
  /** ISO-8601 UTC — the last instant this schedule was successfully materialized. */
  lastRunAt: string | null;
  status: ScheduleStatus;
  createdAt: string;
  updatedAt: string;
}

interface ScheduleRow {
  id: string;
  post_id: string | null;
  post_variant_id: string | null;
  mode: string;
  run_at: string | null;
  timezone: string;
  recurrence_rule: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface CreateScheduleInput {
  postId?: string | null;
  postVariantId?: string | null;
  mode: ScheduleMode;
  /** ISO-8601 UTC instant, required for `mode = 'scheduled'`. */
  runAt?: string | null;
  timezone?: string;
  recurrenceRule?: string | null;
  /** ISO-8601 UTC — the first instant this schedule is due. Defaults to `runAt`, or now for `immediate`. */
  nextRunAt?: string | null;
  status?: ScheduleStatus;
}

export interface RecordRunInput {
  /** ISO-8601 UTC instant of the occurrence just materialized. */
  occurrenceAt: string;
  /** ISO-8601 UTC instant of the next occurrence, or `null` if the schedule has no more (one-shots, exhausted recurrences). */
  nextRunAt: string | null;
}

function mapRow(row: ScheduleRow): ScheduleRecord {
  return {
    id: row.id,
    postId: nullableText(row.post_id),
    postVariantId: nullableText(row.post_variant_id),
    mode: row.mode as ScheduleMode,
    runAt: nullableText(row.run_at),
    timezone: row.timezone,
    recurrenceRule: nullableText(row.recurrence_rule),
    nextRunAt: nullableText(row.next_run_at),
    lastRunAt: nullableText(row.last_run_at),
    status: row.status as ScheduleStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteSchedulesRepo {
  constructor(
    private readonly driver: SqlDriver,
    private readonly logger?: StructuredLogger,
  ) {}

  create(input: CreateScheduleInput): ScheduleRecord {
    if (!input.postId && !input.postVariantId) {
      throw new Error('schedule requires postId or postVariantId');
    }
    const now = new Date().toISOString();
    const id = `sch_${randomUUID()}`;
    const nextRunAt =
      input.nextRunAt !== undefined ? input.nextRunAt : (input.runAt ?? (input.mode === 'immediate' ? now : null));

    this.driver.run(
      `INSERT INTO schedules
         (id, post_id, post_variant_id, mode, run_at, timezone, recurrence_rule,
          next_run_at, last_run_at, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      [
        id,
        input.postId ?? null,
        input.postVariantId ?? null,
        input.mode,
        input.runAt ?? null,
        input.timezone ?? 'UTC',
        input.recurrenceRule ?? null,
        nextRunAt,
        input.status ?? 'pending',
        now,
        now,
      ],
    );
    this.logger?.info('scheduler.schedule.created', { scheduleId: id, mode: input.mode, nextRunAt });
    return this.requireRow(id);
  }

  get(id: string): ScheduleRecord | undefined {
    const row = this.driver.get<ScheduleRow>('SELECT * FROM schedules WHERE id = ?', [id]);
    return row ? mapRow(row) : undefined;
  }

  list(): ScheduleRecord[] {
    return this.driver.all<ScheduleRow>('SELECT * FROM schedules ORDER BY created_at').map(mapRow);
  }

  /**
   * Schedules due to fire at or before `now`: `status IN ('pending', 'active')`
   * AND `next_run_at <= now`. Ordered oldest-due-first so a backlog drains
   * fairly. Does NOT claim/lock — `ScheduleMaterializer` is expected to run as
   * a single-writer sweep (or wrap this + `recordRun` in an advisory lock) so
   * concurrent scans don't race; idempotency at the job-enqueue layer is the
   * belt-and-braces guard against double materialization regardless.
   */
  listDue(now: Date): ScheduleRecord[] {
    const nowIso = now.toISOString();
    return this.driver
      .all<ScheduleRow>(
        `SELECT * FROM schedules
          WHERE status IN ('pending', 'active') AND next_run_at IS NOT NULL AND next_run_at <= ?
          ORDER BY next_run_at ASC`,
        [nowIso],
      )
      .map(mapRow);
  }

  /**
   * Advances a schedule after materializing one occurrence: stamps
   * `last_run_at = occurrenceAt`, sets `next_run_at`, and marks `status =
   * 'completed'` when there is no next occurrence (one-shot `immediate` /
   * `scheduled`, or a `recurring` rule that has exhausted its instances);
   * otherwise `status` becomes/stays `active`.
   */
  recordRun(id: string, input: RecordRunInput): ScheduleRecord {
    const now = new Date().toISOString();
    const status: ScheduleStatus = input.nextRunAt ? 'active' : 'completed';
    this.driver.run(
      `UPDATE schedules
         SET last_run_at = ?, next_run_at = ?, status = ?, updated_at = ?
       WHERE id = ?`,
      [input.occurrenceAt, input.nextRunAt, status, now, id],
    );
    const row = this.requireRow(id);
    this.logger?.info('scheduler.schedule.advanced', {
      scheduleId: id,
      occurrenceAt: input.occurrenceAt,
      nextRunAt: input.nextRunAt,
      status,
    });
    return row;
  }

  /**
   * Compare-and-swap claim of one due occurrence: advances `next_run_at`
   * (and `last_run_at`/`status`) ONLY if it still matches `expectedNextRunAt`
   * — the value the caller read via `listDue()`. This is the concurrency
   * guard `ScheduleMaterializer` relies on so two overlapping/duplicate scans
   * (or a crash-and-retry re-scan of the same window) can never both submit
   * the same occurrence: whichever caller's `UPDATE` matches zero rows
   * (`claimed: false`, because another caller already moved `next_run_at`
   * off `expectedNextRunAt` first) backs off without submitting anything.
   *
   * Note the occurrence is considered "claimed" (and consumed) as soon as
   * this call wins, BEFORE the caller has actually submitted it — a submit
   * failure after a won claim does not retry that occurrence. This trades
   * "never miss an occurrence under submit failure" for the stronger, required
   * guarantee "never double-submit an occurrence", matching the job queue's
   * own idempotency-first design.
   */
  claimOccurrence(
    id: string,
    expectedNextRunAt: string,
    occurrenceAt: string,
    newNextRunAt: string | null,
  ): { claimed: boolean; schedule: ScheduleRecord } {
    const now = new Date().toISOString();
    const status: ScheduleStatus = newNextRunAt ? 'active' : 'completed';
    const result = this.driver.run(
      `UPDATE schedules
         SET last_run_at = ?, next_run_at = ?, status = ?, updated_at = ?
       WHERE id = ? AND next_run_at = ? AND status IN ('pending', 'active')`,
      [occurrenceAt, newNextRunAt, status, now, id, expectedNextRunAt],
    );
    const claimed = result.changes === 1;
    if (claimed) {
      this.logger?.info('scheduler.schedule.occurrence_claimed', {
        scheduleId: id,
        occurrenceAt,
        nextRunAt: newNextRunAt,
      });
    }
    return { claimed, schedule: this.requireRow(id) };
  }

  setStatus(id: string, status: ScheduleStatus): ScheduleRecord {
    const now = new Date().toISOString();
    this.driver.run(`UPDATE schedules SET status = ?, updated_at = ? WHERE id = ?`, [status, now, id]);
    return this.requireRow(id);
  }

  private requireRow(id: string): ScheduleRecord {
    const row = this.driver.get<ScheduleRow>('SELECT * FROM schedules WHERE id = ?', [id]);
    if (!row) throw new Error(`schedule ${id} not found`);
    return mapRow(row);
  }
}
