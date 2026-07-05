import { describe, expect, it } from 'vitest';
import { firstOccurrenceAtOrAfter, InvalidRecurrenceRuleError, nextOccurrence, occurrencesInRange } from '../src/recurrence';

describe('recurrence: RRULE occurrences', () => {
  it('produces the right daily occurrence instants, including across the US spring-forward DST boundary', () => {
    // "Every day at 9am America/New_York", starting 2026-03-01.
    const occs = occurrencesInRange(
      'FREQ=DAILY',
      'America/New_York',
      '2026-03-01T09:00:00',
      new Date('2026-02-28T00:00:00.000Z'),
      new Date('2026-03-10T00:00:00.000Z'),
    );
    const iso = occs.map((d) => d.toISOString());

    // Before DST (EST, UTC-5): 9am local = 14:00Z.
    expect(iso).toContain('2026-03-01T14:00:00.000Z');
    expect(iso).toContain('2026-03-07T14:00:00.000Z'); // last EST day
    // After DST (EDT, UTC-4): 9am local = 13:00Z — same wall-clock time, DIFFERENT UTC instant.
    expect(iso).toContain('2026-03-08T13:00:00.000Z'); // the spring-forward day itself
    expect(iso).toContain('2026-03-09T13:00:00.000Z');

    // Strictly increasing, one per day, none skipped/duplicated across the boundary.
    // Range is [2026-02-28T00:00Z, 2026-03-10T00:00Z]; Mar 10's 13:00Z occurrence
    // falls after the upper bound, so this covers Mar 1 .. Mar 9 inclusive (9 days).
    expect(occs.length).toBe(9);
    for (let i = 1; i < occs.length; i++) {
      expect(occs[i]!.getTime()).toBeGreaterThan(occs[i - 1]!.getTime());
    }
  });

  it('weekly BYDAY rule produces only the matching weekdays', () => {
    const occs = occurrencesInRange(
      'FREQ=WEEKLY;BYDAY=MO,WE,FR',
      'UTC',
      '2026-07-06T10:00:00', // a Monday
      new Date('2026-07-06T00:00:00.000Z'),
      new Date('2026-07-20T00:00:00.000Z'),
    );
    const weekdays = occs.map((d) => d.getUTCDay()); // 0=Sun..6=Sat
    expect(weekdays).toEqual([1, 3, 5, 1, 3, 5]); // Mon, Wed, Fri x2 weeks
  });

  it('nextOccurrence returns the first occurrence strictly after the given instant', () => {
    const anchor = new Date('2026-07-04T13:00:00.000Z'); // 9am America/New_York, EDT
    const next = nextOccurrence('FREQ=DAILY', 'America/New_York', '2026-07-04T09:00:00', anchor);
    expect(next?.toISOString()).toBe('2026-07-05T13:00:00.000Z');
  });

  it('firstOccurrenceAtOrAfter is inclusive of the anchor instant itself', () => {
    const anchor = new Date('2026-07-04T13:00:00.000Z');
    const first = firstOccurrenceAtOrAfter('FREQ=DAILY', 'America/New_York', '2026-07-04T09:00:00', anchor);
    expect(first?.toISOString()).toBe(anchor.toISOString());
  });

  it('a bounded rule (COUNT) eventually yields no more occurrences', () => {
    const next = nextOccurrence(
      'FREQ=DAILY;COUNT=2',
      'UTC',
      '2026-07-04T09:00:00',
      new Date('2026-07-06T00:00:00.000Z'),
    );
    expect(next).toBeNull();
  });
});

describe('recurrence: cron occurrences', () => {
  it('produces the right daily 9am occurrences across the DST boundary via native cron-parser tz support', () => {
    const occs = occurrencesInRange(
      '0 9 * * *',
      'America/New_York',
      undefined,
      new Date('2026-02-28T00:00:00.000Z'),
      new Date('2026-03-10T00:00:00.000Z'),
    );
    const iso = occs.map((d) => d.toISOString());
    expect(iso).toContain('2026-03-01T14:00:00.000Z');
    expect(iso).toContain('2026-03-09T13:00:00.000Z');
    // Unlike the RRULE case (anchored to a Mar 1 dtstart), a bare cron rule has
    // no anchor — it also matches Feb 28 (the day before the window's nominal
    // start), so the [2026-02-28T00:00Z, 2026-03-10T00:00Z) window covers 10 days.
    expect(occs.length).toBe(10);
  });

  it('nextOccurrence works for cron rules too', () => {
    const next = nextOccurrence('0 9 * * *', 'UTC', undefined, new Date('2026-07-04T09:00:00.000Z'));
    expect(next?.toISOString()).toBe('2026-07-05T09:00:00.000Z');
  });
});

describe('recurrence: error handling', () => {
  it('throws InvalidRecurrenceRuleError for a garbage rule', () => {
    expect(() => occurrencesInRange('not a rule', 'UTC', undefined, new Date(), new Date(Date.now() + 1000))).toThrow(
      InvalidRecurrenceRuleError,
    );
  });

  it('throws InvalidRecurrenceRuleError for an RRULE with no dtstart supplied', () => {
    expect(() =>
      occurrencesInRange('FREQ=DAILY', 'UTC', undefined, new Date(), new Date(Date.now() + 1000)),
    ).toThrow(InvalidRecurrenceRuleError);
  });
});
