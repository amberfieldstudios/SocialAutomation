/**
 * @social/logging — the concrete `StructuredLogger` implementation for the
 * shape declared in `@social/core`'s `logging.ts`. Every other package should
 * depend on this (not reimplement logging) so log lines are uniform and
 * redaction is applied everywhere.
 */

export * from './redact';
export * from './logger';
