import { Networks } from '@stellar/stellar-sdk';
import { createWebhookForwarder } from '../src/index';

// Example: Running horizon-listener with graceful shutdown on SIGINT/SIGTERM
// This demonstrates how to wire process.on('SIGINT'/'SIGTERM') to call
// HorizonListener.stop() for clean shutdown in a long-running Node process.

const listener = createWebhookForwarder({
  eventSource: {
    rpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: Networks.TESTNET,
    contractIds: [process.env.DENYLIST_GATE_CONTRACT_ID!, process.env.ALLOWLIST_TOKEN_CONTRACT_ID!],
  },
  webhook: {
    url: process.env.WEBHOOK_URL || 'http://localhost:4000/webhook',
  },
  listenerOptions: {
    pollIntervalMs: 5000,
    logger: {
      debug: (...args) => console.log('[DEBUG]', ...args),
      info: (...args) => console.log('[INFO]', ...args),
      warn: (...args) => console.warn('[WARN]', ...args),
      error: (...args) => console.error('[ERROR]', ...args),
    },
  },
});

// Graceful shutdown: stop the listener on SIGINT (Ctrl+C) or SIGTERM signals
process.on('SIGINT', () => {
  console.log('Received SIGINT, stopping listener gracefully...');
  listener.stop();
});

process.on('SIGTERM', () => {
  console.log('Received SIGTERM, stopping listener gracefully...');
  listener.stop();
});

listener.start().catch((err) => {
  console.error('horizon-listener gave up after repeated failures', err);
  process.exit(1);
});
