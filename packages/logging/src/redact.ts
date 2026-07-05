/**
 * Credential/secret redaction for structured log fields.
 *
 * MANDATORY per docs/ARCHITECTURE.md #2: credentials must never be plaintext in
 * logs. Callers are also expected to never place raw tokens in log fields in
 * the first place (see `@social/core` logging.ts), but this module is the
 * belt-and-suspenders backstop: it walks any structured field payload and
 * redacts anything that *looks* like a secret by key name or value shape,
 * regardless of how deeply nested it is.
 */

export const REDACTED = '[REDACTED]';

/** Key names (case-insensitive) treated as secret-bearing and always redacted. */
const SECRET_KEY_PATTERN =
  /(access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|authorization|auth[_-]?header|password|passwd|secret|api[_-]?key|apikey|private[_-]?key|encryption[_-]?key|cookie|set-cookie|^token$)/i;

/** Value shapes that look like a bearer/secret credential even under an innocuous key. */
const BEARER_VALUE_PATTERN = /^Bearer\s+\S+/i;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key.trim());
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string' && BEARER_VALUE_PATTERN.test(value)) {
    return REDACTED;
  }
  return value;
}

/**
 * Deep-clones `value`, replacing any secret-bearing field (by key name) or
 * bearer-token-shaped string value with `[REDACTED]`. Safe against cycles.
 */
export function redactFields<T>(value: T): T {
  return redactInternal(value, new WeakSet<object>()) as T;
}

function redactInternal(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') {
    return redactValue(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (seen.has(value)) {
    return '[CIRCULAR]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactInternal(item, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretKey(key)) {
      out[key] = REDACTED;
      continue;
    }
    if (v !== null && typeof v === 'object') {
      out[key] = redactInternal(v, seen);
    } else {
      out[key] = redactValue(v);
    }
  }
  return out;
}
