/**
 * Copyright (c) 2026 stellar-compliance-kit
 * SPDX-License-Identifier: MIT
 */

/**
 * @file rateLimitedProvider.ts
 *
 * Reference wrapper that adds exponential-backoff retry logic and optional
 * concurrency limiting to any {@link SanctionsProvider} implementation.
 *
 * ## Why this exists
 *
 * Real watchlist APIs (e.g. Chainalysis, Elliptic, TRM Labs) enforce per-key
 * rate limits and return HTTP 429 responses when those limits are exceeded.
 * `syncSanctionsToDenylist` calls `provider.checkAddress()` sequentially for
 * every address in the input list, so without back-off a large batch will
 * hammer the upstream API and either get throttled or have its key revoked.
 *
 * Rather than asking every consumer of `SanctionsProvider` to reinvent this
 * logic, `RateLimitedSanctionsProvider` wraps an existing provider and handles
 * 429s transparently via truncated exponential back-off with jitter.  The
 * wrapped provider never needs to know it is being rate-limited.
 *
 * ## Usage
 *
 * ```ts
 * import { RateLimitedSanctionsProvider } from 'sanctions-oracle';
 * import { MyRestProvider }                from './myRestProvider';
 *
 * const provider = new RateLimitedSanctionsProvider(new MyRestProvider(), {
 *   maxRetries:      5,       // give up after 5 attempts (default: 4)
 *   baseDelayMs:     500,     // first back-off window in ms (default: 250)
 *   maxDelayMs:      30_000,  // cap individual delay at 30 s  (default: 16 000)
 *   concurrency:     3,       // at most 3 in-flight requests  (default: unlimited)
 * });
 *
 * await syncSanctionsToDenylist({ provider, addresses, writer });
 * ```
 *
 * ## Back-off formula
 *
 * ```
 * delay = min(baseDelayMs × 2^attempt, maxDelayMs) + random jitter [0, baseDelayMs)
 * ```
 *
 * Jitter prevents a thundering-herd effect when many addresses are retried
 * simultaneously after a shared 429 window.
 *
 * ## Handling persistent errors
 *
 * After `maxRetries` attempts the wrapper re-throws the last error so the
 * caller can decide whether to fail closed (flag the address anyway) or skip
 * it.  `syncSanctionsToDenylist` will propagate that error up to its caller.
 *
 * ## Note on concurrency
 *
 * The current `syncSanctionsToDenylist` implementation is sequential
 * (`for … await`), so setting `concurrency` here has no effect on throughput
 * when used through that function.  The option is provided as a building block
 * for consumers who call `checkAddress` directly in a `Promise.all` fan-out —
 * in that scenario the semaphore prevents opening more than `concurrency`
 * connections at once, which is the correct place to enforce the limit.
 */

import { SanctionsProvider } from './SanctionsProvider';

/** Options for {@link RateLimitedSanctionsProvider}. */
export interface RateLimitOptions {
  /**
   * Total number of attempts per address before giving up and re-throwing
   * the last error.  The first attempt counts, so `maxRetries: 4` means
   * one original call plus three retries.
   *
   * @default 4
   */
  maxRetries?: number;

  /**
   * Base delay (in milliseconds) for the first back-off window.  Each
   * subsequent retry doubles this value (capped at {@link maxDelayMs}).
   *
   * @default 250
   */
  baseDelayMs?: number;

  /**
   * Maximum delay (in milliseconds) for any single back-off window before
   * jitter is added.
   *
   * @default 16000
   */
  maxDelayMs?: number;

  /**
   * Maximum number of concurrent `checkAddress` calls allowed at any one
   * time.  Useful when calling `checkAddress` directly inside `Promise.all`.
   * Has no effect when addresses are processed sequentially (the default in
   * `syncSanctionsToDenylist`).
   *
   * Omit or set to `Infinity` to disable concurrency limiting. Finite values
   * must be greater than zero; invalid values are rejected by the constructor.
   *
   * @default Infinity
   */
  concurrency?: number;

  /**
   * Inject a custom sleep function for testing.  Defaults to a real
   * `setTimeout`-based delay in production.
   *
   * @internal
   */
  _sleep?: (ms: number) => Promise<void>;
}

/**
 * Returns true when the error looks like an HTTP 429 / rate-limit response.
 * Covers common patterns across `fetch`, `axios`, and custom REST clients.
 */
function isRateLimitError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')) {
      return true;
    }
  }
  // Support providers that attach a `.status` or `.statusCode` field to errors
  // (e.g. axios, node-fetch HttpError subclasses).
  const statusCode =
    (err as { status?: unknown }).status ?? (err as { statusCode?: unknown }).statusCode;
  return statusCode === 429;
}

/** Returns a promise that resolves after `ms` milliseconds. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wraps any {@link SanctionsProvider} to add:
 *
 * - **Exponential back-off** — automatically retries `checkAddress` on HTTP
 *   429 / rate-limit errors using truncated exponential back-off with random
 *   jitter.
 * - **Concurrency limiting** — an optional semaphore caps the number of
 *   simultaneous in-flight `checkAddress` calls (useful when the caller fans
 *   out with `Promise.all`).
 *
 * All other errors (e.g. network failures, 5xx responses) are re-thrown
 * immediately without retrying.
 */
export class RateLimitedSanctionsProvider implements SanctionsProvider {
  private readonly inner: SanctionsProvider;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly concurrency: number;
  private readonly sleep: (ms: number) => Promise<void>;

  /** Tracks how many requests are currently in-flight (for the semaphore). */
  private inFlight = 0;
  /** Queue of resolvers waiting for a semaphore slot. */
  private readonly waiting: Array<() => void> = [];

  constructor(inner: SanctionsProvider, options: RateLimitOptions = {}) {
    this.inner = inner;
    this.maxRetries = options.maxRetries ?? 4;
    this.baseDelayMs = options.baseDelayMs ?? 250;
    this.maxDelayMs = options.maxDelayMs ?? 16_000;
    this.concurrency = options.concurrency ?? Infinity;
    if (
      this.concurrency !== Infinity &&
      (!Number.isFinite(this.concurrency) || this.concurrency <= 0)
    ) {
      throw new Error('concurrency must be a positive number or Infinity');
    }
    this.sleep = options._sleep ?? defaultSleep;
  }

  /**
   * Calls the wrapped provider's `checkAddress` with automatic retry on
   * rate-limit errors.  Waits for a semaphore slot if `concurrency` is set.
   *
   * @throws The last error encountered after `maxRetries` attempts, or
   *   immediately on non-rate-limit errors.
   */
  async checkAddress(address: string): Promise<{ flagged: boolean; source: string }> {
    await this.acquireSemaphore();
    try {
      return await this.checkWithRetry(address);
    } finally {
      this.releaseSemaphore();
    }
  }

  // ── private helpers ──────────────────────────────────────────────────────

  private async checkWithRetry(address: string): Promise<{ flagged: boolean; source: string }> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        return await this.inner.checkAddress(address);
      } catch (err) {
        if (!isRateLimitError(err)) {
          // Non-rate-limit error: fail immediately, don't retry.
          throw err;
        }
        lastError = err;
        const delay = this.backoffDelay(attempt);
        await this.sleep(delay);
      }
    }
    throw lastError;
  }

  /**
   * Calculates the back-off delay for a given `attempt` index (0-based).
   *
   * Formula: `min(baseDelayMs × 2^attempt, maxDelayMs) + jitter`
   * where `jitter` is a uniform random value in `[0, baseDelayMs)`.
   */
  private backoffDelay(attempt: number): number {
    const exponential = this.baseDelayMs * Math.pow(2, attempt);
    const capped = Math.min(exponential, this.maxDelayMs);
    const jitter = Math.random() * this.baseDelayMs;
    return Math.round(capped + jitter);
  }

  /** Blocks until a concurrency slot is available. */
  private acquireSemaphore(): Promise<void> {
    if (this.inFlight < this.concurrency) {
      this.inFlight++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  /** Releases a concurrency slot, waking the next waiter if any. */
  private releaseSemaphore(): void {
    const next = this.waiting.shift();
    if (next) {
      // Hand the slot directly to the next waiter (inFlight count stays the same).
      next();
    } else {
      this.inFlight--;
    }
  }
}
