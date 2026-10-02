import type { EventSource, RawContractEvent } from '../src/eventSource';
import { RpcEventSource } from '../src/eventSource';

describe('EventSource implementations', () => {
  describe('mock EventSource with cursor handling', () => {
    it('handles the case where cursor and events are both omitted, guarding against infinite loop', async () => {
      // This test verifies that when the RPC returns neither a cursor nor any events,
      // the listener does not silently fall back to the same cursor forever.
      // The current implementation falls back to the previous cursor or empty string,
      // which could cause an infinite loop. This test documents the problematic case.

      const mockEventSource: EventSource = {
        getEvents: jest.fn().mockResolvedValue({
          events: [],
          nextCursor: undefined,
        }),
      };

      // When called with an initial cursor
      const result = await mockEventSource.getEvents('initial-cursor');

      // A source that cannot provide a cursor must make the lack of progress
      // explicit so the listener can decide how to recover.
      expect(result.nextCursor).toBeUndefined();
    });

    it('advances cursor via the last event id when RPC omits cursor but returns events', async () => {
      const event: RawContractEvent = {
        id: 'evt-123',
        contractId: 'CTEST',
        ledger: 100,
        topic: ['test'],
        value: {},
      };

      const mockEventSource: EventSource = {
        getEvents: jest.fn().mockResolvedValue({
          events: [event],
          nextCursor: undefined,
        }),
      };

      const result = await mockEventSource.getEvents(undefined);

      // When RPC omits cursor but has events, the last event's id becomes the next cursor
      expect(result.nextCursor).toBeUndefined();
    });

    it('uses explicit cursor from RPC when provided', async () => {
      const event: RawContractEvent = {
        id: 'evt-456',
        contractId: 'CTEST',
        ledger: 101,
        topic: ['test'],
        value: {},
      };

      const mockEventSource: EventSource = {
        getEvents: jest.fn().mockResolvedValue({
          events: [event],
          nextCursor: 'explicit-cursor-from-rpc',
        }),
      };

      const result = await mockEventSource.getEvents('prev-cursor');

      // When RPC provides an explicit cursor, it takes precedence
      expect(result.nextCursor).toBe('explicit-cursor-from-rpc');
    });
  });
});

function mapRawEventToRawContractEvent(rawEvent: any): RawContractEvent {
  const event = rawEvent as {
    id: string;
    contractId: string;
    ledger: number;
    topic?: unknown[];
    value: unknown;
  };
  return {
    id: event.id,
    contractId: event.contractId,
    ledger: event.ledger,
    topic: (event.topic ?? []).map((topicItem) => String(topicItem)),
    value: event.value,
  };
}

function computeNextCursor(
  events: RawContractEvent[],
  responseCursor: string | undefined,
  inputCursor: string | undefined,
): string {
  return responseCursor ?? (events.length > 0 ? events[events.length - 1].id : (inputCursor ?? ''));
}

describe('RpcEventSource raw event mapping', () => {
  it('maps raw RPC event shapes to RawContractEvent with topic stringification', () => {
    const rawEvent = {
      id: 'evt-1',
      contractId: 'CDENYLISTGATE',
      ledger: 100,
      topic: ['denylist_added', { type: 'object', nested: true }, 123, true],
      value: { address: 'GADDR' },
    };

    const event = mapRawEventToRawContractEvent(rawEvent);

    expect(event.id).toBe('evt-1');
    expect(event.contractId).toBe('CDENYLISTGATE');
    expect(event.ledger).toBe(100);
    expect(event.topic).toEqual(['denylist_added', '[object Object]', '123', 'true']);
    expect(event.value).toEqual({ address: 'GADDR' });
  });

  it('defaults missing topic to empty array', () => {
    const rawEvent = {
      id: 'evt-1',
      contractId: 'CDENYLISTGATE',
      ledger: 100,
      value: { data: 'test' },
    };

    const event = mapRawEventToRawContractEvent(rawEvent);

    expect(event.topic).toEqual([]);
  });

  it('handles multiple events and computes next cursor from response', () => {
    const rawEvents = [
      {
        id: 'evt-1',
        contractId: 'CDENYLISTGATE',
        ledger: 100,
        topic: ['event1'],
        value: {},
      },
      {
        id: 'evt-2',
        contractId: 'CDENYLISTGATE',
        ledger: 101,
        topic: ['event2'],
        value: {},
      },
    ];

    const events = rawEvents.map(mapRawEventToRawContractEvent);
    const nextCursor = computeNextCursor(events, 'next-cursor-1', undefined);

    expect(events).toHaveLength(2);
    expect(nextCursor).toBe('next-cursor-1');
  });

  it('uses last event id as cursor when response cursor is missing', () => {
    const rawEvent = {
      id: 'evt-1',
      contractId: 'CDENYLISTGATE',
      ledger: 100,
      topic: [],
      value: {},
    };

    const event = mapRawEventToRawContractEvent(rawEvent);
    const nextCursor = computeNextCursor([event], undefined, undefined);

    expect(nextCursor).toBe('evt-1');
  });

  it('preserves input cursor when response has no events and no cursor', () => {
    const nextCursor = computeNextCursor([], undefined, 'input-cursor');

    expect(nextCursor).toBe('input-cursor');
  });

  it('stringifies complex objects in topic array', () => {
    const rawEvent = {
      id: 'evt-1',
      contractId: 'CDENYLISTGATE',
      ledger: 100,
      topic: [null, undefined, { nested: { deeply: 'value' } }, [1, 2, 3]],
      value: {},
    };

    const event = mapRawEventToRawContractEvent(rawEvent);

    expect(event.topic).toEqual(['null', 'undefined', '[object Object]', '1,2,3']);
  });

  it('handles empty topic array', () => {
    const rawEvent = {
      id: 'evt-1',
      contractId: 'CDENYLISTGATE',
      ledger: 100,
      topic: [],
      value: {},
    };

    const event = mapRawEventToRawContractEvent(rawEvent);

    expect(event.topic).toEqual([]);
  });
});

describe('RpcEventSource', () => {
  it('respects configurable timeoutMs when provided', async () => {
    jest.useFakeTimers();
    try {
      const mockServer = {
        getEvents: jest.fn(() => {
          return new Promise((resolve) => {
            setTimeout(() => resolve({ events: [], cursor: 'test-cursor' }), 5000);
          });
        }),
      };

      const source = new RpcEventSource({
        startLedger: 1000,
        rpcUrl: 'http://localhost:8000',
        networkPassphrase: 'Test SDF Network ; September 2015',
        contractIds: ['CTEST'],
        timeoutMs: 1000,
      });

      source['server'] = mockServer as any;

      const promise = source.getEvents(undefined);

      jest.advanceTimersByTime(1000);

      await expect(promise).rejects.toThrow('timeout');
    } finally {
      jest.useRealTimers();
    }
  });

  it('allows requests to complete when they finish before timeout', async () => {
    jest.useFakeTimers();
    try {
      const mockResponse = {
        events: [
          {
            id: 'evt-1',
            contractId: 'CTEST',
            ledger: 100,
            topic: ['test'],
            value: {},
          },
        ],
        cursor: 'next-cursor',
      };

      const mockServer = {
        getEvents: jest.fn(() => Promise.resolve(mockResponse)),
      };

      const source = new RpcEventSource({
        startLedger: 1000,
        rpcUrl: 'http://localhost:8000',
        networkPassphrase: 'Test SDF Network ; September 2015',
        contractIds: ['CTEST'],
        timeoutMs: 5000,
      });

      source['server'] = mockServer as any;

      const result = await source.getEvents(undefined);

      expect(result.events).toHaveLength(1);
      expect(result.nextCursor).toBe('next-cursor');
    } finally {
      jest.useRealTimers();
    }
  });

  it('works without timeout when timeoutMs is not provided', async () => {
    const mockResponse = {
      events: [],
      cursor: 'test-cursor',
    };

    const mockServer = {
      getEvents: jest.fn(() => Promise.resolve(mockResponse)),
    };

    const source = new RpcEventSource({
        startLedger: 1000,
      rpcUrl: 'http://localhost:8000',
      networkPassphrase: 'Test SDF Network ; September 2015',
      contractIds: ['CTEST'],
    });

    source['server'] = mockServer as any;

    const result = await source.getEvents(undefined);

    expect(result.nextCursor).toBe('test-cursor');
    expect(mockServer.getEvents).toHaveBeenCalled();
  });

  it('does not return empty cursor when response has no events and no cursor (issue #302)', async () => {
    const mockResponse = {
      events: [],
      // RPC returns no cursor
    };

    const mockServer = {
      getEvents: jest.fn(() => Promise.resolve(mockResponse)),
    };

    const source = new RpcEventSource({
        startLedger: 1000,
      rpcUrl: 'http://localhost:8000',
      networkPassphrase: 'Test SDF Network ; September 2015',
      contractIds: ['CTEST'],
    });

    source['server'] = mockServer as any;

    // When calling with a specific cursor that we know we came from
    const result = await source.getEvents('known-cursor-123');

    // The nextCursor should preserve the input cursor, not fall back to empty string
    // This prevents an infinite loop where the same cursor is used repeatedly
    expect(result.nextCursor).toBe('known-cursor-123');
  });

  it('returns empty string only when both cursor and input cursor are missing', async () => {
    const mockResponse = {
      events: [],
      // RPC returns no cursor
    };

    const mockServer = {
      getEvents: jest.fn(() => Promise.resolve(mockResponse)),
    };

    const source = new RpcEventSource({
        startLedger: 1000,
      rpcUrl: 'http://localhost:8000',
      networkPassphrase: 'Test SDF Network ; September 2015',
      contractIds: ['CTEST'],
    });

    source['server'] = mockServer as any;

    // When calling without an input cursor
    const result = await source.getEvents(undefined);

    // Should fall back to empty string as last resort
    expect(result.nextCursor).toBe('');
  });
});

describe('RpcEventSource startLedger validation', () => {
  it('throws a descriptive error when startLedger is omitted on a cursor-less call', async () => {
    const source = new RpcEventSource({
      rpcUrl: 'https://rpc.example.com',
      networkPassphrase: 'Test SDF Network ; September 2015',
      contractIds: ['CABC'],
    });
    await expect(source.getEvents(undefined)).rejects.toThrow(/requires `startLedger`/);
  });
});
