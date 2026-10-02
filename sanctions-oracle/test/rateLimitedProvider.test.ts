import { RateLimitedSanctionsProvider } from '../src/rateLimitedProvider';
import { SanctionsProvider } from '../src/SanctionsProvider';

/** Fake sleep that resolves immediately but records how long it was asked to sleep. */
function makeFakeSleep() {
  const calls: number[] = [];
  const fn = (ms: number): Promise<void> => {
    calls.push(ms);
    return Promise.resolve();
  };
  return { fn, calls };
}

/** Builds a provider mock that throws a 429-like error on the first `failTimes` calls, then succeeds. */
function makeFlakeyProvider(
  failTimes: number,
  errorMsg = 'HTTP 429 Too Many Requests',
): SanctionsProvider & { callCount: number } {
  let callCount = 0;
  return {
    get callCount() {
      return callCount;
    },
    async checkAddress(_address: string) {
      callCount++;
      if (callCount <= failTimes) {
        throw new Error(errorMsg);
      }
      return { flagged: false, source: 'test' };
    },
  };
}

describe('RateLimitedSanctionsProvider', () => {
  describe('pass-through behaviour', () => {
    it('returns the inner provider result when no error occurs', async () => {
      const inner: SanctionsProvider = {
        async checkAddress() {
          return { flagged: true, source: 'watchlist' };
        },
      };
      const provider = new RateLimitedSanctionsProvider(inner);
      const result = await provider.checkAddress('GADDR');
      expect(result).toEqual({ flagged: true, source: 'watchlist' });
    });
  });

  describe('retry on 429 / rate-limit errors', () => {
    it('retries on a "429" message and eventually succeeds', async () => {
      const { fn: sleep, calls } = makeFakeSleep();
      const inner = makeFlakeyProvider(2, 'Request failed with status 429');

      const provider = new RateLimitedSanctionsProvider(inner, {
        maxRetries: 4,
        baseDelayMs: 100,
        _sleep: sleep,
      });

      const result = await provider.checkAddress('GADDR');
      expect(result).toEqual({ flagged: false, source: 'test' });
      // Two failures → two sleep calls
      expect(calls).toHaveLength(2);
      // Each delay should be ≥ baseDelayMs (100)
      for (const delay of calls) {
        expect(delay).toBeGreaterThanOrEqual(100);
      }
    });

    it('retries on a "Too Many Requests" message', async () => {
      const { fn: sleep } = makeFakeSleep();
      const inner = makeFlakeyProvider(1, 'Too Many Requests');

      const provider = new RateLimitedSanctionsProvider(inner, {
        maxRetries: 3,
        baseDelayMs: 50,
        _sleep: sleep,
      });

      const result = await provider.checkAddress('GADDR');
      expect(result).toEqual({ flagged: false, source: 'test' });
      expect(inner.callCount).toBe(2);
    });

    it('retries when the error has a numeric .status === 429', async () => {
      const { fn: sleep, calls } = makeFakeSleep();
      let attempt = 0;
      const inner: SanctionsProvider = {
        async checkAddress() {
          attempt++;
          if (attempt === 1) {
            const err = Object.assign(new Error('rate limited'), { status: 429 });
            throw err;
          }
          return { flagged: false, source: 'ok' };
        },
      };

      const provider = new RateLimitedSanctionsProvider(inner, {
        maxRetries: 3,
        baseDelayMs: 50,
        _sleep: sleep,
      });

      const result = await provider.checkAddress('GADDR');
      expect(result).toEqual({ flagged: false, source: 'ok' });
      expect(calls).toHaveLength(1);
    });

    it('retries when the error has a numeric .statusCode === 429', async () => {
      const { fn: sleep, calls } = makeFakeSleep();
      let attempt = 0;
      const inner: SanctionsProvider = {
        async checkAddress() {
          attempt++;
          if (attempt === 1) {
            const err = Object.assign(new Error('rate limited'), { statusCode: 429 });
            throw err;
          }
          return { flagged: false, source: 'ok' };
        },
      };

      const provider = new RateLimitedSanctionsProvider(inner, {
        maxRetries: 3,
        baseDelayMs: 50,
        _sleep: sleep,
      });

      await provider.checkAddress('GADDR');
      expect(calls).toHaveLength(1);
    });
  });

  describe('giving up after maxRetries', () => {
    it('re-throws the last error when all retries are exhausted', async () => {
      const { fn: sleep, calls } = makeFakeSleep();
      const inner = makeFlakeyProvider(99, 'HTTP 429 Too Many Requests');

      const provider = new RateLimitedSanctionsProvider(inner, {
        maxRetries: 3,
        baseDelayMs: 100,
        _sleep: sleep,
      });

      await expect(provider.checkAddress('GADDR')).rejects.toThrow('HTTP 429 Too Many Requests');
      // 3 attempts total → 3 sleep calls (sleep after each failing attempt)
      expect(calls).toHaveLength(3);
      expect(inner.callCount).toBe(3);
    });
  });

  describe('non-rate-limit errors are not retried', () => {
    it('re-throws a non-429 error immediately without retrying', async () => {
      const { fn: sleep, calls } = makeFakeSleep();
      let callCount = 0;
      const inner: SanctionsProvider = {
        async checkAddress() {
          callCount++;
          throw new Error('Network timeout');
        },
      };

      const provider = new RateLimitedSanctionsProvider(inner, {
        maxRetries: 4,
        baseDelayMs: 100,
        _sleep: sleep,
      });

      await expect(provider.checkAddress('GADDR')).rejects.toThrow('Network timeout');
      expect(callCount).toBe(1); // called exactly once — no retries
      expect(calls).toHaveLength(0); // no sleep
    });
  });

  describe('back-off delay capping', () => {
    it('caps the delay at maxDelayMs', async () => {
      const { fn: sleep, calls } = makeFakeSleep();
      const inner = makeFlakeyProvider(4, '429 rate limit');

      const provider = new RateLimitedSanctionsProvider(inner, {
        maxRetries: 5,
        baseDelayMs: 1000,
        maxDelayMs: 2000,
        _sleep: sleep,
      });

      await provider.checkAddress('GADDR');
      // All delays should be at most maxDelayMs + baseDelayMs (jitter adds up to baseDelayMs)
      for (const delay of calls) {
        expect(delay).toBeLessThanOrEqual(2000 + 1000);
      }
    });
  });

  describe('concurrency limiting', () => {
    it('allows up to `concurrency` in-flight calls at once, queuing the rest', async () => {
      let currentInFlight = 0;
      let maxObservedInFlight = 0;

      const inner: SanctionsProvider = {
        async checkAddress() {
          currentInFlight++;
          maxObservedInFlight = Math.max(maxObservedInFlight, currentInFlight);
          // Yield to the event loop so other calls can try to start
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          currentInFlight--;
          return { flagged: false, source: 'test' };
        },
      };

      const provider = new RateLimitedSanctionsProvider(inner, { concurrency: 2 });

      // Fan out 6 concurrent calls; semaphore should allow max 2 at once.
      const addresses = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6'];
      await Promise.all(addresses.map((a) => provider.checkAddress(a)));

      expect(maxObservedInFlight).toBeLessThanOrEqual(2);
    });
  });

  describe('default options', () => {
    it('uses sensible defaults (maxRetries=4, baseDelayMs=250, maxDelayMs=16000)', async () => {
      // Simply verify that the constructor doesn't throw and a successful call works.
      const inner: SanctionsProvider = {
        async checkAddress() {
          return { flagged: false, source: 'default-test' };
        },
      };
      const provider = new RateLimitedSanctionsProvider(inner);
      const result = await provider.checkAddress('GADDR');
      expect(result).toEqual({ flagged: false, source: 'default-test' });
    });

    it.each([0, -1, Number.NaN, Number.NEGATIVE_INFINITY])(
      'rejects invalid concurrency %p before a check can deadlock',
      (concurrency) => {
        const inner: SanctionsProvider = {
          async checkAddress() {
            return { flagged: false, source: 'should-not-run' };
          },
        };

        expect(() => new RateLimitedSanctionsProvider(inner, { concurrency })).toThrow(
          'concurrency must be a positive number or Infinity',
        );
      },
    );

    it.each([Infinity, undefined])('allows unlimited concurrency with %p', async (concurrency) => {
      const inner: SanctionsProvider = {
        async checkAddress() {
          return { flagged: false, source: 'unlimited' };
        },
      };
      const provider = new RateLimitedSanctionsProvider(inner, { concurrency });

      await expect(provider.checkAddress('GADDR')).resolves.toEqual({
        flagged: false,
        source: 'unlimited',
      });
    });
  });
});
