/**
 * FR-016 — bounded retry wrapper for transient `api.receive` failures.
 *
 * Policy (per spec.md FR-016):
 *   - 3 retries total.
 *   - Backoff sequence: 1000 ms, 4000 ms, 15000 ms.
 *   - Only transient errors are retried. Terminal errors (already_spent,
 *     bad_signature, RedemptionSaveError, RedemptionClaimContendedError)
 *     are NOT retried — they propagate immediately so the caller can
 *     surface the right outcome per FR-019.
 *   - When the retry budget is exhausted on a transient error, the
 *     wrapper throws `RetryExhaustedError` (caller treats this as
 *     "transient receive failure, retry budget exhausted" per FR-019 —
 *     do NOT advance the watermark; next trigger restarts the budget).
 */

/**
 * Backoff sequence in milliseconds. Index 0 is the wait BEFORE attempt 2,
 * index 1 is the wait before attempt 3, etc. Three entries = up to 3
 * retries (4 attempts total: 1 initial + 3 retries).
 */
export const TRANSIENT_RECEIVE_BACKOFFS_MS: readonly number[] = [1000, 4000, 15000];

/** Thrown when retries are exhausted on a transient error. */
export class RetryExhaustedError extends Error {
  readonly cause?: Error;
  readonly attempts: number;

  constructor(message: string, attempts: number, cause?: Error) {
    super(message);
    this.name = 'RetryExhaustedError';
    this.attempts = attempts;
    if (cause) this.cause = cause;
  }
}

/**
 * Classifier callback supplied by the caller. Returns `true` for
 * transient errors (network blip, 5xx, mint busy, etc.) and `false` for
 * terminal errors (already_spent, bad_signature, etc.).
 *
 * Centralising the classification policy in a callback keeps this helper
 * decoupled from the application's error taxonomy — the bridge in
 * `shared/dmPoll.js` supplies the real classifier.
 */
export type IsTransientReceiveError = (err: unknown) => boolean;

/**
 * Sleep callback. Defaults to setTimeout; tests pass a deterministic
 * fake-timers-friendly mock.
 */
export type SleepFn = (ms: number) => Promise<void>;

const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Options for retryOnTransientMintError. All optional except the
 * classifier (no sensible default for application-specific error
 * taxonomy).
 */
export interface RetryOptions {
  /** Required: returns true for transient errors. */
  isTransient: IsTransientReceiveError;
  /** Optional: override the backoff sequence (e.g. for tests). */
  backoffsMs?: readonly number[];
  /** Optional: override the sleep implementation. */
  sleep?: SleepFn;
  /** Optional: called once per retry with `{attempt, delayMs, error}`. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

/**
 * Run `fn` and retry on transient errors per the FR-016 policy.
 *
 * Returns the resolved value on success. Throws:
 *   - the original error (untouched) on a terminal error;
 *   - `RetryExhaustedError` when the retry budget is exhausted on a
 *     transient error.
 *
 * @example
 *   await retryOnTransientMintError(
 *     () => api.receive(token),
 *     { isTransient: (e) => isNetworkOr5xx(e) }
 *   );
 */
export async function retryOnTransientMintError<T>(
  fn: () => Promise<T>,
  opts: RetryOptions
): Promise<T> {
  const { isTransient, onRetry } = opts;
  const backoffs = opts.backoffsMs ?? TRANSIENT_RECEIVE_BACKOFFS_MS;
  const sleep = opts.sleep ?? defaultSleep;

  let lastErr: unknown = null;
  // 1 initial attempt + backoffs.length retries = backoffs.length + 1 attempts.
  for (let attempt = 1; attempt <= backoffs.length + 1; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err)) {
        // Terminal: propagate untouched.
        throw err;
      }
      // Transient: maybe retry.
      const isFinal = attempt === backoffs.length + 1;
      if (isFinal) {
        throw new RetryExhaustedError(
          `retryOnTransientMintError: ${backoffs.length} retries exhausted on transient error`,
          attempt,
          err instanceof Error ? err : undefined
        );
      }
      const delayMs = backoffs[attempt - 1];
      if (onRetry) {
        try {
          onRetry({ attempt, delayMs, error: err });
        } catch {
          /* swallow telemetry errors */
        }
      }
      await sleep(delayMs);
    }
  }
  // Unreachable — the loop either returns or throws. Defensive throw.
  throw lastErr;
}
