/**
 * Copyright (c) 2026 stellar-compliance-kit
 * SPDX-License-Identifier: MIT
 */

/**
 * Integration test: RpcEventSource + HorizonListener with a real Soroban
 * testnet container.
 *
 * This test proves the full event pipeline end-to-end:
 * 1. A local Soroban testnet is running (via stellar/quickstart Docker
 *    container, started by `npm run test:e2e:start`).
 * 2. A denylist-gate contract is deployed to that testnet.
 * 3. sanctions-oracle sync writes a flagged address on-chain, causing the
 *    contract to emit a real `denylist_added` event.
 * 4. The real `RpcEventSource` polls the Soroban RPC and the `HorizonListener`
 *    receives the event through its `onEvent` callback.
 *
 * This is separated from the fast unit suite (which uses a fully mocked
 * EventSource) and requires Docker. Run it opt-in:
 *
 *   npm run test:integration:horizon-listener
 *
 * In CI:
 *   npm run test:integration:horizon-listener:ci
 */

import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { scValToNative } from '@stellar/stellar-sdk';
import {
  syncSanctionsToDenylist,
  createRpcDenylistWriter,
  MockSanctionsProvider,
} from 'sanctions-oracle';
import {
  RpcEventSource,
  HorizonListener,
  type RawContractEvent,
} from 'horizon-listener';
import {
  TEST_CONFIG,
  waitForRpcHealth,
  getOrFundAccount,
  deployContract,
} from './setup';

const execAsync = promisify(exec);
const WASM_PATH = path.join(__dirname, '..', 'fixtures', 'denylist-gate.wasm');

/**
 * Fail fast with a clear, actionable message if Docker is not available,
 * rather than hanging on RPC connection attempts or silent timeouts.
 */
async function assertDockerAvailable(): Promise<void> {
  try {
    await execAsync('docker info --format {{.OSType}}');
  } catch (err) {
    throw new Error(
      'Docker is not available. This integration test requires Docker to run a local Soroban testnet. ' +
        'Please install Docker (https://docs.docker.com/get-docker/) and ensure the Docker daemon is running, ' +
        'then retry with: npm run test:integration:horizon-listener',
    );
  }
}

describe('RpcEventSource + HorizonListener integration (real Soroban testnet)', () => {
  beforeAll(async () => {
    await assertDockerAvailable();
  });

  it('observes a real denylist_added event via RpcEventSource + HorizonListener', async () => {
    // =========================================================================
    // SETUP: RPC health, funded account, deployed contract
    // =========================================================================
    const server = await waitForRpcHealth();

    await getOrFundAccount(server, TEST_CONFIG.issuer);

    const { contractId } = await deployContract(
      server,
      TEST_CONFIG.issuer,
      WASM_PATH,
    );

    // =========================================================================
    // STEP 1: Start HorizonListener with the real RpcEventSource
    // =========================================================================
    const receivedEvents: RawContractEvent[] = [];

    // Use the current ledger as startLedger so the listener only looks
    // forward from this point, avoiding replay of stale on-chain history.
    const { sequence: startLedger } = await server.getLatestLedger();

    const eventSource = new RpcEventSource({
      rpcUrl: TEST_CONFIG.rpcUrl,
      networkPassphrase: TEST_CONFIG.networkPassphrase,
      contractIds: [contractId],
      startLedger,
      timeoutMs: 10000,
    });

    const listener = new HorizonListener({
      eventSource,
      onEvent: (event) => {
        receivedEvents.push(event);
        listener.stop();
      },
      pollIntervalMs: 2000,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      maxRetries: 15,
    });

    const listenerPromise = listener.start();

    // =========================================================================
    // STEP 2: Trigger a real denylist event on-chain via sanctions-oracle sync
    // =========================================================================
    const provider = new MockSanctionsProvider({
      flaggedAddresses: [TEST_CONFIG.flaggedAddress],
    });
    const writer = createRpcDenylistWriter({
      rpcUrl: TEST_CONFIG.rpcUrl,
      networkPassphrase: TEST_CONFIG.networkPassphrase,
      contractId,
      sourceKeypair: TEST_CONFIG.issuer,
    });

    await syncSanctionsToDenylist({
      provider,
      addresses: [TEST_CONFIG.flaggedAddress],
      writer,
      dryRun: false,
    });

    // =========================================================================
    // STEP 3: Wait for the listener to observe the event
    // =========================================================================
    await listenerPromise;

    // =========================================================================
    // STEP 4: Assertions
    // =========================================================================
    expect(receivedEvents.length).toBeGreaterThan(0);

    const denylistEvent = receivedEvents.find((e) =>
      e.topic.some((t) => t.includes('denylist_added')),
    );

    expect(denylistEvent).toBeDefined();

    // The RpcEventSource passes through the raw ScVal; convert it to a
    // native JS value for comparison with the expected address string.
    const eventValue = scValToNative(denylistEvent!.value as never);
    expect(eventValue).toBe(TEST_CONFIG.flaggedAddress);
  });
});
