/**
 * Retry helper — exponential backoff with jitter.
 *
 * Wraps async operations with configurable retry logic.
 * Used by workers for WebView operations and API calls.
 */

interface RetryOptions {
  /** Max attempts (including the first). Default: 3. */
  maxAttempts?: number;
  /** Base delay in ms. Default: 1000. */
  baseDelayMs?: number;
  /** Max delay cap in ms. Default: 30000. */
  maxDelayMs?: number;
  /** Jitter factor (0-1). Default: 0.1. */
  jitter?: number;
  /** Predicate to decide if an error is retryable. Default: all errors. */
  retryable?: (err: unknown) => boolean;
  /** Called before each retry with attempt number and delay. */
  onRetry?: (attempt: number, delay: number, err: unknown) => void;
}

function computeDelay(attempt: number, base: number, max: number, jitter: number): number {
  const exp = base * 2 ** (attempt - 1);
  const capped = Math.min(exp, max);
  const jitterAmount = capped * jitter * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(capped + jitterAmount));
}

/**
 * Run an async function with retry + exponential backoff.
 *
 * @example
 * const result = await withRetry(() => fetch("https://api.example.com/data"), {
 *   maxAttempts: 3,
 *   retryable: (e) => e instanceof TypeError, // network errors only
 * });
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const maxDelayMs = opts.maxDelayMs ?? 30000;
  const jitter = opts.jitter ?? 0.1;
  const retryable = opts.retryable ?? (() => true);

  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts || !retryable(err)) {
        throw err;
      }
      const delay = computeDelay(attempt, baseDelayMs, maxDelayMs, jitter);
      opts.onRetry?.(attempt, delay, err);
      // I4: Use Bun.sleep (native) instead of a setTimeout wrapper.
      // Ref: node_modules/bun-types/bun.d.ts — Bun.sleep(ms: number | Date): Promise<void>
      await Bun.sleep(delay);
    }
  }

  // I5: Guard against maxAttempts=0 (loop body never runs, lastErr is undefined)
  throw lastErr ?? new Error(`withRetry: maxAttempts=${maxAttempts} prevented any attempts`);
}
