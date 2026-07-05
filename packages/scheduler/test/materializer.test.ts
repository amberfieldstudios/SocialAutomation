/**
 * Integration tests for `ScheduleMaterializer` against a real (in-memory)
 * `@social/db` SQLite database — proving persistence, not just in-memory
 * logic. `submit` is an injected fake port (never touches the real
 * `@social/pipeline`), per the task's "inject a submit function/port" design.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '@social/logging';
import { Database } from '@social/db';

import { ScheduleMaterializer } from '../src/materializer';
import { ScheduleService } from '../src/schedule-service';
import type { ScheduleSubmitFn, ScheduleSubmitInput, ScheduleSubmitResult } from '../src/types';

function seedPost(db: Database, id: string): void {
  const now = new Date().toISOString();
  db.raw().run('INSERT INTO posts (id, brief, created_at, updated_at) VALUES (?, ?, ?, ?)', [
    id,
    'a test brief',
    now,
    now,
  ]);
}

describe('ScheduleMaterializer', () => {
  let db: Database;
  const logger = createLogger({ sink: () => {} }); // silent in tests
  let submitCalls: ScheduleSubmitInput[];
  let submit: ScheduleSubmitFn;

  beforeEach(() => {
    db = Database.sqlite({ filename: ':memory:' });
    db.migrate();
    seedPost(db, 'post_1');
    submitCalls = [];
    submit = async (input: ScheduleSubmitInput): Promise<ScheduleSubmitResult> => {
      submitCalls.push(input);
      return { postVariantId: `pv_${submitCalls.length}`, jobId: `job_${submitCalls.length}` };
    };
  });

  afterEach(() => {
    db.close();
  });

  it('a one-shot scheduled post does NOT materialize before its instant, and materializes exactly at/after it', async () => {
    const service = new ScheduleService({ schedules: db.schedules, logger });
    const schedule = service.scheduleOnce({
      postId: 'post_1',
      localDateTime: '2026-07-04T09:00:00',
      timezone: 'UTC',
    });
    expect(schedule.runAt).toBe('2026-07-04T09:00:00.000Z');
    expect(schedule.nextRunAt).toBe('2026-07-04T09:00:00.000Z');

    const materializer = new ScheduleMaterializer({ schedules: db.schedules, submit, logger });

    // Before the instant: nothing due.
    const before = await materializer.materializeDue(new Date('2026-07-04T08:59:59.000Z'));
    expect(before).toEqual([]);
    expect(submitCalls.length).toBe(0);

    // Exactly at the instant: materializes.
    const at = await materializer.materializeDue(new Date('2026-07-04T09:00:00.000Z'));
    expect(at.length).toBe(1);
    expect(at[0]?.outcome).toBe('submitted');
    expect(submitCalls.length).toBe(1);
    expect(submitCalls[0]?.occurrenceAt.toISOString()).toBe('2026-07-04T09:00:00.000Z');
    expect(submitCalls[0]?.occurrenceKey).toBe('2026-07-04T09:00:00.000Z');

    // One-shot: now completed, never fires again.
    const after = db.schedules.get(schedule.id)!;
    expect(after.status).toBe('completed');
    expect(after.nextRunAt).toBeNull();
    expect(after.lastRunAt).toBe('2026-07-04T09:00:00.000Z');

    const later = await materializer.materializeDue(new Date('2026-08-01T00:00:00.000Z'));
    expect(later).toEqual([]);
    expect(submitCalls.length).toBe(1);
  });

  it('an immediate schedule materializes on the very next sweep', async () => {
    const service = new ScheduleService({ schedules: db.schedules, logger, now: () => new Date('2026-07-04T00:00:00.000Z') });
    service.scheduleImmediate({ postId: 'post_1' });

    const materializer = new ScheduleMaterializer({ schedules: db.schedules, submit, logger });
    const outcomes = await materializer.materializeDue(new Date('2026-07-04T00:00:01.000Z'));
    expect(outcomes.length).toBe(1);
    expect(outcomes[0]?.outcome).toBe('submitted');
  });

  it('a recurring FREQ=DAILY rule produces one occurrence per sweep at the right UTC instants', async () => {
    const service = new ScheduleService({ schedules: db.schedules, logger });
    const schedule = service.scheduleRecurring({
      postId: 'post_1',
      startLocalDateTime: '2026-07-04T09:00:00',
      timezone: 'UTC',
      recurrenceRule: 'FREQ=DAILY',
    });
    expect(schedule.nextRunAt).toBe('2026-07-04T09:00:00.000Z');

    const materializer = new ScheduleMaterializer({ schedules: db.schedules, submit, logger });

    const day1 = await materializer.materializeDue(new Date('2026-07-04T09:00:00.000Z'));
    expect(day1.length).toBe(1);
    expect(day1[0]?.occurrenceAt).toBe('2026-07-04T09:00:00.000Z');

    // Not due mid-day.
    const midDay = await materializer.materializeDue(new Date('2026-07-04T20:00:00.000Z'));
    expect(midDay).toEqual([]);

    const day2 = await materializer.materializeDue(new Date('2026-07-05T09:00:00.000Z'));
    expect(day2.length).toBe(1);
    expect(day2[0]?.occurrenceAt).toBe('2026-07-05T09:00:00.000Z');

    const day3 = await materializer.materializeDue(new Date('2026-07-06T09:00:00.000Z'));
    expect(day3.length).toBe(1);
    expect(day3[0]?.occurrenceAt).toBe('2026-07-06T09:00:00.000Z');

    expect(submitCalls.map((c) => c.occurrenceKey)).toEqual([
      '2026-07-04T09:00:00.000Z',
      '2026-07-05T09:00:00.000Z',
      '2026-07-06T09:00:00.000Z',
    ]);

    const record = db.schedules.get(schedule.id)!;
    expect(record.status).toBe('active');
    expect(record.nextRunAt).toBe('2026-07-07T09:00:00.000Z');
  });

  it('a recurring rule anchored in a DST-observing zone keeps firing at the same local wall-clock time across the DST boundary', async () => {
    const service = new ScheduleService({ schedules: db.schedules, logger });
    service.scheduleRecurring({
      postId: 'post_1',
      startLocalDateTime: '2026-03-06T09:00:00', // a Friday, before the US spring-forward (Mar 8)
      timezone: 'America/New_York',
      recurrenceRule: 'FREQ=DAILY',
    });

    const materializer = new ScheduleMaterializer({ schedules: db.schedules, submit, logger });

    // Fri Mar 6, 9am EST = 14:00Z.
    await materializer.materializeDue(new Date('2026-03-06T14:00:00.000Z'));
    // Sat Mar 7, 9am EST = 14:00Z.
    await materializer.materializeDue(new Date('2026-03-07T14:00:00.000Z'));
    // Sun Mar 8 (DST begins at 2am): 9am is now EDT = 13:00Z, NOT 14:00Z.
    await materializer.materializeDue(new Date('2026-03-08T13:00:00.000Z'));
    // Mon Mar 9, 9am EDT = 13:00Z.
    await materializer.materializeDue(new Date('2026-03-09T13:00:00.000Z'));

    expect(submitCalls.map((c) => c.occurrenceKey)).toEqual([
      '2026-03-06T14:00:00.000Z',
      '2026-03-07T14:00:00.000Z',
      '2026-03-08T13:00:00.000Z',
      '2026-03-09T13:00:00.000Z',
    ]);
  });

  it('re-running the materializer over the same window does NOT double-submit (sequential re-scan)', async () => {
    const service = new ScheduleService({ schedules: db.schedules, logger });
    service.scheduleOnce({ postId: 'post_1', localDateTime: '2026-07-04T09:00:00', timezone: 'UTC' });

    const materializer = new ScheduleMaterializer({ schedules: db.schedules, submit, logger });
    const at = new Date('2026-07-04T09:00:00.000Z');

    const first = await materializer.materializeDue(at);
    const second = await materializer.materializeDue(at); // re-scan of the identical window

    expect(first.length).toBe(1);
    expect(first[0]?.outcome).toBe('submitted');
    expect(second).toEqual([]); // schedule is no longer due (already completed)
    expect(submitCalls.length).toBe(1);
  });

  it('re-running the materializer does NOT double-submit even when two sweeps race on the SAME stale read (overlapping scans)', async () => {
    const service = new ScheduleService({ schedules: db.schedules, logger });
    const schedule = service.scheduleOnce({
      postId: 'post_1',
      localDateTime: '2026-07-04T09:00:00',
      timezone: 'UTC',
    });
    const occurrenceAtIso = schedule.nextRunAt!;

    // Simulate two overlapping sweeps that both read the schedule as due
    // BEFORE either has claimed it (the race the CAS in `claimOccurrence`
    // exists to prevent) by issuing the claim call twice with the identical
    // `expectedNextRunAt` both readers observed.
    const claim1 = db.schedules.claimOccurrence(schedule.id, occurrenceAtIso, occurrenceAtIso, null);
    const claim2 = db.schedules.claimOccurrence(schedule.id, occurrenceAtIso, occurrenceAtIso, null);

    expect(claim1.claimed).toBe(true);
    expect(claim2.claimed).toBe(false); // lost the race — must not also submit

    // Only the winner's materializer call would go on to call `submit()`.
    const materializer = new ScheduleMaterializer({ schedules: db.schedules, submit, logger });
    // A subsequent sweep sees nothing due — the occurrence was already consumed.
    const after = await materializer.materializeDue(new Date('2026-07-04T09:00:00.000Z'));
    expect(after).toEqual([]);
    expect(submitCalls.length).toBe(0); // neither claim call itself submits; this proves no double-claim, hence no double-submit path
  });

  it('reports a submit failure without crashing the sweep or losing the claimed occurrence', async () => {
    const service = new ScheduleService({ schedules: db.schedules, logger });
    service.scheduleOnce({ postId: 'post_1', localDateTime: '2026-07-04T09:00:00', timezone: 'UTC' });

    const failingSubmit: ScheduleSubmitFn = async () => {
      throw new Error('pipeline unavailable');
    };
    const materializer = new ScheduleMaterializer({ schedules: db.schedules, submit: failingSubmit, logger });

    const outcomes = await materializer.materializeDue(new Date('2026-07-04T09:00:00.000Z'));
    expect(outcomes.length).toBe(1);
    expect(outcomes[0]?.outcome).toBe('submit_failed');
    expect(outcomes[0]?.error).toBe('pipeline unavailable');
  });
});
