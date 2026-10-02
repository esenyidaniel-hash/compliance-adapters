/**
 * Copyright (c) 2026 stellar-compliance-kit
 * SPDX-License-Identifier: MIT
 */

/**
 * Tests for HorizonListener eventRetry feature.
 * Issue #297: Add optional eventRetry config to retry failed onEvent calls.
 */

import { HorizonListener } from '../src/listener';
import type { EventSource, RawContractEvent } from '../src/eventSource';
import { computeBackoffDelayMs } from '@compliance-adapters/backoff';

function makeLogger() {
  return { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function makeEvent(overrides: Partial<RawContractEvent> = {}): RawContractEvent {
  return {
    id: 'evt-1',
    contractId: 'CDENYLISTGATE',
    ledger: 1,
    topic: ['denylist_added'],
    value: {},
    ...overrides,
  };
}

describe('HorizonListener.eventRetry', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('retries onEvent with bounded exponential backoff before calling onEventFailure', async () => {
    const event = makeEvent({ id: 'evt-retry-1' });
    const getEvents = jest
      .fn()
      .mockResolvedValueOnce({ events: [event], nextCursor: 'cursor-1' });

    const eventSource: EventSource = { getEvents };
    let attemptCount = 0;
    const onEvent = jest.fn(async () => {
      attemptCount++;
      if (attemptCount < 3) {
        throw new Error('transient failure');
      }
    });

    const onEventFailure = jest.fn();
    const logger = makeLogger();

    const listener = new HorizonListener({
      eventSource,
      onEvent,
      onEventFailure,
      logger,
      eventRetry: { maxRetries: 3, jitter: false },
      sleep: async () => {
        listener.stop();
      },
    });

    await listener.start();

    // onEvent should have been called 3 times (initial + 2 retries)
    expect(onEvent).toHaveBeenCalledTimes(3);
    expect(onEvent).toHaveBeenCalledWith(event);

    // onEventFailure should NOT be called since the retry succeeded
    expect(onEventFailure).not.toHaveBeenCalled();
  });

  it('exhausts eventRetry limit and calls onEventFailure with the last error', async () => {
    const event = makeEvent({ id: 'evt-exhaust-retry' });
    const getEvents = jest
      .fn()
      .mockResolvedValueOnce({ events: [event], nextCursor: 'cursor-1' });

    const eventSource: EventSource = { getEvents };
    const permanentError = new Error('permanent failure');
    const onEvent = jest.fn().mockRejectedValue(permanentError);
    const onEventFailure = jest.fn();
    const logger = makeLogger();

    const listener = new HorizonListener({
      eventSource,
      onEvent,
      onEventFailure,
      logger,
      eventRetry: { maxRetries: 2, jitter: false, baseMs: 100 },
      sleep: async () => {
        listener.stop();
      },
    });

    await listener.start();

    // onEvent should be called maxRetries times
    expect(onEvent).toHaveBeenCalledTimes(2);

    // onEventFailure should be called with the event and last error
    expect(onEventFailure).toHaveBeenCalledTimes(1);
    expect(onEventFailure).toHaveBeenCalledWith(event, permanentError);
  });

  it('uses eventRetry backoff delays matching computeBackoffDelayMs', async () => {
    const event = makeEvent({ id: 'evt-backoff-timing' });
    const getEvents = jest
      .fn()
      .mockResolvedValueOnce({ events: [event], nextCursor: 'cursor-1' });

    const eventSource: EventSource = { getEvents };
    const onEvent = jest
      .fn()
      .mockRejectedValueOnce(new Error('fail-1'))
      .mockRejectedValueOnce(new Error('fail-2'))
      .mockResolvedValueOnce(undefined); // Succeed on 3rd attempt

    const sleepCalls: number[] = [];
    const logger = makeLogger();

    const listener = new HorizonListener({
      eventSource,
      onEvent,
      logger,
      eventRetry: { maxRetries: 3, jitter: false, baseMs: 100, maxMs: 10000 },
      sleep: async (ms) => {
        sleepCalls.push(ms);
        if (sleepCalls.length >= 2) {
          listener.stop();
        }
      },
    });

    const startPromise = listener.start();

    const firstDelay = computeBackoffDelayMs(1, { jitter: false, baseMs: 100, maxMs: 10000 });
    const secondDelay = computeBackoffDelayMs(2, { jitter: false, baseMs: 100, maxMs: 10000 });

    await jest.advanceTimersByTimeAsync(firstDelay);
    await jest.advanceTimersByTimeAsync(secondDelay);

    await startPromise;

    // Verify event retries used correct backoff delays
    expect(onEvent).toHaveBeenCalledTimes(3);
  });

  it('continues processing remaining events even if one exhausts eventRetry', async () => {
    const eventA = makeEvent({ id: 'evt-a' });
    const eventB = makeEvent({ id: 'evt-b' });

    const getEvents = jest
      .fn()
      .mockResolvedValueOnce({ events: [eventA, eventB], nextCursor: 'cursor-1' });

    const eventSource: EventSource = { getEvents };
    const onEvent = jest.fn(async (event: RawContractEvent) => {
      if (event.id === 'evt-a') {
        throw new Error('event A fails permanently');
      }
    });

    const onEventFailure = jest.fn();
    const logger = makeLogger();

    const listener = new HorizonListener({
      eventSource,
      onEvent,
      onEventFailure,
      logger,
      eventRetry: { maxRetries: 1, jitter: false },
      sleep: async () => {
        listener.stop();
      },
    });

    await listener.start();

    // Both events should be processed
    expect(onEvent).toHaveBeenCalledWith(eventA);
    expect(onEvent).toHaveBeenCalledWith(eventB);

    // Only eventA should have triggered onEventFailure
    expect(onEventFailure).toHaveBeenCalledTimes(1);
    expect(onEventFailure).toHaveBeenCalledWith(eventA, expect.any(Error));
  });

  it('does not retry if eventRetry is not configured', async () => {
    const event = makeEvent({ id: 'evt-no-config' });
    const getEvents = jest
      .fn()
      .mockResolvedValueOnce({ events: [event], nextCursor: 'cursor-1' });

    const eventSource: EventSource = { getEvents };
    const onEvent = jest.fn().mockRejectedValue(new Error('fail'));
    const onEventFailure = jest.fn();
    const logger = makeLogger();

    const listener = new HorizonListener({
      eventSource,
      onEvent,
      onEventFailure,
      logger,
      // eventRetry NOT provided
      sleep: async () => {
        listener.stop();
      },
    });

    await listener.start();

    // onEvent should be called exactly once (no retries)
    expect(onEvent).toHaveBeenCalledTimes(1);

    // onEventFailure should be called immediately
    expect(onEventFailure).toHaveBeenCalledTimes(1);
  });

  it('respects maxRetries: 0 (no retries, immediate failure)', async () => {
    const event = makeEvent({ id: 'evt-max-retries-zero' });
    const getEvents = jest
      .fn()
      .mockResolvedValueOnce({ events: [event], nextCursor: 'cursor-1' });

    const eventSource: EventSource = { getEvents };
    const onEvent = jest.fn().mockRejectedValue(new Error('always fails'));
    const onEventFailure = jest.fn();

    const listener = new HorizonListener({
      eventSource,
      onEvent,
      onEventFailure,
      eventRetry: { maxRetries: 0 },
      sleep: async () => {
        listener.stop();
      },
    });

    await listener.start();

    // onEvent should be called exactly once
    expect(onEvent).toHaveBeenCalledTimes(1);

    // onEventFailure should be called immediately
    expect(onEventFailure).toHaveBeenCalledTimes(1);
  });

  it('emits warning logs for each retry attempt', async () => {
    const event = makeEvent({ id: 'evt-retry-logging' });
    const getEvents = jest
      .fn()
      .mockResolvedValueOnce({ events: [event], nextCursor: 'cursor-1' });

    const eventSource: EventSource = { getEvents };
    let attemptCount = 0;
    const onEvent = jest.fn(async () => {
      attemptCount++;
      if (attemptCount < 3) {
        throw new Error('fail');
      }
    });

    const logger = makeLogger();

    const listener = new HorizonListener({
      eventSource,
      onEvent,
      logger,
      eventRetry: { maxRetries: 3, jitter: false },
      sleep: async () => {
        listener.stop();
      },
    });

    await listener.start();

    // Verify warning logs for each retry
    expect(logger.warn).toHaveBeenCalled();
    const warnCalls = logger.warn.mock.calls;
    expect(warnCalls.some((call) => call[0]?.includes?.('retry'))).toBe(true);
  });
});
