/**
 * Structured logging contract.
 *
 * Every package in the monorepo logs through this interface — never `console.*`
 * directly — so that all log lines are structured (JSON), correlatable, and
 * secret-redacting. The concrete implementation lives in `@social/logging`
 * (owned by the analytics-logging worker); `@social/core` only defines the shape
 * so the connector contract can depend on it without a runtime dependency.
 *
 * SECURITY: implementations MUST redact credential-bearing fields (accessToken,
 * refreshToken, clientSecret, authorization headers). Contract callers MUST NOT
 * pass raw tokens into log fields in the first place.
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

/** Arbitrary structured context attached to a log line. */
export interface LogFields {
  [key: string]: unknown;
}

export interface StructuredLogger {
  /** Returns a logger that includes `bindings` on every subsequent line. */
  child(bindings: LogFields): StructuredLogger;
  trace(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}
