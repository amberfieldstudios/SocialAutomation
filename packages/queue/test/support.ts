import type { LogFields, StructuredLogger } from '@social/core';

/** A silent `StructuredLogger` for tests; swap to `consoleLogger()` locally to debug. */
export function testLogger(): StructuredLogger {
  const make = (bindings: LogFields): StructuredLogger => ({
    child: (more) => make({ ...bindings, ...more }),
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  });
  return make({});
}
