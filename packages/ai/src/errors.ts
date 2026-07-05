/** Typed errors for `@social/ai`, so callers can branch without string-matching. */

export class AiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiConfigError';
  }
}

/** Wraps any failure talking to the underlying model API (network, 4xx/5xx, etc). */
export class AiProviderError extends Error {
  readonly retryable: boolean;
  constructor(message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AiProviderError';
    this.retryable = options.retryable ?? false;
  }
}

/** The model declined to generate (safety refusal). Not retryable with the same prompt. */
export class AiRefusalError extends Error {
  readonly category: string | null;
  constructor(message: string, category: string | null = null) {
    super(message);
    this.name = 'AiRefusalError';
    this.category = category;
  }
}
