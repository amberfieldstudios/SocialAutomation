import { describe, expect, it } from 'vitest';
import { InvalidLocalTimeError, isValidTimezone, localToUtc, utcToLocalIso } from '../src/timezone';

describe('timezone: local <-> UTC conversion', () => {
  it('converts a plain local time in a fixed-offset-adjacent zone to UTC', () => {
    // Africa/Johannesburg is UTC+2 year-round (no DST).
    const utc = localToUtc('2026-07-04T09:00:00', 'Africa/Johannesburg');
    expect(utc.toISOString()).toBe('2026-07-04T07:00:00.000Z');
  });

  it('round-trips local -> UTC -> local', () => {
    const utc = localToUtc('2026-01-15T14:30:00', 'America/New_York');
    const back = utcToLocalIso(utc, 'America/New_York');
    expect(back).toBe('2026-01-15T14:30:00');
  });

  it('DST boundary: US spring-forward (2026-03-08) — 9am EST/EDT before/after the gap convert to different UTC offsets', () => {
    // Before the US 2026 spring-forward (Mar 8, 2:00 AM -> 3:00 AM, EST -05:00 -> EDT -04:00):
    const beforeDst = localToUtc('2026-03-01T09:00:00', 'America/New_York'); // EST, UTC-5
    expect(beforeDst.toISOString()).toBe('2026-03-01T14:00:00.000Z');

    // After the spring-forward, the same local 9am is now EDT, UTC-4 — a
    // DIFFERENT UTC instant for the identical wall-clock time, proving the
    // conversion is DST-aware rather than a fixed offset.
    const afterDst = localToUtc('2026-03-09T09:00:00', 'America/New_York'); // EDT, UTC-4
    expect(afterDst.toISOString()).toBe('2026-03-09T13:00:00.000Z');
  });

  it('DST boundary: a wall-clock time inside the US spring-forward gap (nonexistent) resolves without throwing', () => {
    // 2026-03-08 02:30 local does not exist (clocks jump 2:00 -> 3:00). Luxon
    // rolls it forward to the first valid instant after the gap.
    const utc = localToUtc('2026-03-08T02:30:00', 'America/New_York');
    expect(Number.isNaN(utc.getTime())).toBe(false);
  });

  it('DST boundary: US fall-back (2026-11-01) — 1:30am is ambiguous but still resolves to a valid instant', () => {
    const utc = localToUtc('2026-11-01T01:30:00', 'America/New_York');
    expect(Number.isNaN(utc.getTime())).toBe(false);
  });

  it('throws InvalidLocalTimeError for an unrecognized timezone', () => {
    expect(() => localToUtc('2026-07-04T09:00:00', 'Not/AZone')).toThrow(InvalidLocalTimeError);
  });

  it('isValidTimezone', () => {
    expect(isValidTimezone('America/New_York')).toBe(true);
    expect(isValidTimezone('Africa/Johannesburg')).toBe(true);
    expect(isValidTimezone('Not/AZone')).toBe(false);
  });
});
