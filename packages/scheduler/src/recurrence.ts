/**
 * Recurrence-rule occurrence generation for `mode = 'recurring'` schedules.
 *
 * `recurrence_rule` accepts EITHER:
 *  - an RFC-5545 RRULE string (e.g. `'FREQ=WEEKLY;BYDAY=MO,WE,FR'`), detected
 *    by the presence of a `FREQ=` component — evaluated with `rrule`; or
 *  - a standard 5-field cron expression (e.g. `'0 9 * * *'` — every day at
 *    09:00), evaluated with `cron-parser`.
 *
 * Both are interpreted as a LOCAL wall-clock recurrence in `timezone`, not
 * UTC — "every day at 9am America/New_York" must keep firing at 9am local
 * even across DST transitions, which is why raw `rrule`/`cron-parser` (which
 * only understand plain JS `Date`s with no real timezone concept) can't be
 * used directly: we bridge them through Luxon per-occurrence.
 *
 * `rrule` path: the DTSTART's wall-clock components are carried through
 * `rrule` as a "floating" JS `Date` (see `timezone.ts`), occurrences are
 * generated in that same floating frame, and EACH occurrence is then
 * reinterpreted as a wall-clock time in `timezone` and converted to its real
 * UTC instant individually — so a DST shift mid-series changes the UTC
 * instants' offsets without changing the local wall-clock time they represent.
 *
 * `cron-parser` path: v5's `CronExpression` accepts a `tz` option and does
 * this same local-wall-clock/DST-correct resolution internally, so no
 * floating-time bridging is needed there.
 */

import { CronExpressionParser } from 'cron-parser';
import { RRule, rrulestr } from 'rrule';
import { DateTime } from 'luxon';

import { floatingDateToZonedDateTime, zonedDateTimeToFloatingDate } from './timezone';

export class InvalidRecurrenceRuleError extends Error {
  constructor(rule: string, reason: string) {
    super(`invalid recurrence rule '${rule}': ${reason}`);
    this.name = 'InvalidRecurrenceRuleError';
  }
}

function isRRule(rule: string): boolean {
  return /(^|;)\s*FREQ=/i.test(rule);
}

/**
 * All occurrences of `rule` (RRULE or cron) that fall strictly after `after`
 * (exclusive) and at-or-before `before` (inclusive), in ascending order.
 * `dtstartLocalIso` (RRULE only) is the local wall-clock time (no offset) the
 * series' wall-clock time-of-day/day-pattern is anchored to, e.g.
 * `'2026-07-04T09:00:00'` for "9am, starting July 4th".
 */
export function occurrencesInRange(
  rule: string,
  timezone: string,
  dtstartLocalIso: string | undefined,
  after: Date,
  before: Date,
): Date[] {
  if (before < after) return [];
  return isRRule(rule)
    ? rruleOccurrencesInRange(rule, timezone, dtstartLocalIso, after, before)
    : cronOccurrencesInRange(rule, timezone, after, before);
}

/** The single next occurrence of `rule` strictly after `after`, or `null` if the rule has no more occurrences. */
export function nextOccurrence(
  rule: string,
  timezone: string,
  dtstartLocalIso: string | undefined,
  after: Date,
): Date | null {
  // A year-wide window comfortably covers annual/monthly/weekly/daily/cron
  // patterns' next hop; widen further only if a caller needs sparser rules.
  const before = new Date(after.getTime() + 366 * 24 * 60 * 60 * 1000);
  const found = occurrencesInRange(rule, timezone, dtstartLocalIso, after, before);
  return found[0] ?? null;
}

/**
 * The first occurrence of `rule` at-or-AFTER `from` (inclusive), or `null` if
 * none. Unlike `nextOccurrence` (strictly-after, used to advance past an
 * already-fired occurrence), this is inclusive — used at schedule-creation
 * time so a recurring schedule's very first `next_run_at` can legitimately be
 * its own anchor instant.
 */
export function firstOccurrenceAtOrAfter(
  rule: string,
  timezone: string,
  dtstartLocalIso: string | undefined,
  from: Date,
): Date | null {
  const before = new Date(from.getTime() + 366 * 24 * 60 * 60 * 1000);
  const inclusiveAfter = new Date(from.getTime() - 1);
  const found = occurrencesInRange(rule, timezone, dtstartLocalIso, inclusiveAfter, before);
  return found[0] ?? null;
}

function cronOccurrencesInRange(rule: string, timezone: string, after: Date, before: Date): Date[] {
  let interval;
  try {
    interval = CronExpressionParser.parse(rule, { currentDate: after, endDate: before, tz: timezone });
  } catch (err) {
    throw new InvalidRecurrenceRuleError(rule, err instanceof Error ? err.message : String(err));
  }
  const results: Date[] = [];
  while (interval.hasNext()) {
    const date = interval.next().toDate();
    if (date <= after) continue; // exclusive lower bound
    if (date > before) break;
    results.push(date);
  }
  return results;
}

function rruleOccurrencesInRange(
  rule: string,
  timezone: string,
  dtstartLocalIso: string | undefined,
  after: Date,
  before: Date,
): Date[] {
  if (!dtstartLocalIso) {
    throw new InvalidRecurrenceRuleError(rule, 'RRULE recurrence requires a dtstart local time');
  }
  const dtstartLocal = DateTime.fromISO(dtstartLocalIso, { zone: timezone });
  if (!dtstartLocal.isValid) {
    throw new InvalidRecurrenceRuleError(rule, `invalid dtstart '${dtstartLocalIso}' for zone '${timezone}'`);
  }
  const floatingDtstart = zonedDateTimeToFloatingDate(dtstartLocal);

  let parsed: RRule;
  try {
    const result = rrulestr(rule, { dtstart: floatingDtstart });
    // rrulestr can return an RRuleSet for compound rules; a bare RRULE string
    // (our documented contract) always yields a plain RRule.
    parsed = result instanceof RRule ? result : (result as unknown as RRule);
  } catch (err) {
    throw new InvalidRecurrenceRuleError(rule, err instanceof Error ? err.message : String(err));
  }

  // Pad the floating search window generously (48h) to absorb the local<->UTC
  // offset (max ~14h) plus any DST shift, then filter precisely post-conversion.
  const afterLocalFloating = zonedDateTimeToFloatingDate(
    DateTime.fromJSDate(after, { zone: 'utc' }).setZone(timezone).minus({ hours: 48 }),
  );
  const beforeLocalFloating = zonedDateTimeToFloatingDate(
    DateTime.fromJSDate(before, { zone: 'utc' }).setZone(timezone).plus({ hours: 48 }),
  );

  const floatingOccurrences = parsed.between(afterLocalFloating, beforeLocalFloating, true);

  const utcOccurrences = floatingOccurrences
    .map((floating) => floatingDateToZonedDateTime(floating, timezone).toUTC().toJSDate())
    .filter((utc) => utc > after && utc <= before)
    .sort((a, b) => a.getTime() - b.getTime());

  // De-dupe: a DST fall-back can, in principle, cause the same floating wall
  // time to map twice if the window padding straddles the ambiguous hour.
  const seen = new Set<number>();
  return utcOccurrences.filter((d) => {
    if (seen.has(d.getTime())) return false;
    seen.add(d.getTime());
    return true;
  });
}
