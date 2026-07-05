/**
 * Builds the in-memory `OperationContext` handed to a connector (docs/AUTH.md
 * §6). The decrypted `TokenSet` lives ONLY inside this object for the duration
 * of a call — it is never persisted and never logged.
 */

import type { AppCredentials, OperationContext, StructuredLogger, TokenSet } from '@social/core';

export function buildOperationContext(params: {
  token: TokenSet;
  /** Contract v1.1: the developer app credentials this account was connected under. */
  app: AppCredentials;
  accountId: string;
  logger: StructuredLogger;
  deadlineMs?: number;
}): OperationContext {
  return {
    token: params.token,
    app: params.app,
    accountId: params.accountId,
    logger: params.logger,
    ...(params.deadlineMs !== undefined ? { deadlineMs: params.deadlineMs } : {}),
  };
}
