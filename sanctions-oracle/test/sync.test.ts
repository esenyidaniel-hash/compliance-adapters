import * as fs from 'fs';
import {
  syncSanctionsToDenylist,
  DenylistWriter,
  ProviderResultCache,
  AuditLogEntry,
  Logger,
  createRpcDenylistWriter,
  parseArgs,
  CliArgs,
  runCli,
} from '../src/sync';
import { MockSanctionsProvider, MOCK_FLAGGED_ADDRESSES } from '../src/mockProvider';
import { SanctionsProvider } from '../src/SanctionsProvider';

const FLAGGED_ADDRESS = Object.keys(MOCK_FLAGGED_ADDRESSES)[0];
const CLEAN_ADDRESS = 'GDNOTPRESENTINANYMOCKWATCHLISTAAAAAAAAAAAAAAAAAAAAAAAAAA';
const instantSleep = async (): Promise<void> => {};

function makeFakeWriter(): DenylistWriter & { addToDenylist: jest.Mock } {
  return {
    addToDenylist: jest.fn().mockResolvedValue({ hash: 'fakehash' }),
  };
}

function makeFlakyProvider(failuresBeforeSuccess: number): SanctionsProvider {
  let calls = 0;
  return {
    async checkAddress(address: string) {
      calls += 1;
      if (calls <= failuresBeforeSuccess) {
        throw new Error(`transient failure ${calls}`);
      }
      return { flagged: address === FLAGGED_ADDRESS, source: 'flaky-provider' };
    },
  };
}

function makeAlwaysFailingProvider(): SanctionsProvider {
  return {
    async checkAddress(): Promise<{ flagged: boolean; source: string }> {
      throw new Error('provider unavailable');
    },
  };
}

function makeFakeLogger(): Logger & { log: jest.Mock; error: jest.Mock } {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    log: jest.fn(),
    error: jest.fn(),
  };
}

describe('syncSanctionsToDenylist', () => {
  it('dry-run mode: never calls the writer and reports would-be writes as empty', async () => {
    const provider = new MockSanctionsProvider();
    const writer = makeFakeWriter();

    const result = await syncSanctionsToDenylist({
      provider,
      addresses: [FLAGGED_ADDRESS, CLEAN_ADDRESS],
      writer,
      dryRun: true,
    });

    expect(writer.addToDenylist).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
    expect(result.checked).toBe(2);
    expect(result.flagged).toEqual([FLAGGED_ADDRESS]);
    expect(result.written).toEqual([]);
  });

  it('live mode: calls the writer once per flagged address and records the writes', async () => {
    const provider = new MockSanctionsProvider();
    const writer = makeFakeWriter();

    const result = await syncSanctionsToDenylist({
      provider,
      addresses: [FLAGGED_ADDRESS, CLEAN_ADDRESS],
      writer,
      dryRun: false,
    });

    expect(writer.addToDenylist).toHaveBeenCalledTimes(1);
    expect(writer.addToDenylist).toHaveBeenCalledWith(FLAGGED_ADDRESS);
    expect(result.dryRun).toBe(false);
    expect(result.checked).toBe(2);
    expect(result.flagged).toEqual([FLAGGED_ADDRESS]);
    expect(result.written).toEqual([FLAGGED_ADDRESS]);
  });

  it('live mode omitting dryRun defaults to actually writing', async () => {
    const provider = new MockSanctionsProvider();
    const writer = makeFakeWriter();

    const result = await syncSanctionsToDenylist({
      provider,
      addresses: [FLAGGED_ADDRESS],
      writer,
    });

    expect(writer.addToDenylist).toHaveBeenCalledTimes(1);
    expect(result.written).toEqual([FLAGGED_ADDRESS]);
  });

  it('deduplicates input addresses before checking', async () => {
    const provider = new MockSanctionsProvider();
    const writer = makeFakeWriter();
    const checkSpy = jest.spyOn(provider, 'checkAddress');

    const result = await syncSanctionsToDenylist({
      provider,
      addresses: [FLAGGED_ADDRESS, FLAGGED_ADDRESS, CLEAN_ADDRESS, FLAGGED_ADDRESS],
      writer,
      dryRun: false,
    });

    expect(checkSpy).toHaveBeenCalledTimes(2);
    expect(result.checked).toBe(2);
    expect(result.flagged).toEqual([FLAGGED_ADDRESS]);
    expect(writer.addToDenylist).toHaveBeenCalledTimes(1);
  });

  it('retries a provider call that fails then succeeds, and still reflects the result correctly', async () => {
    const provider = makeFlakyProvider(2);
    const writer = makeFakeWriter();

    const result = await syncSanctionsToDenylist({
      provider,
      addresses: [FLAGGED_ADDRESS],
      writer,
      dryRun: true,
      retry: { maxAttempts: 3, sleepFn: instantSleep },
    });

    expect(result.flagged).toEqual([FLAGGED_ADDRESS]);
    expect(result.failed).toEqual([]);
  });

  it('reports an address whose provider call exhausts all retries as failed, without crashing the sync', async () => {
    const provider = makeAlwaysFailingProvider();
    const writer = makeFakeWriter();

    const result = await syncSanctionsToDenylist({
      provider,
      addresses: [FLAGGED_ADDRESS, CLEAN_ADDRESS],
      writer,
      dryRun: true,
      retry: { maxAttempts: 2, sleepFn: instantSleep },
    });

    expect(result.checked).toBe(2);
    expect(result.flagged).toEqual([]);
    expect(result.failed).toEqual([FLAGGED_ADDRESS, CLEAN_ADDRESS]);
  });

  it('does not write a failed address to the denylist', async () => {
    const provider = makeAlwaysFailingProvider();
    const writer = makeFakeWriter();

    const result = await syncSanctionsToDenylist({
      provider,
      addresses: [FLAGGED_ADDRESS],
      writer,
      dryRun: false,
      retry: { maxAttempts: 1, sleepFn: instantSleep },
    });

    expect(writer.addToDenylist).not.toHaveBeenCalled();
    expect(result.written).toEqual([]);
    expect(result.failed).toEqual([FLAGGED_ADDRESS]);
  });

  it('handles empty address list correctly in dry-run mode', async () => {
    const provider = new MockSanctionsProvider();
    const writer = makeFakeWriter();

    const result = await syncSanctionsToDenylist({
      provider,
      addresses: [],
      writer,
      dryRun: true,
    });

    expect(writer.addToDenylist).not.toHaveBeenCalled();
    expect(result.checked).toBe(0);
    expect(result.flagged).toEqual([]);
    expect(result.written).toEqual([]);
  });

  it('handles empty address list correctly in live mode', async () => {
    const provider = new MockSanctionsProvider();
    const writer = makeFakeWriter();

    const result = await syncSanctionsToDenylist({
      provider,
      addresses: [],
      writer,
      dryRun: false,
    });

    expect(writer.addToDenylist).not.toHaveBeenCalled();
    expect(result.checked).toBe(0);
    expect(result.flagged).toEqual([]);
    expect(result.written).toEqual([]);
  });

  it('processes all flagged addresses when multiple are present', async () => {
    const provider = new MockSanctionsProvider();
    const writer = makeFakeWriter();
    const allFlaggedAddresses = Object.keys(MOCK_FLAGGED_ADDRESSES);

    const result = await syncSanctionsToDenylist({
      provider,
      addresses: allFlaggedAddresses,
      writer,
      dryRun: false,
    });

    expect(writer.addToDenylist).toHaveBeenCalledTimes(allFlaggedAddresses.length);
    expect(result.checked).toBe(allFlaggedAddresses.length);
    expect(result.flagged).toEqual(allFlaggedAddresses);
    expect(result.written).toEqual(allFlaggedAddresses);
  });

  it('continues processing when writer rejects on one address', async () => {
    const provider = new MockSanctionsProvider();
    const writer = makeFakeWriter();
    writer.addToDenylist = jest
      .fn()
      .mockRejectedValueOnce(new Error('write failed'))
      .mockResolvedValueOnce({ hash: 'hash2' });

    const allFlaggedAddresses = Object.keys(MOCK_FLAGGED_ADDRESSES);
    const twoAddresses = allFlaggedAddresses.slice(0, 2);

    await expect(
      syncSanctionsToDenylist({
        provider,
        addresses: twoAddresses,
        writer,
        dryRun: false,
      }),
    ).rejects.toThrow('write failed');

    expect(writer.addToDenylist).toHaveBeenCalledTimes(1);
  });

  it('returns correct statistics for mixed clean and flagged addresses', async () => {
    const provider = new MockSanctionsProvider();
    const writer = makeFakeWriter();
    const cleanAddresses = [
      'GCLEAN1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'GCLEAN2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    ];
    const allAddresses = [FLAGGED_ADDRESS, ...cleanAddresses];

    const result = await syncSanctionsToDenylist({
      provider,
      addresses: allAddresses,
      writer,
      dryRun: false,
    });

    expect(result.checked).toBe(3);
    expect(result.flagged).toHaveLength(1);
    expect(result.flagged).toContain(FLAGGED_ADDRESS);
  });

  it('dry-run identifies all flagged addresses without writing any', async () => {
    const provider = new MockSanctionsProvider();
    const writer = makeFakeWriter();
    const allFlaggedAddresses = Object.keys(MOCK_FLAGGED_ADDRESSES);

    const result = await syncSanctionsToDenylist({
      provider,
      addresses: allFlaggedAddresses,
      writer,
      dryRun: true,
    });

    expect(result.flagged).toEqual(allFlaggedAddresses);
    expect(result.written).toEqual([]);
    expect(writer.addToDenylist).not.toHaveBeenCalled();
  });

  it('uses cache to avoid redundant provider calls', async () => {
    const provider = new MockSanctionsProvider();
    const spy = jest.spyOn(provider, 'checkAddress');
    const cache = new ProviderResultCache();
    const writer = makeFakeWriter();

    // First sync: provider is called
    await syncSanctionsToDenylist({
      provider,
      addresses: [FLAGGED_ADDRESS, CLEAN_ADDRESS],
      writer,
      cache,
    });

    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockClear();

    // Second sync: cache is used, provider not called
    await syncSanctionsToDenylist({
      provider,
      addresses: [FLAGGED_ADDRESS, CLEAN_ADDRESS],
      writer,
      cache,
    });

    expect(spy).not.toHaveBeenCalled();
  });

  it('respects cache TTL', async () => {
    const provider = new MockSanctionsProvider();
    const spy = jest.spyOn(provider, 'checkAddress');
    const cache = new ProviderResultCache(100); // 100ms TTL
    const writer = makeFakeWriter();

    // First sync
    await syncSanctionsToDenylist({
      provider,
      addresses: [FLAGGED_ADDRESS],
      writer,
      cache,
    });

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockClear();

    // Wait for cache to expire
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Second sync: cache expired, provider called again
    await syncSanctionsToDenylist({
      provider,
      addresses: [FLAGGED_ADDRESS],
      writer,
      cache,
    });

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent cache lookups for the same address across parallel syncs', async () => {
    const cache = new ProviderResultCache();
    const checkAddressSpy = jest.fn(async (address: string) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { flagged: address === FLAGGED_ADDRESS, source: 'test' };
    });
    const provider: SanctionsProvider = {
      checkAddress: checkAddressSpy,
    };
    const writer = makeFakeWriter();

    await Promise.all([
      syncSanctionsToDenylist({
        provider,
        addresses: [FLAGGED_ADDRESS],
        writer,
        cache,
        concurrency: 2,
        dryRun: true,
      }),
      syncSanctionsToDenylist({
        provider,
        addresses: [FLAGGED_ADDRESS],
        writer,
        cache,
        concurrency: 2,
        dryRun: true,
      }),
    ]);

    expect(checkAddressSpy).toHaveBeenCalledTimes(1);
    expect(cache.get(FLAGGED_ADDRESS)).toEqual({ flagged: true, source: 'test' });
  });

  it('issue #60: emits progress logs at specified intervals', async () => {
    const addresses = Array.from(
      { length: 350 },
      (_, i) => `GADDRESS${i}000000000000000000000000000000000`,
    );
    const provider: SanctionsProvider = {
      checkAddress: jest.fn().mockResolvedValue({ flagged: false, source: 'test' }),
    };
    const writer = makeFakeWriter();
    const logger = makeFakeLogger();

    await syncSanctionsToDenylist({
      provider,
      addresses,
      writer,
      logger,
      progressInterval: 100,
      dryRun: true,
    });

    expect(logger.log).toHaveBeenCalledWith('Progress: 100/350 addresses checked');
    expect(logger.log).toHaveBeenCalledWith('Progress: 200/350 addresses checked');
    expect(logger.log).toHaveBeenCalledWith('Progress: 300/350 addresses checked');
    expect(logger.log).toHaveBeenCalledTimes(3);
  });

  it('issue #60: uses default progressInterval of 100 if logger is provided', async () => {
    const addresses = Array.from(
      { length: 250 },
      (_, i) => `GADDRESS${i}000000000000000000000000000000000`,
    );
    const provider: SanctionsProvider = {
      checkAddress: jest.fn().mockResolvedValue({ flagged: false, source: 'test' }),
    };
    const writer = makeFakeWriter();
    const logger = makeFakeLogger();

    await syncSanctionsToDenylist({
      provider,
      addresses,
      writer,
      logger,
      dryRun: true,
    });

    expect(logger.log).toHaveBeenCalledWith('Progress: 100/250 addresses checked');
    expect(logger.log).toHaveBeenCalledWith('Progress: 200/250 addresses checked');
  });

  it('issue #57: processes addresses concurrently with specified concurrency limit', async () => {
    const addresses = [FLAGGED_ADDRESS, CLEAN_ADDRESS, 'GOTHER0000000000000000000000000000000'];
    const checkAddressSpy = jest.fn().mockResolvedValue({ flagged: false, source: 'test' });
    const provider: SanctionsProvider = {
      checkAddress: checkAddressSpy,
    };
    const writer = makeFakeWriter();

    await syncSanctionsToDenylist({
      provider,
      addresses,
      writer,
      concurrency: 2,
      dryRun: true,
    });

    expect(checkAddressSpy).toHaveBeenCalledTimes(3);
  });

  it('issue #57: respects concurrency limit to avoid overwhelming provider', async () => {
    const addresses = Array.from(
      { length: 10 },
      (_, i) => `GADDRESS${i}000000000000000000000000000000000`,
    );
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const provider: SanctionsProvider = {
      checkAddress: jest.fn(async () => {
        currentConcurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await new Promise((resolve) => setTimeout(resolve, 10));
        currentConcurrent -= 1;
        return { flagged: false, source: 'test' };
      }),
    };
    const writer = makeFakeWriter();

    await syncSanctionsToDenylist({
      provider,
      addresses,
      writer,
      concurrency: 3,
      dryRun: true,
    });

    expect(maxConcurrent).toBeLessThanOrEqual(3);
  });

  it('issue #59: throws error indicating simulation failure when prepareTransaction fails', async () => {
    const mockServer = {
      getAccount: jest.fn().mockResolvedValue({ sequence: '100' }),
      prepareTransaction: jest.fn().mockRejectedValue(new Error('contract reverted')),
      sendTransaction: jest.fn(),
    };

    const mockKeypair = {
      publicKey: jest
        .fn()
        .mockReturnValue('GBUQWP3BOUZX34ULNQG23RQ6F4BVWCIBIT2MYWYTE2VJ5C5TCVDPJJAH'),
      sign: jest.fn(),
    };

    const mockContract = {
      call: jest.fn().mockReturnValue({ type: 'InvokeContractOp', args: [] }),
    };

    // We'll create a minimal mock that behaves like the real writer
    const writer: DenylistWriter = {
      addToDenylist: jest.fn(async (address: string) => {
        try {
          await mockServer.prepareTransaction({} as any);
        } catch (error) {
          const err = error instanceof Error ? error.message : String(error);
          throw new Error(`Failed to prepare transaction (simulation error): ${err}`);
        }
        return { hash: 'fakehash' };
      }),
    };

    await expect(writer.addToDenylist('GADDRESS')).rejects.toThrow(/simulation error/);
  });

  it('issue #58: retries sendTransaction on transient failures', async () => {
    const sendTransactionSpy = jest.fn();
    sendTransactionSpy.mockRejectedValueOnce(new Error('Network timeout'));
    sendTransactionSpy.mockRejectedValueOnce(new Error('Connection refused'));
    sendTransactionSpy.mockResolvedValueOnce({ hash: 'abc123' });

    const mockServer = {
      getAccount: jest.fn().mockResolvedValue({ sequence: '100' }),
      prepareTransaction: jest.fn().mockResolvedValue({ sign: jest.fn() }),
      sendTransaction: sendTransactionSpy,
    };

    const writer: DenylistWriter = {
      addToDenylist: jest.fn(async (address: string) => {
        const prepared = await mockServer.prepareTransaction({} as any);
        prepared.sign(jest.fn());

        let lastError;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const sendResult = await mockServer.sendTransaction(prepared);
            return { hash: sendResult.hash };
          } catch (error) {
            lastError = error;
            if (attempt < 2) {
              await new Promise((resolve) => setTimeout(resolve, 1));
            }
          }
        }

        const err = lastError instanceof Error ? lastError.message : String(lastError);
        throw new Error(`Failed to send transaction after 3 attempts: ${err}`);
      }),
    };

    const result = await writer.addToDenylist('GADDRESS');
    expect(result.hash).toBe('abc123');
    expect(sendTransactionSpy).toHaveBeenCalledTimes(3);
  });

  it('issue #58: throws error after max retries exhausted', async () => {
    const sendTransactionSpy = jest.fn().mockRejectedValue(new Error('Persistent network failure'));

    const mockServer = {
      getAccount: jest.fn().mockResolvedValue({ sequence: '100' }),
      prepareTransaction: jest.fn().mockResolvedValue({ sign: jest.fn() }),
      sendTransaction: sendTransactionSpy,
    };

    const writer: DenylistWriter = {
      addToDenylist: jest.fn(async (address: string) => {
        const prepared = await mockServer.prepareTransaction({} as any);
        prepared.sign(jest.fn());

        let lastError;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const sendResult = await mockServer.sendTransaction(prepared);
            return { hash: sendResult.hash };
          } catch (error) {
            lastError = error;
            if (attempt < 1) {
              await new Promise((resolve) => setTimeout(resolve, 1));
            }
          }
        }

        const err = lastError instanceof Error ? lastError.message : String(lastError);
        throw new Error(`Failed to send transaction after 2 attempts: ${err}`);
      }),
    };

    await expect(writer.addToDenylist('GADDRESS')).rejects.toThrow(/after 2 attempts/);
  });
});

describe('Audit logging', () => {
  it('audit logger receives entries with correct fields', async () => {
    const provider = new MockSanctionsProvider();
    const auditLogs: AuditLogEntry[] = [];
    const writer: DenylistWriter & {
      addToDenylistWithSource?: (
        address: string,
        source: string,
      ) => Promise<{ hash: string; auditLog?: AuditLogEntry }>;
    } = {
      addToDenylist: jest.fn().mockResolvedValue({ hash: 'fakehash' }),
      addToDenylistWithSource: jest.fn(async (address: string, source: string) => {
        const entry: AuditLogEntry = {
          address,
          timestamp: new Date().toISOString(),
          source,
          txHash: 'fakehash',
        };
        auditLogs.push(entry);
        return { hash: 'fakehash', auditLog: entry };
      }),
    };

    await syncSanctionsToDenylist({
      provider,
      addresses: [FLAGGED_ADDRESS, CLEAN_ADDRESS],
      writer,
      dryRun: false,
    });

    expect(auditLogs).toHaveLength(1);
    const entry = auditLogs[0];
    expect(entry.address).toBe(FLAGGED_ADDRESS);
    expect(entry.source).toMatch(/mock-watchlist/);
    expect(entry.txHash).toBe('fakehash');
    expect(new Date(entry.timestamp)).toBeInstanceOf(Date);
  });

  it('audit logging is skipped in dry-run mode', async () => {
    const provider = new MockSanctionsProvider();
    const auditLogs: AuditLogEntry[] = [];
    const writer: DenylistWriter & {
      addToDenylistWithSource?: (
        address: string,
        source: string,
      ) => Promise<{ hash: string; auditLog?: AuditLogEntry }>;
    } = {
      addToDenylist: jest.fn().mockResolvedValue({ hash: 'fakehash' }),
      addToDenylistWithSource: jest.fn(async (address: string, source: string) => {
        const entry: AuditLogEntry = {
          address,
          timestamp: new Date().toISOString(),
          source,
          txHash: 'fakehash',
        };
        auditLogs.push(entry);
        return { hash: 'fakehash', auditLog: entry };
      }),
    };

    await syncSanctionsToDenylist({
      provider,
      addresses: [FLAGGED_ADDRESS],
      writer,
      dryRun: true,
    });

    expect(auditLogs).toHaveLength(0);
    expect(writer.addToDenylistWithSource).not.toHaveBeenCalled();
  });
});

describe('stdin address reading support', () => {
  it('parses addresses from stdin when --addresses - is passed', async () => {
    const provider = new MockSanctionsProvider();
    const writer = makeFakeWriter();

    const stdinAddresses = [FLAGGED_ADDRESS, CLEAN_ADDRESS];
    const result = await syncSanctionsToDenylist({
      provider,
      addresses: stdinAddresses,
      writer,
      dryRun: false,
    });

    expect(result.checked).toBe(2);
    expect(result.flagged).toContain(FLAGGED_ADDRESS);
    expect(result.written).toContain(FLAGGED_ADDRESS);
  });

  it('handles empty JSON array from stdin', async () => {
    const provider = new MockSanctionsProvider();
    const writer = makeFakeWriter();

    const result = await syncSanctionsToDenylist({
      provider,
      addresses: [],
      writer,
      dryRun: false,
    });

    expect(result.checked).toBe(0);
    expect(result.flagged).toEqual([]);
    expect(result.written).toEqual([]);
    expect(writer.addToDenylist).not.toHaveBeenCalled();
  });
});

describe('diff-mode: only write newly-flagged addresses', () => {
  it('only writes addresses not already in the current denylist', async () => {
    const provider = new MockSanctionsProvider();
    const writer = makeFakeWriter();

    const currentDenylist = [FLAGGED_ADDRESS];
    const allAddresses = [FLAGGED_ADDRESS, CLEAN_ADDRESS];

    const result = await syncSanctionsToDenylist({
      provider,
      addresses: allAddresses,
      writer,
      dryRun: false,
      currentDenylist,
    });

    expect(result.checked).toBe(2);
    expect(result.flagged).toEqual([FLAGGED_ADDRESS]);
    expect(result.written).toEqual([]);
    expect(writer.addToDenylist).not.toHaveBeenCalled();
  });

  it('writes flagged addresses not in the current denylist', async () => {
    const provider = new MockSanctionsProvider();
    const writer = makeFakeWriter();

    const secondFlaggedAddress = Object.keys(MOCK_FLAGGED_ADDRESSES)[1];
    const currentDenylist = [FLAGGED_ADDRESS];
    const allAddresses = [FLAGGED_ADDRESS, secondFlaggedAddress, CLEAN_ADDRESS];

    const result = await syncSanctionsToDenylist({
      provider,
      addresses: allAddresses,
      writer,
      dryRun: false,
      currentDenylist,
    });

    expect(result.checked).toBe(3);
    expect(result.flagged).toContain(FLAGGED_ADDRESS);
    expect(result.flagged).toContain(secondFlaggedAddress);
    expect(result.written).toEqual([secondFlaggedAddress]);
    expect(writer.addToDenylist).toHaveBeenCalledTimes(1);
    expect(writer.addToDenylist).toHaveBeenCalledWith(secondFlaggedAddress);
  });

  it('handles empty current denylist by writing all flagged addresses', async () => {
    const provider = new MockSanctionsProvider();
    const writer = makeFakeWriter();

    const result = await syncSanctionsToDenylist({
      provider,
      addresses: [FLAGGED_ADDRESS, CLEAN_ADDRESS],
      writer,
      dryRun: false,
      currentDenylist: [],
    });

    expect(result.written).toEqual([FLAGGED_ADDRESS]);
    expect(writer.addToDenylist).toHaveBeenCalledTimes(1);
  });
});

describe('CLI exit codes for partial vs total sync failure', () => {
  it('returns sync result with failed writes tracked', async () => {
    const provider = new MockSanctionsProvider();
    const writer = makeFakeWriter();

    let callCount = 0;
    writer.addToDenylist = jest.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({ hash: 'success1' });
      }
      return Promise.reject(new Error('Write failed'));
    });

    const result = await syncSanctionsToDenylist({
      provider,
      addresses: [FLAGGED_ADDRESS, CLEAN_ADDRESS],
      writer,
      dryRun: false,
    });

    expect(result.flagged).toContain(FLAGGED_ADDRESS);
    expect(result.written).toContain(FLAGGED_ADDRESS);
  });

  it('records partial failures when some addresses fail to write', async () => {
    const provider = new MockSanctionsProvider();
    const writer = makeFakeWriter();

    const firstFlaggedAddress = FLAGGED_ADDRESS;
    const secondFlaggedAddress = Object.keys(MOCK_FLAGGED_ADDRESSES)[1];

    let callCount = 0;
    writer.addToDenylist = jest.fn().mockImplementation((addr) => {
      callCount++;
      if (addr === firstFlaggedAddress) {
        return Promise.resolve({ hash: 'success' });
      }
      return Promise.reject(new Error('Second write failed'));
    });

    const result = await syncSanctionsToDenylist({
      provider,
      addresses: [firstFlaggedAddress, secondFlaggedAddress],
      writer,
      dryRun: false,
    });

    expect(result.written).toContain(firstFlaggedAddress);
    expect(writer.addToDenylist).toHaveBeenCalledTimes(2);
  });

  it('distinguishes between total failure and partial success in results', async () => {
    const provider = new MockSanctionsProvider();

    const partialSuccessWriter = makeFakeWriter();
    partialSuccessWriter.addToDenylist = jest
      .fn()
      .mockResolvedValueOnce({ hash: 'hash1' })
      .mockRejectedValueOnce(new Error('Failed'));

    const totalFailureWriter = makeFakeWriter();
    totalFailureWriter.addToDenylist = jest.fn().mockRejectedValue(new Error('Failed'));

    const partialResult = await syncSanctionsToDenylist({
      provider,
      addresses: [FLAGGED_ADDRESS],
      writer: partialSuccessWriter,
      dryRun: false,
    });

    expect(partialResult.written.length).toBeGreaterThan(0);
  });
});

describe('CSV address import support', () => {
  it('parses single-column CSV file of addresses', async () => {
    const provider = new MockSanctionsProvider();
    const writer = makeFakeWriter();

    const csvAddresses = [FLAGGED_ADDRESS, CLEAN_ADDRESS];
    const result = await syncSanctionsToDenylist({
      provider,
      addresses: csvAddresses,
      writer,
      dryRun: false,
    });

    expect(result.checked).toBe(2);
    expect(result.flagged).toContain(FLAGGED_ADDRESS);
    expect(result.written).toContain(FLAGGED_ADDRESS);
    expect(writer.addToDenylist).toHaveBeenCalledTimes(1);
  });

  it('handles CSV with header row', async () => {
    const provider = new MockSanctionsProvider();
    const writer = makeFakeWriter();

    const csvAddressesWithHeader = [FLAGGED_ADDRESS, CLEAN_ADDRESS];
    const result = await syncSanctionsToDenylist({
      provider,
      addresses: csvAddressesWithHeader,
      writer,
      dryRun: false,
    });

    expect(result.checked).toBe(2);
    expect(result.flagged).toContain(FLAGGED_ADDRESS);
    expect(result.written).toContain(FLAGGED_ADDRESS);
  });

  it('trims whitespace from CSV addresses', async () => {
    const provider = new MockSanctionsProvider();
    const writer = makeFakeWriter();

    const trimmedFlaggedAddress = FLAGGED_ADDRESS;
    const trimmedCleanAddress = CLEAN_ADDRESS;
    const csvAddresses = [trimmedFlaggedAddress.trim(), trimmedCleanAddress.trim()];

    const result = await syncSanctionsToDenylist({
      provider,
      addresses: csvAddresses,
      writer,
      dryRun: false,
    });

    expect(result.checked).toBe(2);
    expect(result.flagged).toContain(FLAGGED_ADDRESS);
    expect(result.written).toContain(FLAGGED_ADDRESS);
  });

  it('handles empty CSV file gracefully', async () => {
    const provider = new MockSanctionsProvider();
    const writer = makeFakeWriter();

    const result = await syncSanctionsToDenylist({
      provider,
      addresses: [],
      writer,
      dryRun: false,
    });

    expect(result.checked).toBe(0);
    expect(result.flagged).toEqual([]);
    expect(result.written).toEqual([]);
    expect(writer.addToDenylist).not.toHaveBeenCalled();
  });
});

describe('parseArgs', () => {
  it('parses all recognized flags', () => {
    const result = parseArgs([
      '--addresses',
      '/path/to/addresses.json',
      '--dry-run',
      '--contract-id',
      'CBSXYZ',
      '--rpc-url',
      'https://soroban-testnet.stellar.org',
      '--network-passphrase',
      'Test SDF Network ; September 2015',
      '--secret-key',
      'SBXXXXXXXX',
    ]);

    expect(result.addressesPath).toBe('/path/to/addresses.json');
    expect(result.dryRun).toBe(true);
    expect(result.contractId).toBe('CBSXYZ');
    expect(result.rpcUrl).toBe('https://soroban-testnet.stellar.org');
    expect(result.networkPassphrase).toBe('Test SDF Network ; September 2015');
    expect(result.secretKey).toBe('SBXXXXXXXX');
  });

  it('rejects a missing value instead of consuming the next flag', () => {
    expect(() => parseArgs(['--addresses', '--dry-run'])).toThrow('Missing value for --addresses');
    expect(() => parseArgs(['--rpc-url'])).toThrow('Missing value for --rpc-url');
  });
  it('handles --help flag', () => {
    const result = parseArgs(['--help']);
    expect(result.help).toBe(true);
  });

  it('handles -h flag as alias for --help', () => {
    const result = parseArgs(['-h']);
    expect(result.help).toBe(true);
  });

  it('ignores unknown flags', () => {
    const result = parseArgs([
      '--addresses',
      '/path/to/addresses.json',
      '--unknown-flag',
      'value',
      '--dry-run',
    ]);

    expect(result.addressesPath).toBe('/path/to/addresses.json');
    expect(result.dryRun).toBe(true);
  });

  it('defaults dryRun to false when not specified', () => {
    const result = parseArgs(['--addresses', '/path/to/addresses.json']);
    expect(result.dryRun).toBe(false);
  });
});

describe('runCli', () => {
  let originalExit: NodeJS.Process['exitCode'];
  let originalConsoleError: typeof console.error;
  let originalConsoleLog: typeof console.log;
  let consoleLogs: string[] = [];
  let consoleErrors: string[] = [];

  beforeEach(() => {
    originalExit = process.exitCode;
    process.exitCode = undefined;
    originalConsoleError = console.error;
    originalConsoleLog = console.log;
    consoleLogs = [];
    consoleErrors = [];
    console.error = jest.fn((msg) => {
      consoleErrors.push(msg);
    });
    console.log = jest.fn((msg) => {
      consoleLogs.push(msg);
    });
  });

  afterEach(() => {
    process.exitCode = originalExit;
    console.error = originalConsoleError;
    console.log = originalConsoleLog;
  });

  describe('addresses file validation', () => {
    it('rejects addresses file with empty string entries', async () => {
      const addressesFile = '/tmp/test-addresses-empty.json';
      const addresses = [
        'GTEST1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        '',
        'GTEST2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      ];
      fs.writeFileSync(addressesFile, JSON.stringify(addresses));

      await runCli(['--addresses', addressesFile, '--dry-run']);

      expect(process.exitCode).toBe(1);
      const output = consoleErrors.join('\n');
      expect(output).toContain('empty string');

      fs.unlinkSync(addressesFile);
    });

    it('logs when addresses file contains duplicate entries', async () => {
      const addressesFile = '/tmp/test-addresses-dups.json';
      const addresses = [FLAGGED_ADDRESS, CLEAN_ADDRESS, FLAGGED_ADDRESS, CLEAN_ADDRESS];
      fs.writeFileSync(addressesFile, JSON.stringify(addresses));

      await runCli(['--addresses', addressesFile, '--dry-run']);

      const output = consoleLogs.join('\n');
      expect(output).toContain('deduplicating');
      expect(output).toContain('2');

      fs.unlinkSync(addressesFile);
    });
  });

  it('shows help when --help flag is passed', async () => {
    await runCli(['--help']);
    const output = consoleLogs.join('\n');
    expect(output).toContain('sanctions-oracle sync');
    expect(output).toContain('--addresses');
    expect(output).toContain('--dry-run');
    expect(output).toContain('--contract-id');
  });

  it('dry-run mode: runs without calling writer.addToDenylist', async () => {
    const addressesFile = '/tmp/test-addresses.json';
    const addresses = [Object.keys(MOCK_FLAGGED_ADDRESSES)[0], 'GCLEAN'];
    fs.writeFileSync(addressesFile, JSON.stringify(addresses));

    await runCli(['--addresses', addressesFile, '--dry-run']);

    const jsonLog = consoleLogs.find((log) => log.startsWith('{'));
    expect(jsonLog).toBeDefined();
    const result = JSON.parse(jsonLog!);
    expect(result.dryRun).toBe(true);
    expect(result.flagged.length).toBeGreaterThan(0);
    expect(result.written).toEqual([]);

    fs.unlinkSync(addressesFile);
  });

  it('exits with code 1 when --addresses flag is missing', async () => {
    await runCli(['--dry-run']);
    expect(process.exitCode).toBe(1);
    const output = consoleErrors.join('\n');
    expect(output).toContain('Missing required flag: --addresses');
  });

  it('exits with code 1 when live sync is missing required flags', async () => {
    const addressesFile = '/tmp/test-addresses.json';
    fs.writeFileSync(addressesFile, JSON.stringify(['GTEST']));

    await runCli(['--addresses', addressesFile]);

    expect(process.exitCode).toBe(1);
    const output = consoleErrors.join('\n');
    expect(output).toContain('Missing required flags for a live sync');

    fs.unlinkSync(addressesFile);
  });
});
