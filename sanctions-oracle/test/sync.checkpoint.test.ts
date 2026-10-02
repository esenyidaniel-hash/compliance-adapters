/// <reference types="jest" />

/**
 * Issue #344: syncSanctionsToDenylist can checkpoint progress so a large sync
 * interrupted by a crash resumes instead of restarting from address zero.
 */

import { Keypair } from '@stellar/stellar-sdk';
import { syncSanctionsToDenylist, DenylistWriter } from '../src/sync';
import { InMemoryCheckpointStore, SyncCheckpointStore } from '../src/checkpoint';
import { MockSanctionsProvider, MOCK_FLAGGED_ADDRESSES } from '../src/mockProvider';

const FLAGGED_ADDRESSES = Object.keys(MOCK_FLAGGED_ADDRESSES);
const FLAGGED_ADDRESS = FLAGGED_ADDRESSES[0];
const CLEAN_ADDRESS = Keypair.random().publicKey();

function makeFakeWriter(): DenylistWriter & { addToDenylist: jest.Mock } {
  return { addToDenylist: jest.fn().mockResolvedValue({ hash: 'fakehash' }) };
}

describe('InMemoryCheckpointStore', () => {
  it('records and reports completed addresses', () => {
    const store = new InMemoryCheckpointStore();
    expect(store.isComplete(FLAGGED_ADDRESS)).toBe(false);

    store.markComplete(FLAGGED_ADDRESS);

    expect(store.isComplete(FLAGGED_ADDRESS)).toBe(true);
    expect(store.snapshot()).toEqual([FLAGGED_ADDRESS]);
  });

  it('seeds from an initial iterable', () => {
    const store = new InMemoryCheckpointStore([FLAGGED_ADDRESS, CLEAN_ADDRESS]);
    expect(store.isComplete(FLAGGED_ADDRESS)).toBe(true);
    expect(store.isComplete(CLEAN_ADDRESS)).toBe(true);
  });
});

describe('syncSanctionsToDenylist — checkpointing (issue #598)', () => {
  it('marks a clean address complete after its provider check', async () => {
    const provider = new MockSanctionsProvider();
    const writer = makeFakeWriter();
    const checkpoint = new InMemoryCheckpointStore();

    await syncSanctionsToDenylist({
      provider,
      addresses: [CLEAN_ADDRESS],
      writer,
      dryRun: true,
      checkpoint,
    });

    expect(checkpoint.isComplete(CLEAN_ADDRESS)).toBe(true);
  });

  it('marks a flagged address complete only after the denylist write succeeds', async () => {
    const provider = new MockSanctionsProvider();
    const checkpoint = new InMemoryCheckpointStore();
    const writer: DenylistWriter = {
      addToDenylist: jest.fn().mockRejectedValue(new Error('rpc down')),
    };

    await expect(
      syncSanctionsToDenylist({
        provider,
        addresses: [FLAGGED_ADDRESS],
        writer,
        dryRun: false,
        checkpoint,
      }),
    ).rejects.toThrow('rpc down');

    // Write failed → not checkpointed → a resume will retry it.
    expect(checkpoint.isComplete(FLAGGED_ADDRESS)).toBe(false);
  });

  it('does not checkpoint a flagged address in dry-run mode (no write happened)', async () => {
    const provider = new MockSanctionsProvider();
    const writer = makeFakeWriter();
    const checkpoint = new InMemoryCheckpointStore();

    await syncSanctionsToDenylist({
      provider,
      addresses: [FLAGGED_ADDRESS],
      writer,
      dryRun: true,
      checkpoint,
    });

    expect(checkpoint.isComplete(FLAGGED_ADDRESS)).toBe(false);
  });

  it('with resume:true, skips addresses the checkpoint already recorded', async () => {
    const provider = new MockSanctionsProvider();
    const checkSpy = jest.spyOn(provider, 'checkAddress');
    const writer = makeFakeWriter();
    const checkpoint = new InMemoryCheckpointStore([FLAGGED_ADDRESSES[0], FLAGGED_ADDRESSES[1]]);

    const result = await syncSanctionsToDenylist({
      provider,
      addresses: [FLAGGED_ADDRESSES[0], FLAGGED_ADDRESSES[1], FLAGGED_ADDRESSES[2], CLEAN_ADDRESS],
      writer,
      dryRun: false,
      checkpoint,
      resume: true,
    });

    expect(result.skipped).toEqual([FLAGGED_ADDRESSES[0], FLAGGED_ADDRESSES[1]]);
    expect(result.checked).toBe(2);
    expect(result.flagged).toEqual([FLAGGED_ADDRESSES[2]]);
    expect(result.written).toEqual([FLAGGED_ADDRESSES[2]]);

    // The two already-complete addresses are never re-checked or re-written.
    expect(checkSpy).toHaveBeenCalledTimes(2);
    expect(writer.addToDenylist).toHaveBeenCalledTimes(1);
    expect(writer.addToDenylist).toHaveBeenCalledWith(FLAGGED_ADDRESSES[2]);
  });

  it('resume is a no-op without a checkpoint store', async () => {
    const provider = new MockSanctionsProvider();
    const writer = makeFakeWriter();

    const result = await syncSanctionsToDenylist({
      provider,
      addresses: [FLAGGED_ADDRESS, CLEAN_ADDRESS],
      writer,
      dryRun: false,
      resume: true,
    });

    expect(result.skipped).toEqual([]);
    expect(result.written).toEqual([FLAGGED_ADDRESS]);
  });

  it('a crash-then-resume run completes every flagged write exactly once', async () => {
    const checkpoint = new InMemoryCheckpointStore();
    const addresses = [...FLAGGED_ADDRESSES, CLEAN_ADDRESS];

    // First run: the writer dies on the 3rd flagged address.
    const failingWriter: DenylistWriter = {
      addToDenylist: jest
        .fn()
        .mockResolvedValueOnce({ hash: 'h1' })
        .mockResolvedValueOnce({ hash: 'h2' })
        .mockRejectedValue(new Error('process crashed mid-write')),
    };

    await expect(
      syncSanctionsToDenylist({
        provider: new MockSanctionsProvider(),
        addresses,
        writer: failingWriter,
        dryRun: false,
        checkpoint,
        resume: true,
      }),
    ).rejects.toThrow('process crashed mid-write');

    expect(checkpoint.snapshot().sort()).toEqual(
      [FLAGGED_ADDRESSES[0], FLAGGED_ADDRESSES[1], CLEAN_ADDRESS].sort(),
    );

    // Second run: fresh writer, same inputs, resume from the checkpoint.
    const goodWriter = makeFakeWriter();
    const result = await syncSanctionsToDenylist({
      provider: new MockSanctionsProvider(),
      addresses,
      writer: goodWriter,
      dryRun: false,
      checkpoint,
      resume: true,
    });

    // Only the addresses not yet completed are processed on the resume.
    expect(result.skipped.sort()).toEqual(
      [FLAGGED_ADDRESSES[0], FLAGGED_ADDRESSES[1], CLEAN_ADDRESS].sort(),
    );
    expect(result.written).toEqual([FLAGGED_ADDRESSES[2], FLAGGED_ADDRESSES[3]]);
    expect(goodWriter.addToDenylist).toHaveBeenCalledTimes(2);
    expect(checkpoint.snapshot().sort()).toEqual([...addresses].sort());
  });

  it('supports an async checkpoint store', async () => {
    const backing = new Set<string>();
    const asyncStore: SyncCheckpointStore = {
      isComplete: async (a) => backing.has(a),
      markComplete: async (a) => {
        backing.add(a);
      },
    };
    const provider = new MockSanctionsProvider();
    const writer = makeFakeWriter();

    await syncSanctionsToDenylist({
      provider,
      addresses: [FLAGGED_ADDRESS, CLEAN_ADDRESS],
      writer,
      dryRun: false,
      checkpoint: asyncStore,
    });

    expect(backing.has(FLAGGED_ADDRESS)).toBe(true);
    expect(backing.has(CLEAN_ADDRESS)).toBe(true);
  });
});
