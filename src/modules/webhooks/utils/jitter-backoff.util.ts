/**
 * Calculates exponential backoff delay with full jitter:
 * delay = base * 2^attempt + random_jitter
 * where random_jitter is between 0 and base * 2^attempt.
 */
export function calculateBackoffWithJitter(
  attempt: number,
  baseMs: number = 1000,
  maxDelayMs: number = 60000,
): number {
  const boundedAttempt = Math.max(0, Math.min(attempt, 10));
  const exponential = baseMs * Math.pow(2, boundedAttempt);
  const jitter = Math.floor(Math.random() * exponential);
  const total = exponential + jitter;
  return Math.min(total, maxDelayMs);
}
