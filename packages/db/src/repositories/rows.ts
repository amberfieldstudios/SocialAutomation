/**
 * Shared row-mapping helpers between the SQL wire format (TEXT/INTEGER, JSON in
 * TEXT columns, 0/1 booleans) and the camelCase domain records that the
 * `@social/auth` and `@social/queue` ports use.
 */

import type { SqlValue } from '../driver';

/** SQLite stores JSON as TEXT. Parse a nullable JSON column. */
export function parseJson<T>(value: SqlValue | undefined, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return fallback;
  return JSON.parse(value) as T;
}

/** Parse a nullable JSON column, preserving `null`/`undefined`. */
export function parseJsonNullable<T>(value: SqlValue | undefined): T | null {
  if (value === null || value === undefined || value === '') return null;
  return JSON.parse(value as string) as T;
}

/** Serialize a value to a JSON TEXT column, or null. */
export function toJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

/** INTEGER 0/1 -> boolean. */
export function toBool(value: SqlValue | undefined): boolean {
  return value === 1 || value === '1';
}

/** Nullable TEXT column -> `string | null`. */
export function nullableText(value: SqlValue | undefined): string | null {
  return value === undefined || value === null ? null : String(value);
}

/** Nullable INTEGER column -> `number | null`. */
export function nullableInt(value: SqlValue | undefined): number | null {
  return value === undefined || value === null ? null : Number(value);
}
