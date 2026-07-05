/**
 * IANA-timezone-aware local-wall-clock <-> UTC-instant conversion, via Luxon
 * (`DateTime`). Every schedule stores its user-facing time as a *local* wall
 * clock (e.g. "2026-07-04T09:00:00" in "America/New_York") plus the `timezone`
 * it's expressed in; everything persisted (`run_at`, `next_run_at`,
 * `last_run_at`) is the derived UTC instant — this module is the ONLY place
 * that conversion happens, so DST handling is centralized and testable.
 */

import { DateTime } from 'luxon';

export class InvalidLocalTimeError extends Error {
  constructor(localIso: string, timezone: string, reason: string) {
    super(`invalid local time '${localIso}' for timezone '${timezone}': ${reason}`);
    this.name = 'InvalidLocalTimeError';
  }
}

/**
 * Converts a local wall-clock time (an ISO-8601 string with NO offset, e.g.
 * `'2026-03-08T02:30:00'`) in `timezone` to the equivalent UTC instant.
 *
 * DST notes:
 *  - "Spring forward" gaps (a wall-clock time that never occurs, e.g. 2:30 AM
 *    on the US spring-forward day) are resolved by Luxon rolling forward to
 *    the next valid instant (matches most calendar-app behavior).
 *  - "Fall back" ambiguous times (occur twice) resolve to the FIRST
 *    occurrence (the offset in effect before the clocks repeat), matching
 *    Luxon's default.
 */
export function localToUtc(localIso: string, timezone: string): Date {
  const dt = DateTime.fromISO(localIso, { zone: timezone });
  if (!dt.isValid) {
    throw new InvalidLocalTimeError(localIso, timezone, dt.invalidReason ?? 'unknown');
  }
  return dt.toUTC().toJSDate();
}

/** Converts a UTC instant back to its local wall-clock ISO string in `timezone` (no offset suffix). */
export function utcToLocalIso(utc: Date, timezone: string): string {
  return DateTime.fromJSDate(utc, { zone: 'utc' }).setZone(timezone).toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

/** True if `timezone` is a recognized IANA zone name Luxon/the host ICU data can resolve. */
export function isValidTimezone(timezone: string): boolean {
  return DateTime.local().setZone(timezone).isValid;
}

/**
 * Reinterprets a JS `Date`'s UTC field values (Y/M/D/H/M/S) as a wall-clock
 * time IN `zone` — i.e. treats the `Date` as a "floating time" carrier (its
 * UTC getters hold the intended local components, with no real timezone
 * meaning yet). Used to bridge `rrule`, which only understands JS `Date`
 * objects with no timezone concept, and Luxon's real IANA-zone arithmetic.
 */
export function floatingDateToZonedDateTime(floating: Date, zone: string): DateTime {
  return DateTime.fromObject(
    {
      year: floating.getUTCFullYear(),
      month: floating.getUTCMonth() + 1,
      day: floating.getUTCDate(),
      hour: floating.getUTCHours(),
      minute: floating.getUTCMinutes(),
      second: floating.getUTCSeconds(),
      millisecond: floating.getUTCMilliseconds(),
    },
    { zone },
  );
}

/**
 * Encodes a `DateTime`'s wall-clock components (in whatever zone it's
 * currently set to) as a "floating" JS `Date` whose UTC getters carry those
 * same Y/M/D/H/M/S values, with no timezone meaning attached. Inverse of
 * `floatingDateToZonedDateTime`.
 */
export function zonedDateTimeToFloatingDate(dt: DateTime): Date {
  return new Date(Date.UTC(dt.year, dt.month - 1, dt.day, dt.hour, dt.minute, dt.second, dt.millisecond));
}
