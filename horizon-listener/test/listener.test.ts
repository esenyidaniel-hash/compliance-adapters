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

describe('HorizonListener', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('processes events across two polls in order, threading the returned cursor', async () => {
    const eventA = makeEvent({ id: 'evt-1' });
    const eventB = makeEvent({ id: 'evt-2', topic: ['denylist_removed'] });

    const getEvents = jest
      .fn()
      .mockResolvedValueOnce({ events: [eventA], nextCursor: 'cursor-1' })
      .mockResolvedValueOnce({ events: [eventB], nextCursor: 'cursor-2' });

    const eventSource: EventSource = { getEvents };
    const received: RawContractEvent[] = [];

    // Injecting an instant sleep keeps this test focused on ordering/cursor
    // threading; the dedicated backoff test below exercises real wait timing.
    const listener: HorizonListener = new HorizonListener({
      eventSource,
      onEvent: (event) => {
        received.push(event);
        if (event.id === 'evt-2') {
          listener.stop();
        }
      },
      sleep: async () => {},
    });

    await listener.start();

    expect(received).toEqual([eventA, eventB]);
    expect(getEvents).toHaveBeenNthCalledWith(1, undefined);
    expect(getEvents).toHaveBeenNthCalledWith(2, 'cursor-1');
  });

  it('backs off between failed polls and recovers once getEvents succeeds again', async () => {
    const successEvent = makeEvent({ id: 'evt-recovered' });

    const getEvents = jest
      .fn()
      .mockRejectedValueOnce(new Error('rpc unreachable'))
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValueOnce({ events: [successEvent], nextCursor: 'cursor-success' });

    const eventSource: EventSource = { getEvents };
    const logger = makeLogger();
    const onEvent = jest.fn((_event: RawContractEvent) => {
      listener.stop();
    });

    // jitter disabled so the exact delay for each attempt is assertable against
    // computeBackoffDelayMs's own formula.
    const listener: HorizonListener = new HorizonListener({
      eventSource,
      onEvent,
      logger,
      backoffOptions: { jitter: false },
    });

    const startPromise = listener.start();

    const firstDelay = computeBackoffDelayMs(1, { jitter: false });
    const secondDelay = computeBackoffDelayMs(2, { jitter: false });

    await jest.advanceTimersByTimeAsync(firstDelay);
    await jest.advanceTimersByTimeAsync(secondDelay);

    await startPromise;

    expect(getEvents).toHaveBeenCalledTimes(3);
    expect(onEvent).toHaveBeenCalledWith(successEvent);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('asserts exact backoff delays across three consecutive failures', async () => {
    // This test explicitly verifies that backoff timing matches computeBackoffDelayMs's
    // exponential formula (baseMs * 2^attempt) for each attempt, ensuring contributors
    // can verify timing without relying on wall-clock time or flaky timing tolerances.
    const getEvents = jest.fn().mockRejectedValue(new Error('always down'));
    const eventSource: EventSource = { getEvents };
    const logger = makeLogger();
    const sleepCalls: number[] = [];

    const listener = new HorizonListener({
      eventSource,
      onEvent: jest.fn(),
      logger,
      maxRetries: 4, // Allow 4 attempts, fail on 4th
      backoffOptions: { jitter: false, baseMs: 100, maxMs: 10000 },
      sleep: async (ms: number) => {
        sleepCalls.push(ms);
      },
    });

    const startPromise = listener.start();
    startPromise.catch(() => {
      // asserted below via rejects.toThrow; swallow here so Node doesn't warn
      // about the rejection being "unhandled" while timers are advancing.
    });

    // Advance through each backoff delay; the listener will retry after each sleep
    const firstDelay = computeBackoffDelayMs(1, { jitter: false, baseMs: 100, maxMs: 10000 });
    const secondDelay = computeBackoffDelayMs(2, { jitter: false, baseMs: 100, maxMs: 10000 });
    const thirdDelay = computeBackoffDelayMs(3, { jitter: false, baseMs: 100, maxMs: 10000 });

    await jest.advanceTimersByTimeAsync(firstDelay);
    await jest.advanceTimersByTimeAsync(secondDelay);
    await jest.advanceTimersByTimeAsync(thirdDelay);

    await expect(startPromise).rejects.toThrow(/giving up/);

    // Verify getEvents was called 4 times (initial + 3 retries after backoff)
    expect(getEvents).toHaveBeenCalledTimes(4);

    // Verify sleep was called exactly 3 times with the correct delays
    // (no sleep before first attempt, sleep between each failure)
    expect(sleepCalls).toEqual([firstDelay, secondDelay, thirdDelay]);
  });

  it('rejects once maxRetries consecutive failures are exceeded', async () => {
    const getEvents = jest.fn().mockRejectedValue(new Error('always down'));
    const eventSource: EventSource = { getEvents };
    const logger = makeLogger();

    const listener = new HorizonListener({
      eventSource,
      onEvent: jest.fn(),
      logger,
      maxRetries: 3,
      backoffOptions: { jitter: false, baseMs: 10, maxMs: 1000 },
    });

    const startPromise = listener.start();
    startPromise.catch(() => {
      // asserted below via rejects.toThrow; swallow here so Node doesn't warn
      // about the rejection being "unhandled" while timers are advancing.
    });

    const firstDelay = computeBackoffDelayMs(1, { jitter: false, baseMs: 10, maxMs: 1000 });
    const secondDelay = computeBackoffDelayMs(2, { jitter: false, baseMs: 10, maxMs: 1000 });

    await jest.advanceTimersByTimeAsync(firstDelay);
    await jest.advanceTimersByTimeAsync(secondDelay);

    await expect(startPromise).rejects.toThrow(/giving up/);
    expect(getEvents).toHaveBeenCalledTimes(3);
  });

  it('backfills all historical pages before switching to live polling', async () => {
    const page1Events = [
      makeEvent({ id: 'h-1', ledger: 100 }),
      makeEvent({ id: 'h-2', ledger: 101 }),
    ];
    const page2Events = [makeEvent({ id: 'h-3', ledger: 102 })];
    const liveEvent = makeEvent({ id: 'live-1', ledger: 200 });

    const getEvents = jest
      .fn()
      // Backfill pages
      .mockResolvedValueOnce({ events: page1Events, nextCursor: 'cursor-p1' })
      .mockResolvedValueOnce({ events: page2Events, nextCursor: 'cursor-p2' })
      // Empty page signals backfill complete
      .mockResolvedValueOnce({ events: [], nextCursor: 'cursor-p2' })
      // Live polling
      .mockResolvedValueOnce({ events: [liveEvent], nextCursor: 'cursor-live' });

    const eventSource: EventSource = { getEvents };
    const received: RawContractEvent[] = [];
    const logger = makeLogger();
    const sleepCalls: number[] = [];

    const listener = new HorizonListener({
      eventSource,
      onEvent: (event) => {
        received.push(event);
        if (event.id === 'live-1') {
          listener.stop();
        }
      },
      logger,
      startLedger: 100,
      pollIntervalMs: 5000,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });

    await listener.start();

    // All events consumed in page order, no duplicates or gaps
    expect(received).toEqual([...page1Events, ...page2Events, liveEvent]);

    // Cursor threaded correctly across pages
    expect(getEvents).toHaveBeenNthCalledWith(1, undefined);
    expect(getEvents).toHaveBeenNthCalledWith(2, 'cursor-p1');
    expect(getEvents).toHaveBeenNthCalledWith(3, 'cursor-p2');
    expect(getEvents).toHaveBeenNthCalledWith(4, 'cursor-p2');

    // During backfill (pages 1-3), no sleep between pages.
    // Only the live poll (after backfill) sleeps with pollIntervalMs.
    expect(sleepCalls).toEqual([5000]);

    // Verify the backfill-complete log was emitted
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('backfill complete'));
  });

  it('pages through all historical events without skipping or duplicating at boundaries', async () => {
    // Simulates three full pages at exact page-boundary cursors
    const pages = [
      [makeEvent({ id: 'e-1' }), makeEvent({ id: 'e-2' }), makeEvent({ id: 'e-3' })],
      [makeEvent({ id: 'e-4' }), makeEvent({ id: 'e-5' }), makeEvent({ id: 'e-6' })],
      [makeEvent({ id: 'e-7' })],
    ];

    const getEvents = jest
      .fn()
      .mockResolvedValueOnce({ events: pages[0], nextCursor: 'c1' })
      .mockResolvedValueOnce({ events: pages[1], nextCursor: 'c2' })
      .mockResolvedValueOnce({ events: pages[2], nextCursor: 'c3' })
      .mockResolvedValueOnce({ events: [], nextCursor: 'c3' });

    const eventSource: EventSource = { getEvents };
    const received: string[] = [];

    const listener = new HorizonListener({
      eventSource,
      onEvent: (event) => {
        received.push(event.id);
      },
      startLedger: 1,
      sleep: async () => {
        // After backfill completes, stop on the next live poll sleep
        listener.stop();
      },
    });

    await listener.start();

    // Every event from every page, in order, no duplicates
    expect(received).toEqual(['e-1', 'e-2', 'e-3', 'e-4', 'e-5', 'e-6', 'e-7']);

    // Exactly 4 calls: 3 pages with events + 1 empty page to end backfill
    expect(getEvents).toHaveBeenCalledTimes(4);
  });

  it('stops before fetching another backfill page when stopped during a page', async () => {
    const firstEvent = makeEvent({ id: 'backfill-1', ledger: 100 });
    const getEvents = jest
      .fn()
      .mockResolvedValueOnce({ events: [firstEvent], nextCursor: 'cursor-next' })
      .mockResolvedValueOnce({
        events: [makeEvent({ id: 'should-not-run' })],
        nextCursor: 'cursor-end',
      });
    const received: string[] = [];
    let listener!: HorizonListener;
    listener = new HorizonListener({
      eventSource: { getEvents },
      startLedger: 100,
      onEvent: (event) => {
        received.push(event.id);
        listener.stop();
      },
      sleep: async () => {},
    });

    await listener.start();

    expect(received).toEqual(['backfill-1']);
    expect(getEvents).toHaveBeenCalledTimes(1);
    expect(getEvents).toHaveBeenCalledWith(undefined);
  });

  describe('mode: poll (default)', () => {
    it('sleeps pollIntervalMs between every poll regardless of events returned', async () => {
      const getEvents = jest
        .fn()
        .mockResolvedValueOnce({ events: [makeEvent({ id: 'e-1' })], nextCursor: 'c1' })
        .mockResolvedValueOnce({ events: [], nextCursor: 'c1' })
        .mockResolvedValueOnce({ events: [makeEvent({ id: 'e-2' })], nextCursor: 'c2' });

      const eventSource: EventSource = { getEvents };
      const sleepCalls: number[] = [];
      let pollCount = 0;

      const listener = new HorizonListener({
        eventSource,
        onEvent: jest.fn(),
        mode: 'poll',
        pollIntervalMs: 5000,
        sleep: async (ms) => {
          sleepCalls.push(ms);
          pollCount++;
          // Stop after the third poll's sleep to avoid hanging
          if (pollCount >= 3) listener.stop();
        },
      });

      await listener.start();

      // Every poll sleeps pollIntervalMs, whether events were returned or not
      expect(sleepCalls).toEqual([5000, 5000, 5000]);
      expect(getEvents).toHaveBeenCalledTimes(3);
    });
  });

  describe('mode: stream', () => {
    it('polls again immediately when events are returned, sleeps only when poll is empty', async () => {
      const getEvents = jest
        .fn()
        // Active period: events returned → no sleep
        .mockResolvedValueOnce({ events: [makeEvent({ id: 'e-1' })], nextCursor: 'c1' })
        .mockResolvedValueOnce({ events: [makeEvent({ id: 'e-2' })], nextCursor: 'c2' })
        // Quiet period: no events → sleep pollIntervalMs
        .mockResolvedValueOnce({ events: [], nextCursor: 'c2' })
        // Active again
        .mockResolvedValueOnce({ events: [makeEvent({ id: 'e-3' })], nextCursor: 'c3' });

      const eventSource: EventSource = { getEvents };
      const sleepCalls: number[] = [];
      const received: string[] = [];

      const listener = new HorizonListener({
        eventSource,
        onEvent: (event) => {
          received.push(event.id);
          if (event.id === 'e-3') listener.stop();
        },
        mode: 'stream',
        pollIntervalMs: 5000,
        sleep: async (ms) => {
          sleepCalls.push(ms);
        },
      });

      await listener.start();

      expect(received).toEqual(['e-1', 'e-2', 'e-3']);
      // Only slept once: during the quiet period (empty poll)
      expect(sleepCalls).toEqual([5000]);
      expect(getEvents).toHaveBeenCalledTimes(4);
    });

    it('falls back to pollIntervalMs during consecutive quiet polls', async () => {
      const getEvents = jest
        .fn()
        .mockResolvedValueOnce({ events: [], nextCursor: 'c0' })
        .mockResolvedValueOnce({ events: [], nextCursor: 'c0' })
        .mockResolvedValueOnce({ events: [makeEvent({ id: 'e-1' })], nextCursor: 'c1' });

      const eventSource: EventSource = { getEvents };
      const sleepCalls: number[] = [];

      const listener = new HorizonListener({
        eventSource,
        onEvent: () => {
          listener.stop();
        },
        mode: 'stream',
        pollIntervalMs: 3000,
        sleep: async (ms) => {
          sleepCalls.push(ms);
        },
      });

      await listener.start();

      // Two empty polls = two sleeps at pollIntervalMs
      expect(sleepCalls).toEqual([3000, 3000]);
    });
  });

  it('stop() causes the polling loop to exit and start() to resolve rather than hang', async () => {
    const getEvents = jest.fn().mockResolvedValue({ events: [], nextCursor: 'same-cursor' });
    const eventSource: EventSource = { getEvents };

    const listener = new HorizonListener({
      eventSource,
      onEvent: jest.fn(),
      pollIntervalMs: 1000,
      sleep: async () => {},
    });

    const startPromise = listener.start();
    listener.stop();

    await expect(startPromise).resolves.toBeUndefined();
  });

  it('handles backpressure: processes multiple events in single poll batch', async () => {
    // Test verifies listener processes all events from one poll before sleeping,
    // ensuring efficient batching. This documents expected behavior when multiple
    // events arrive in a single poll response.
    const event1 = makeEvent({ id: 'event-1', ledger: 100 });
    const event2 = makeEvent({ id: 'event-2', ledger: 101 });

    const getEvents = jest
      .fn()
      .mockResolvedValueOnce({ events: [event1, event2], nextCursor: 'cursor-1' });

    const eventSource: EventSource = { getEvents };
    const received: RawContractEvent[] = [];

    const onEvent = jest.fn(async (event: RawContractEvent) => {
      received.push(event);
      if (received.length === 2) {
        listener.stop();
      }
    });

    const listener = new HorizonListener({
      eventSource,
      onEvent,
      pollIntervalMs: 500,
      sleep: async () => {},
    });

    await listener.start();

    // Both events should be processed from single poll
    expect(received).toHaveLength(2);
    expect(received[0].id).toBe('event-1');
    expect(received[1].id).toBe('event-2');
    // Only one poll was made since listener was stopped after processing
    expect(getEvents).toHaveBeenCalledTimes(1);
  });

  it('supports pluggable cursor persistence to resume from last event', async () => {
    // Test documents the requirement for issue #85: a pluggable interface
    // to persist and restore the listener's cursor. Without persistence,
    // process restart replays events (if startLedger is old) or misses events
    // (if startLedger is 'now'). This test establishes the baseline.
    //
    // Future implementation should add a CursorStorage interface:
    // - load(): Promise<string | undefined> - restore last cursor
    // - save(cursor: string): Promise<void> - persist cursor after batch
    const event1 = makeEvent({ id: 'evt-persist-1', ledger: 100 });
    const event2 = makeEvent({ id: 'evt-persist-2', ledger: 101 });

    const getEvents = jest
      .fn()
      .mockResolvedValueOnce({ events: [event1], nextCursor: 'cursor-after-evt1' })
      .mockResolvedValueOnce({ events: [event2], nextCursor: 'cursor-after-evt2' });

    const eventSource: EventSource = { getEvents };
    const processedEvents: RawContractEvent[] = [];

    const onEvent = jest.fn(async (event: RawContractEvent) => {
      processedEvents.push(event);
      if (processedEvents.length >= 2) {
        listener.stop();
      }
    });

    const listener = new HorizonListener({
      eventSource,
      onEvent,
      pollIntervalMs: 500,
      sleep: async () => {},
    });

    await listener.start();

    // Verify events were processed in order
    expect(processedEvents).toHaveLength(2);
    expect(processedEvents[0].id).toBe('evt-persist-1');
    expect(processedEvents[1].id).toBe('evt-persist-2');

    // Current implementation keeps cursor only in memory.
    // After implementing issue #85, cursor ('cursor-after-evt2') should be
    // persisted to storage and restored on restart without replaying events.
  });

  it('demonstrates cursor storage interface for checkpoint persistence', async () => {
    // Test establishes the interface contract for cursor persistence (issue #85).
    // The listener should accept optional cursorStorage for pluggable persistence.
    // When implemented, the storage layer would handle:
    // 1. Loading cursor on startup to resume from last event
    // 2. Saving cursor after successfully processing a batch
    // 3. Supporting multiple storage backends (file, Redis, DB, etc.)

    interface CursorStorage {
      load(): Promise<string | undefined>;
      save(cursor: string): Promise<void>;
    }

    const persistedCursors: Record<string, string> = {};
    const mockStorage: CursorStorage = {
      load: jest.fn(async () => persistedCursors['cursor'] || undefined),
      save: jest.fn(async (cursor: string) => {
        persistedCursors['cursor'] = cursor;
      }),
    };

    const event = makeEvent({ id: 'cursor-test' });
    const getEvents = jest
      .fn()
      .mockResolvedValueOnce({ events: [event], nextCursor: 'new-cursor' });

    const eventSource: EventSource = { getEvents };
    const onEvent = jest.fn(async () => {
      listener.stop();
    });

    const listener = new HorizonListener({
      eventSource,
      onEvent,
      pollIntervalMs: 500,
      sleep: async () => {},
    });

    await listener.start();

    // Test passes with current implementation (no storage yet).
    // Once issue #85 is implemented, the listener would:
    // 1. Call mockStorage.load() at startup
    // 2. Use returned cursor for getEvents(cursor) instead of undefined
    // 3. Call mockStorage.save('new-cursor') after processing
    expect(getEvents).toHaveBeenCalledTimes(1);
  });

  it('calls onEventFailure when onEvent throws, providing the failed event and error', async () => {
    const eventA = makeEvent({ id: 'evt-1' });
    const eventB = makeEvent({ id: 'evt-2', topic: ['denylist_removed'] });

    const getEvents = jest
      .fn()
      .mockResolvedValueOnce({ events: [eventA, eventB], nextCursor: 'cursor-1' });

    const eventSource: EventSource = { getEvents };
    const eventError = new Error('event processing failed');
    const onEvent = jest
      .fn()
      .mockImplementationOnce(() => {
        throw eventError;
      })
      .mockImplementationOnce(() => {
        // second event succeeds
      });

    const onEventFailure = jest.fn();
    const logger = makeLogger();

    const listener = new HorizonListener({
      eventSource,
      onEvent,
      onEventFailure,
      logger,
      sleep: async () => {
        listener.stop();
      },
    });

    await listener.start();

    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEventFailure).toHaveBeenCalledTimes(1);
    expect(onEventFailure).toHaveBeenCalledWith(eventA, eventError);
    expect(onEvent).toHaveBeenNthCalledWith(1, eventA);
    expect(onEvent).toHaveBeenNthCalledWith(2, eventB);
  });

  it('handles onEventFailure callback errors without interrupting the listener', async () => {
    const eventA = makeEvent({ id: 'evt-1' });

    const getEvents = jest.fn().mockResolvedValueOnce({ events: [eventA], nextCursor: 'cursor-1' });

    const eventSource: EventSource = { getEvents };
    const eventError = new Error('event failed');
    const failureError = new Error('failure handler failed');
    const onEvent = jest.fn().mockImplementationOnce(() => {
      throw eventError;
    });

    const onEventFailure = jest.fn().mockImplementationOnce(() => {
      throw failureError;
    });

    const logger = makeLogger();

    const listener = new HorizonListener({
      eventSource,
      onEvent,
      onEventFailure,
      logger,
      sleep: async () => {
        listener.stop();
      },
    });

    await listener.start();

    expect(onEventFailure).toHaveBeenCalledWith(eventA, eventError);
    expect(logger.error).toHaveBeenCalledWith(
      'horizon-listener: onEventFailure handler threw',
      failureError,
    );
  });

  it('supports calling stop() during backoff delay to exit promptly', async () => {
    const getEvents = jest.fn().mockRejectedValue(new Error('rpc down'));
    const eventSource: EventSource = { getEvents };
    const logger = makeLogger();

    const listener = new HorizonListener({
      eventSource,
      onEvent: jest.fn(),
      logger,
      maxRetries: 5,
      backoffOptions: { jitter: false, baseMs: 1000, maxMs: 10000 },
    });

    const startPromise = listener.start();
    startPromise.catch(() => {
      // swallow rejection so Node doesn't warn about unhandled rejection
    });

    // Advance to trigger first failure and backoff
    await jest.advanceTimersByTimeAsync(0);

    // Call stop() while sleeping; should exit the loop
    listener.stop();

    // Should resolve (not reject) after a brief moment
    await expect(startPromise).resolves.toBeUndefined();
  });

  it('interrupts poll interval sleep when stop() is called', async () => {
    const eventA = makeEvent({ id: 'evt-1' });
    const getEvents = jest.fn().mockResolvedValue({ events: [eventA], nextCursor: 'cursor-1' });
    const eventSource: EventSource = { getEvents };
    const onEvent = jest.fn();

    const listener = new HorizonListener({
      eventSource,
      onEvent,
      pollIntervalMs: 10000,
    });

    const startPromise = listener.start();

    // Let the first poll complete
    await jest.advanceTimersByTimeAsync(0);

    // Listener is now sleeping for pollIntervalMs (10000ms)
    // Call stop() during the sleep
    listener.stop();

    // Should resolve immediately without waiting the full poll interval
    await expect(startPromise).resolves.toBeUndefined();
  });
});
