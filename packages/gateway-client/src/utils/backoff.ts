/**
 * Exponential backoff utilities
 */

/**
 * Calculate the next backoff delay
 *
 * @param attempt - Current attempt number (0-indexed)
 * @param initialDelay - Initial delay in milliseconds
 * @param multiplier - Multiplier for each subsequent attempt
 * @param maxDelay - Maximum delay cap in milliseconds
 * @returns Delay in milliseconds
 */
export function calculateBackoff(
  attempt: number,
  initialDelay: number,
  multiplier: number,
  maxDelay: number
): number {
  const delay = initialDelay * Math.pow(multiplier, attempt);
  return Math.min(delay, maxDelay);
}

/**
 * Calculate a sequence of backoff delays
 *
 * @param initialDelay - Initial delay in milliseconds
 * @param multiplier - Multiplier for each subsequent attempt
 * @param maxDelay - Maximum delay cap in milliseconds
 * @param count - Number of delays to generate
 * @returns Array of delays in milliseconds
 */
export function calculateBackoffSequence(
  initialDelay: number,
  multiplier: number,
  maxDelay: number,
  count: number
): number[] {
  const sequence: number[] = [];
  for (let i = 0; i < count; i++) {
    sequence.push(calculateBackoff(i, initialDelay, multiplier, maxDelay));
  }
  return sequence;
}

/**
 * Add jitter to a delay to prevent thundering herd
 *
 * @param delay - Base delay in milliseconds
 * @param jitterFactor - Jitter factor (0-1), defaults to 0.1 (10%)
 * @returns Delay with jitter applied
 */
export function addJitter(delay: number, jitterFactor: number = 0.1): number {
  const jitter = delay * jitterFactor * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(delay + jitter));
}

/**
 * Create a delay promise
 *
 * @param ms - Delay in milliseconds
 * @returns Promise that resolves after the delay
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a timeout promise that rejects after the specified time
 *
 * @param ms - Timeout in milliseconds
 * @param message - Error message
 * @returns Promise that rejects after the timeout
 */
export function timeout<T>(ms: number, message: string): Promise<T> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

/**
 * Race a promise against a timeout
 *
 * @param promise - Promise to race
 * @param ms - Timeout in milliseconds
 * @param message - Error message for timeout
 * @returns Promise that resolves with the result or rejects on timeout
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string = 'Operation timed out'
): Promise<T> {
  return Promise.race([promise, timeout<T>(ms, message)]);
}
