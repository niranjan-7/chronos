import { calculateBackoffWithJitter } from './jitter-backoff.util';

describe('calculateBackoffWithJitter', () => {
  it('should calculate exponential delay with random jitter', () => {
    // attempt 0: base 1000 * 2^0 = 1000. Jitter between 0 and 1000. Total between 1000 and 2000.
    const delay0 = calculateBackoffWithJitter(0, 1000);
    expect(delay0).toBeGreaterThanOrEqual(1000);
    expect(delay0).toBeLessThanOrEqual(2000);

    // attempt 1: base 1000 * 2^1 = 2000. Jitter between 0 and 2000. Total between 2000 and 4000.
    const delay1 = calculateBackoffWithJitter(1, 1000);
    expect(delay1).toBeGreaterThanOrEqual(2000);
    expect(delay1).toBeLessThanOrEqual(4000);

    // attempt 2: base 1000 * 2^2 = 4000. Jitter between 0 and 4000. Total between 4000 and 8000.
    const delay2 = calculateBackoffWithJitter(2, 1000);
    expect(delay2).toBeGreaterThanOrEqual(4000);
    expect(delay2).toBeLessThanOrEqual(8000);
  });

  it('should respect maximum delay cap', () => {
    const capped = calculateBackoffWithJitter(10, 1000, 30000);
    expect(capped).toBeLessThanOrEqual(30000);
  });
});
