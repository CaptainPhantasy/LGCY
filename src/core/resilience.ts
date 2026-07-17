/**
 * Resilience primitives — retry with exponential backoff and optional jitter.
 * Lives in core (zero dependencies) so the gateway relay and any service can
 * wrap fallible async work uniformly. The sleep function is injectable so
 * tests run without real delays.
 */

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Add ±25% random jitter to each delay (recommended for fan-out callers). */
  jitter?: boolean;
  /** Decide whether an error warrants another attempt; defaults to always-retry. */
  isRetryable?: (error: unknown, attempt: number) => boolean;
  /** Injectable sleeper; defaults to a real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Observability hook fired before each backoff sleep. */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

export interface BackoffInfo {
  attempt: number;
  delayMs: number;
}

/** Pure delay computation for a given attempt (1-indexed). */
export function backoffDelay(opts: Pick<RetryOptions, "baseDelayMs" | "maxDelayMs" | "jitter">, attempt: number): number {
  const exp = opts.baseDelayMs * Math.pow(2, attempt - 1);
  const capped = Math.min(opts.maxDelayMs, exp);
  if (!opts.jitter) return capped;
  // Equal jitter: half fixed + half random.
  const half = capped / 2;
  return Math.floor(half + Math.random() * half);
}

export class MaxAttemptsExceededError extends Error {
  readonly lastError: unknown;
  readonly attempts: number;
  constructor(lastError: unknown, attempts: number) {
    super(`gave up after ${attempts} attempt(s)`);
    this.name = "MaxAttemptsExceededError";
    this.lastError = lastError;
    this.attempts = attempts;
  }
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  if (opts.maxAttempts < 1) throw new Error("maxAttempts must be >= 1");
  const sleep = opts.sleep ?? realSleep;
  const isRetryable = opts.isRetryable ?? (() => true);
  let lastError: unknown;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= opts.maxAttempts) break;
      if (!isRetryable(error, attempt)) break;
      const delayMs = backoffDelay(opts, attempt);
      opts.onRetry?.(error, attempt, delayMs);
      await sleep(delayMs);
    }
  }
  throw new MaxAttemptsExceededError(lastError, opts.maxAttempts);
}
