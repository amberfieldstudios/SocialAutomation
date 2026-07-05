/**
 * Concrete `StructuredLogger` implementation for `@social/core`'s logging
 * contract. Every package in the monorepo should construct its logger through
 * `createLogger()` here rather than using `console.*` directly.
 *
 * Guarantees:
 *  - One JSON object per log line (easy to ship to any log aggregator).
 *  - `child()` produces a logger that carries forward bindings (e.g.
 *    `trace_id`, `account_id`) onto every subsequent line.
 *  - Level filtering (`trace` < `debug` < `info` < `warn` < `error`).
 *  - MANDATORY redaction: every field payload is passed through
 *    `redactFields()` before serialization, so secrets never reach the sink
 *    even if a caller accidentally logs a raw token.
 */

import type { LogFields, LogLevel, StructuredLogger } from '@social/core';
import { redactFields } from './redact';

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

export interface LoggerOptions {
  /** Minimum level that gets written; lines below it are dropped. Default 'info'. */
  level?: LogLevel;
  /** Bindings included on every line emitted by this logger (and its children). */
  bindings?: LogFields;
  /** Where serialized lines go. Default: one line to stdout. Override in tests. */
  sink?: (line: string) => void;
  /** Clock injection for testability. */
  now?: () => Date;
  /** Optional service/package name stamped on every line. */
  service?: string;
}

export class JsonStructuredLogger implements StructuredLogger {
  private readonly level: LogLevel;
  private readonly bindings: LogFields;
  private readonly sink: (line: string) => void;
  private readonly now: () => Date;
  private readonly service: string | undefined;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? 'info';
    this.bindings = options.bindings ?? {};
    this.sink = options.sink ?? defaultSink;
    this.now = options.now ?? (() => new Date());
    this.service = options.service;
  }

  child(bindings: LogFields): StructuredLogger {
    return new JsonStructuredLogger({
      level: this.level,
      bindings: { ...this.bindings, ...bindings },
      sink: this.sink,
      now: this.now,
      service: this.service,
    });
  }

  trace(message: string, fields?: LogFields): void {
    this.write('trace', message, fields);
  }

  debug(message: string, fields?: LogFields): void {
    this.write('debug', message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.write('info', message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.write('warn', message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.write('error', message, fields);
  }

  private write(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) {
      return;
    }
    const redactedFields = redactFields({ ...this.bindings, ...fields }) as LogFields;
    const line: Record<string, unknown> = {
      ...redactedFields,
      ts: this.now().toISOString(),
      level,
      message,
      ...(this.service ? { service: this.service } : {}),
    };
    this.sink(JSON.stringify(line));
  }
}

function defaultSink(line: string): void {
   
  process.stdout.write(line + '\n');
}

export function createLogger(options?: LoggerOptions): StructuredLogger {
  return new JsonStructuredLogger(options);
}
