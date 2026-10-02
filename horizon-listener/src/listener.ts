/**
 * Copyright (c) 2026 stellar-compliance-kit
 * SPDX-License-Identifier: MIT
 */

import type { EventSource, RawContractEvent } from './eventSource';
import { computeBackoffDelayMs, type BackoffOptions } from '@compliance-adapters/backoff';
import { type AnyMetricsRegistry, NoopMetricsRegistry } from './metrics';
import { type AnyTracer, NoopTracer } from './tracing';
import { type Logger, consoleLogger } from '@compliance-adapters/logger';

// Re-export so existing consumers that imported Logger from this module
// continue to compile without changes.
export type { Logger };

export interface HorizonListenerOptions {
  eventSource: EventSource;
  onEvent: (event: RawContractEvent) => Promise<void> | void;
  onEventFailure?: (event: RawContractEvent, error: unknown) => void | Promise<void>;
  pollIntervalMs?: number;
  /**
   * Maximum number of consecutive polling failures before giving up.
   * When a poll fails, a counter increments; it resets to 0 on success.
   * Once `attempts >= maxRetries`, the listener throws with an error.
   *
   * @default 10
   *
   * **Important:** `maxRetries: 0` means "fail immediately on the first error"
   * (since 1 >= 0), not "disable the retry limit" or "retry infinitely".
   * To disable the retry ceiling entirely, use `maxRetries: Infinity`.
   *
   * Example: with `maxRetries: 3`, the listener allows up to 3 consecutive
   * failed polls (attempts 1, 2, 3) before throwing; the error message
   * will say "giving up after 3 consecutive failed polls".
   */
  maxRetries?: number;
  logger?: Logger;
  // Injectable so tests can drive time with Jest fake timers instead of waiting
  // on the real wall clock.
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  // Injectable so tests can force deterministic (or jitter-free) backoff delays
  // instead of depending on Math.random.
  backoffOptions?: BackoffOptions;
  // When set, the listener pages through all historical events from this ledger
  // before entering normal live polling. Each page is consumed immediately
  // (without sleeping pollIntervalMs between pages); the listener only switches
  // to interval-based polling once a page returns zero events.
  startLedger?: number;
  // 'poll' (default): fixed-interval polling, always sleeps pollIntervalMs
  // between each call regardless of whether events were returned.
  // 'stream': polls again immediately when events were returned, reducing
  // latency for high-activity contracts; falls back to pollIntervalMs when
  // a poll returns empty (quiet period).
  mode?: 'poll' | 'stream';
  /**
   * Optional metrics registry.  Pass a `MetricsRegistry` instance to record
   * per-phase counters and latency histograms.  When omitted (or when a
   * `NoopMetricsRegistry` is passed) all instrumentation is zero-overhead.
   */
  metrics?: AnyMetricsRegistry;
  /**
   * Optional tracer for OpenTelemetry-compatible distributed tracing.
   * When omitted, a no-op tracer is used — zero overhead and no exports.
   *
   * To enable tracing, pass a `DefaultTracer` configured with an exporter:
   * ```ts
   * import { DefaultTracer } from 'horizon-listener';
   * const tracer = new DefaultTracer({
   *   serviceName: 'horizon-listener',
   *   exporter: async (span) => { await otlpExporter.export(span); },
   * });
   * ```
   */
  tracer?: AnyTracer;
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Sleep aborted'));
      return;
    }
    const timeoutId = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeoutId);
        reject(signal.reason ?? new Error('Sleep aborted'));
      },
      { once: true },
    );
  });

export class HorizonListener {
  private readonly eventSource: EventSource;
  private readonly onEvent: (event: RawContractEvent) => Promise<void> | void;
  private readonly onEventFailure?: (
    event: RawContractEvent,
    error: unknown,
  ) => void | Promise<void>;
  private readonly pollIntervalMs: number;
  private readonly maxRetries: number;
  private readonly logger: Logger;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly backoffOptions: BackoffOptions;
  private readonly mode: 'poll' | 'stream';
  private readonly metrics: AnyMetricsRegistry;
  private readonly tracer: AnyTracer;

  private cursor: string | undefined;
  private running = false;
  private attempt = 0;
  private backfilling = false;
  private sleepAbortController: AbortController | undefined;

  constructor(options: HorizonListenerOptions) {
    this.eventSource = options.eventSource;
    this.onEvent = options.onEvent;
    this.onEventFailure = options.onEventFailure;
    this.pollIntervalMs = options.pollIntervalMs ?? 5000;
    this.maxRetries = options.maxRetries ?? 10;
    this.logger = options.logger ?? consoleLogger;
    this.sleep = options.sleep ?? defaultSleep;
    this.backoffOptions = options.backoffOptions ?? {};
    this.backfilling = options.startLedger != null;
    this.mode = options.mode ?? 'poll';
    this.metrics = options.metrics ?? new NoopMetricsRegistry();
    this.tracer = options.tracer ?? new NoopTracer();
  }

  // Soroban RPC's getEvents is a polling/cursor API, not a persistent stream, so
  // "reconnecting" here just means: pause, then poll again with backoff.
  /**
   * Starts the event listener loop.
   * @throws {Error} When max retries are exceeded for consecutive polling failures.
   * This is an unrecoverable error that indicates the listener cannot continue.
   */
  async start(): Promise<void> {
    this.running = true;
    this.attempt = 0;

    while (this.running) {
      // ── rpc_poll span ────────────────────────────────────────────────────
      const pollSpan = this.tracer.startSpan('rpc_poll');
      pollSpan.setAttribute('poll.attempt', this.attempt);

      let response: { events: RawContractEvent[]; nextCursor: string };
      const pollStart = Date.now();
      try {
        response = await this.eventSource.getEvents(this.cursor);
      } catch (err) {
        const pollDuration = Date.now() - pollStart;
        this.metrics.counter.inc('rpc_poll', 'failure');
        this.metrics.histogram.observe('rpc_poll', pollDuration);

        this.attempt += 1;
        pollSpan.setAttribute('poll.attempt', this.attempt);
        pollSpan.end('error', err instanceof Error ? err : new Error(String(err)));

        this.logger.warn(
          `horizon-listener: poll failed (attempt ${this.attempt}/${this.maxRetries}), backing off`,
          err,
        );

        if (this.attempt >= this.maxRetries) {
          this.running = false;
          this.metrics.counter.inc('rpc_poll', 'cancelled');
          // Mark the final poll as cancelled (we gave up, not a transient error)
          this.tracer.startSpan('rpc_poll').end('cancelled');
          throw new Error(
            `horizon-listener: giving up after ${this.attempt} consecutive failed polls`,
          );
        }

        const delayMs = computeBackoffDelayMs(this.attempt, this.backoffOptions);
        this.sleepAbortController = new AbortController();
        try {
          await this.sleep(delayMs, this.sleepAbortController.signal);
        } catch (sleepErr) {
          if (this.sleepAbortController.signal.aborted) {
            break;
          }
          throw sleepErr;
        } finally {
          this.sleepAbortController = undefined;
        }
        continue;
      }

      const pollDuration = Date.now() - pollStart;
      this.metrics.counter.inc('rpc_poll', 'success');
      this.metrics.histogram.observe('rpc_poll', pollDuration);
      pollSpan.setAttribute('poll.event_count', response.events.length);
      pollSpan.end('ok');

      this.attempt = 0;

      for (const event of response.events) {
        const relayStart = Date.now();
        // ── event_relay span ───────────────────────────────────────────────
        // Parent is the poll span so spans form a coherent tree:
        // rpc_poll → event_relay (one child per event)
        const relayContext = { traceId: pollSpan.traceId, spanId: pollSpan.spanId };
        const relaySpan = this.tracer.startSpan('event_relay', relayContext);
        // Low-cardinality attributes only — event ID and contract ID are stable
        // identifiers, not user-data payloads. The event value is redacted by
        // the tracer (redactPayload: true by default).
        relaySpan.setAttribute('event.id', event.id);
        relaySpan.setAttribute('event.contract_id', event.contractId);
        relaySpan.setAttribute('event.ledger', event.ledger);

        try {
          this.logger.info('horizon-listener: received contract event', event);
          await this.onEvent(event);
          const relayDuration = Date.now() - relayStart;
          this.metrics.counter.inc('event_relay', 'success');
          this.metrics.histogram.observe('event_relay', relayDuration);
          relaySpan.end('ok');
        } catch (err) {
          const relayDuration = Date.now() - relayStart;
          this.logger.error('horizon-listener: onEvent handler threw', err);
          this.metrics.counter.inc('event_relay', 'failure');
          this.metrics.histogram.observe('event_relay', relayDuration);
          relaySpan.end('error', err instanceof Error ? err : new Error(String(err)));
          if (this.onEventFailure) {
            try {
              await this.onEventFailure(event, err);
            } catch (failureErr) {
              this.logger.error('horizon-listener: onEventFailure handler threw', failureErr);
            }
          }
        }
      }

      this.cursor = response.nextCursor;
      this.logger.debug('horizon-listener: cursor advanced', this.cursor);

      if (this.backfilling) {
        if (response.events.length === 0) {
          this.backfilling = false;
          this.logger.info('horizon-listener: backfill complete, switching to live polling');
        } else {
          this.logger.debug(
            `horizon-listener: backfill page consumed (${response.events.length} events), fetching next page`,
          );
          if (!this.running) {
            break;
          }
          continue;
        }
      }

      if (!this.running) {
        break;
      }

      // In stream mode, skip sleeping when events were returned so the next
      // page is fetched immediately; only sleep during quiet periods.
      if (this.mode === 'stream' && response.events.length > 0) {
        continue;
      }

      this.sleepAbortController = new AbortController();
      try {
        await this.sleep(this.pollIntervalMs, this.sleepAbortController.signal);
      } catch (sleepErr) {
        if (this.sleepAbortController.signal.aborted) {
          break;
        }
        throw sleepErr;
      } finally {
        this.sleepAbortController = undefined;
      }
    }
  }

  stop(): void {
    this.running = false;
    this.sleepAbortController?.abort();
  }

  /**
   * Returns a snapshot of the listener's current health/progress state, for
   * use in liveness/readiness probes or status dashboards.
   */
  getStatus(): {
    running: boolean;
    cursor: string | undefined;
    consecutiveFailures: number;
    backfilling: boolean;
  } {
    return {
      running: this.running,
      cursor: this.cursor,
      consecutiveFailures: this.attempt,
      backfilling: this.backfilling,
    };
  }
}
