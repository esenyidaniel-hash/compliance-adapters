'use strict';

/**
 * full-stack-demo/server.js
 *
 * Flagship demo wiring all three compliance-adapters packages together:
 *   • sep10-auth      — SEP-10 challenge/verify + inline rate limiter and
 *                       in-memory token revocation store
 *   • sanctions-oracle — ProviderRegistry (fan-out across multiple providers)
 *                        + CsvSanctionsProvider + MockSanctionsProvider
 *                        + RestSanctionsProvider
 *   • horizon-listener — polling Soroban RPC for contract events, forwarding
 *                        to a webhook
 *   • prom-client      — Prometheus metrics exposed on GET /metrics for both
 *                        SEP-10 auth and sanctions-sync operations
 *
 * Run:  node server.js
 * Env vars (all optional — sensible defaults are provided for local testing):
 *   PORT                     HTTP port (default: 3001)
 *   HOME_DOMAIN              SEP-10 home domain (default: localhost:3001)
 *   SERVER_SECRET            Stellar secret key for signing challenges
 *   NETWORK_PASSPHRASE       Stellar network passphrase (default: testnet)
 *   CSV_SANCTIONS_PATH       Path to CSV watchlist file
 *   DENYLIST_CONTRACT_ID     Deployed denylist-gate contract ID
 *   SOROBAN_RPC_URL          Soroban RPC endpoint
 *   WEBHOOK_URL              Webhook target for horizon-listener events
 *   HORIZON_START_LEDGER     Starting ledger for event polling
 */

const express = require('express');
const bodyParser = require('body-parser');
const { Keypair, Networks } = require('@stellar/stellar-sdk');
const promClient = require('prom-client');
const crypto = require('crypto');

// Pull from local package builds (run `npm run build` in each workspace first).
// In a real deployment these would be installed as npm dependencies.
const { generateChallenge, verifyChallenge } = require('../../sep10-auth/dist/index.js');
const {
  MockSanctionsProvider,
  CsvSanctionsProvider,
  syncSanctionsToDenylist,
  createRpcDenylistWriter,
} = require('../../sanctions-oracle/dist/index.js');
const {
  HorizonListener,
  RpcEventSource,
  HttpWebhookSender,
} = require('../../horizon-listener/dist/index.js');

// ---------------------------------------------------------------------------
// Prometheus metrics registry
// ---------------------------------------------------------------------------

const registry = new promClient.Registry();
promClient.collectDefaultMetrics({ register: registry, prefix: 'demo_' });

// SEP-10 auth metrics
const sep10AuthTotal = new promClient.Counter({
  name: 'sep10_auth_requests_total',
  help: 'Total SEP-10 auth verification attempts',
  labelNames: ['result'], // 'success' | 'failure' | 'revoked' | 'rate_limited'
  registers: [registry],
});

const sep10ChallengesTotal = new promClient.Counter({
  name: 'sep10_challenges_issued_total',
  help: 'Total SEP-10 challenges issued',
  registers: [registry],
});

// Sanctions sync metrics
const sanctionsSyncTotal = new promClient.Counter({
  name: 'sanctions_sync_total',
  help: 'Total sanctions-sync runs',
  labelNames: ['result'], // 'success' | 'error'
  registers: [registry],
});

const sanctionsFlaggedAddresses = new promClient.Gauge({
  name: 'sanctions_flagged_addresses',
  help: 'Number of addresses flagged in the most recent sync run',
  registers: [registry],
});

const sanctionsSyncDurationMs = new promClient.Histogram({
  name: 'sanctions_sync_duration_ms',
  help: 'Duration of each sanctions sync run in milliseconds',
  buckets: [50, 100, 250, 500, 1000, 2500, 5000],
  registers: [registry],
});

// Horizon-listener event metrics
const horizonEventsReceived = new promClient.Counter({
  name: 'horizon_events_received_total',
  help: 'Total contract events received from the Soroban RPC poller',
  labelNames: ['contract_id'],
  registers: [registry],
});

const horizonWebhookErrors = new promClient.Counter({
  name: 'horizon_webhook_errors_total',
  help: 'Total errors forwarding horizon events to the downstream webhook',
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Rate limiter (inline implementation — showcases the pattern described in #287)
// ---------------------------------------------------------------------------

/**
 * Simple fixed-window in-memory rate limiter.
 * In production you would replace this Map with a Redis-backed store.
 *
 * @param {object} opts
 * @param {number} opts.windowMs   - Window length in milliseconds
 * @param {number} opts.maxRequests - Max requests allowed per window per key
 * @returns {(key: string) => boolean} Returns true if the request is allowed
 */
function createRateLimiter({ windowMs = 60_000, maxRequests = 10 } = {}) {
  /** @type {Map<string, { count: number; resetAt: number }>} */
  const windows = new Map();

  return function isAllowed(key) {
    const now = Date.now();
    const entry = windows.get(key);

    if (!entry || now >= entry.resetAt) {
      windows.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }

    if (entry.count >= maxRequests) {
      return false;
    }

    entry.count += 1;
    return true;
  };
}

const rateLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 20 });

// ---------------------------------------------------------------------------
// InMemoryRevocationStore
// ---------------------------------------------------------------------------

/**
 * Revocation store for SEP-10 bearer tokens.  A signed-off token's XDR
 * fingerprint is added here on logout so that re-presentation of the same
 * transaction is refused even before it expires naturally.
 *
 * In production, back this with Redis (SETEX <fingerprint> <ttl> 1).
 */
class InMemoryRevocationStore {
  constructor() {
    /** @type {Set<string>} */
    this._revoked = new Set();
  }

  /** @param {string} tokenFingerprint */
  revoke(tokenFingerprint) {
    this._revoked.add(tokenFingerprint);
  }

  /** @param {string} tokenFingerprint */
  isRevoked(tokenFingerprint) {
    return this._revoked.has(tokenFingerprint);
  }
}

const revocationStore = new InMemoryRevocationStore();

// ---------------------------------------------------------------------------
// ProviderRegistry — fan-out across multiple SanctionsProviders (#287)
// ---------------------------------------------------------------------------

/**
 * Aggregates multiple SanctionsProviders and returns flagged:true if ANY of
 * them flag the address.  Short-circuits on the first positive match.
 *
 * Usage mirrors a real "check-all-lists" workflow without coupling
 * syncSanctionsToDenylist to any single provider implementation.
 */
class ProviderRegistry {
  /**
   * @param {Array<{ checkAddress(addr: string): Promise<{ flagged: boolean; source: string }> }>} providers
   */
  constructor(providers) {
    if (!providers || providers.length === 0) {
      throw new Error('ProviderRegistry requires at least one provider');
    }
    this._providers = providers;
  }

  /**
   * @param {string} address
   * @returns {Promise<{ flagged: boolean; source: string }>}
   */
  async checkAddress(address) {
    for (const provider of this._providers) {
      const result = await provider.checkAddress(address);
      if (result.flagged) {
        return result; // short-circuit: one positive is enough
      }
    }
    return { flagged: false, source: 'provider-registry' };
  }
}

// ---------------------------------------------------------------------------
// Environment / configuration
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const HOME_DOMAIN = process.env.HOME_DOMAIN ?? `localhost:${PORT}`;
const NETWORK_PASSPHRASE = process.env.NETWORK_PASSPHRASE ?? Networks.TESTNET;
const CSV_SANCTIONS_PATH = process.env.CSV_SANCTIONS_PATH ?? null;
const DENYLIST_CONTRACT_ID = process.env.DENYLIST_CONTRACT_ID ?? null;
const SOROBAN_RPC_URL = process.env.SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org';
const WEBHOOK_URL = process.env.WEBHOOK_URL ?? null;
const HORIZON_START_LEDGER = process.env.HORIZON_START_LEDGER
  ? parseInt(process.env.HORIZON_START_LEDGER, 10)
  : undefined;

// Server keypair — generate a fresh ephemeral keypair if no secret is set
// so the demo starts without configuration.
const SERVER_KEYPAIR = process.env.SERVER_SECRET
  ? Keypair.fromSecret(process.env.SERVER_SECRET)
  : Keypair.random();

if (!process.env.SERVER_SECRET) {
  console.warn(
    '[demo] No SERVER_SECRET set — generated ephemeral keypair:',
    SERVER_KEYPAIR.publicKey(),
    '(challenges will not survive restarts)',
  );
}

// ---------------------------------------------------------------------------
// Sanctions provider setup — ProviderRegistry over CSV + Mock (#287)
// ---------------------------------------------------------------------------

const providers = [new MockSanctionsProvider()];

if (CSV_SANCTIONS_PATH) {
  try {
    providers.unshift(new CsvSanctionsProvider(CSV_SANCTIONS_PATH));
    console.info(`[demo] CsvSanctionsProvider loaded from: ${CSV_SANCTIONS_PATH}`);
  } catch (err) {
    console.warn(`[demo] Could not load CSV provider (${err.message}); falling back to mock only`);
  }
} else {
  console.info('[demo] CSV_SANCTIONS_PATH not set — using MockSanctionsProvider only');
}

const providerRegistry = new ProviderRegistry(providers);

// DenylistWriter — real RPC writer if contract/key are set, otherwise a no-op
let denylistWriter;
if (DENYLIST_CONTRACT_ID && process.env.SERVER_SECRET) {
  denylistWriter = createRpcDenylistWriter({
    rpcUrl: SOROBAN_RPC_URL,
    networkPassphrase: NETWORK_PASSPHRASE,
    contractId: DENYLIST_CONTRACT_ID,
    sourceKeypair: SERVER_KEYPAIR,
  });
  console.info(`[demo] Live RPC denylist writer targeting contract: ${DENYLIST_CONTRACT_ID}`);
} else {
  // Dry-run no-op writer — safe default when contract isn't configured
  denylistWriter = {
    async addToDenylist(address) {
      console.log(`[demo][dry-run] would add to denylist: ${address}`);
      return { hash: 'dry-run-no-op' };
    },
  };
  console.info('[demo] No DENYLIST_CONTRACT_ID — denylist writer is in dry-run mode');
}

// ---------------------------------------------------------------------------
// Horizon listener setup (#286 metrics + #287 showcase)
// ---------------------------------------------------------------------------

let horizonListener = null;

if (DENYLIST_CONTRACT_ID) {
  const eventSource = new RpcEventSource({
    rpcUrl: SOROBAN_RPC_URL,
    networkPassphrase: NETWORK_PASSPHRASE,
    contractIds: [DENYLIST_CONTRACT_ID],
    startLedger: HORIZON_START_LEDGER,
  });

  const webhookSender = WEBHOOK_URL
    ? new HttpWebhookSender({ url: WEBHOOK_URL })
    : {
        async send(event) {
          console.info('[demo][horizon] event (no webhook configured):', JSON.stringify(event));
        },
      };

  horizonListener = new HorizonListener({
    eventSource,
    async onEvent(event) {
      horizonEventsReceived.labels(event.contractId ?? 'unknown').inc();
      try {
        await webhookSender.send(event);
      } catch (err) {
        horizonWebhookErrors.inc();
        console.error('[demo][horizon] webhook send error:', err.message);
      }
    },
    pollIntervalMs: 10_000,
    maxRetries: 5,
    logger: {
      debug: (...a) => console.debug('[horizon]', ...a),
      info: (...a) => console.info('[horizon]', ...a),
      warn: (...a) => console.warn('[horizon]', ...a),
      error: (...a) => console.error('[horizon]', ...a),
    },
  });

  console.info('[demo] HorizonListener configured — call /admin/listener/start to begin polling');
} else {
  console.info('[demo] No DENYLIST_CONTRACT_ID — HorizonListener disabled');
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use(bodyParser.json());

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', serverPublicKey: SERVER_KEYPAIR.publicKey() });
});

// ---------------------------------------------------------------------------
// SEP-10: issue a challenge (#287 — showcase generateChallenge)
// ---------------------------------------------------------------------------

app.get('/auth', (req, res) => {
  const clientAddress = req.query.account;
  if (!clientAddress || typeof clientAddress !== 'string') {
    return res.status(400).json({ error: 'missing ?account= query param' });
  }

  // Rate-limit by IP
  const ip = req.ip ?? 'unknown';
  if (!rateLimiter(ip)) {
    sep10AuthTotal.labels('rate_limited').inc();
    return res.status(429).json({ error: 'too_many_requests', retryAfter: 60 });
  }

  try {
    const challenge = generateChallenge(clientAddress, SERVER_KEYPAIR, {
      homeDomain: HOME_DOMAIN,
      networkPassphrase: NETWORK_PASSPHRASE,
    });

    sep10ChallengesTotal.inc();
    return res.json({
      transaction: challenge.transactionXDR,
      network_passphrase: challenge.networkPassphrase,
      expires_at: challenge.expiresAt.toISOString(),
    });
  } catch (err) {
    return res.status(400).json({ error: 'challenge_error', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// SEP-10: verify a signed challenge and return the authenticated address
// (showcases InMemoryRevocationStore check before verifyChallenge — #287)
// ---------------------------------------------------------------------------

app.post('/auth', (req, res) => {
  const { transaction } = req.body ?? {};
  if (!transaction) {
    return res.status(400).json({ error: 'missing transaction in request body' });
  }

  // Rate-limit auth attempts by IP to slow brute-force replays
  const ip = req.ip ?? 'unknown';
  if (!rateLimiter(ip)) {
    sep10AuthTotal.labels('rate_limited').inc();
    return res.status(429).json({ error: 'too_many_requests', retryAfter: 60 });
  }

  // Check revocation store before doing the cryptographic verify
  if (revocationStore.isRevoked(transaction)) {
    sep10AuthTotal.labels('revoked').inc();
    return res.status(401).json({ error: 'token_revoked' });
  }

  const result = verifyChallenge(transaction, {
    serverAccountId: SERVER_KEYPAIR.publicKey(),
    networkPassphrase: NETWORK_PASSPHRASE,
    homeDomains: HOME_DOMAIN,
    webAuthDomain: HOME_DOMAIN,
  });

  if (!result.valid) {
    sep10AuthTotal.labels('failure').inc();
    return res.status(401).json({ error: 'unauthorized', reason: result.error });
  }

  sep10AuthTotal.labels('success').inc();
  return res.json({ address: result.address });
});

// ---------------------------------------------------------------------------
// SEP-10: revoke a token (logout) — demonstrates InMemoryRevocationStore (#287)
// ---------------------------------------------------------------------------

app.post('/auth/revoke', (req, res) => {
  const { transaction } = req.body ?? {};
  if (!transaction) {
    return res.status(400).json({ error: 'missing transaction in request body' });
  }
  revocationStore.revoke(transaction);
  return res.json({ revoked: true });
});

// ---------------------------------------------------------------------------
// Sanctions: check a single address against the ProviderRegistry (#287)
// ---------------------------------------------------------------------------

app.get('/sanctions/check', async (req, res) => {
  const address = req.query.address;
  if (!address || typeof address !== 'string') {
    return res.status(400).json({ error: 'missing ?address= query param' });
  }

  try {
    const result = await providerRegistry.checkAddress(address);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: 'provider_error', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// Sanctions: trigger a full sync run against the denylist contract (#287)
// ---------------------------------------------------------------------------

app.post('/sanctions/sync', async (req, res) => {
  const { addresses, dryRun = true } = req.body ?? {};

  if (!Array.isArray(addresses) || addresses.length === 0) {
    return res.status(400).json({ error: 'body must include a non-empty addresses array' });
  }

  const start = Date.now();

  try {
    const syncResult = await syncSanctionsToDenylist({
      provider: providerRegistry,
      addresses,
      writer: denylistWriter,
      dryRun,
    });

    const durationMs = Date.now() - start;
    sanctionsSyncTotal.labels('success').inc();
    sanctionsFlaggedAddresses.set(syncResult.flagged.length);
    sanctionsSyncDurationMs.observe(durationMs);

    return res.json({ ...syncResult, durationMs });
  } catch (err) {
    sanctionsSyncTotal.labels('error').inc();
    return res.status(500).json({ error: 'sync_error', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// Horizon listener admin controls
// ---------------------------------------------------------------------------

// Gate every /admin/* route: rate-limit by IP, then require a shared secret in
// the X-Admin-Token header (ADMIN_TOKEN env var). Fails closed when the env var
// is unset so the routes are never exposed by accident.
function requireAdminToken(req, res, next) {
  const ip = req.ip ?? 'unknown';
  if (!rateLimiter(ip)) {
    return res.status(429).json({ error: 'too_many_requests', retryAfter: 60 });
  }

  const expected = process.env.ADMIN_TOKEN;
  if (!expected) {
    return res.status(503).json({ error: 'admin_disabled', detail: 'ADMIN_TOKEN is not configured' });
  }

  const provided = req.get('X-Admin-Token');
  const expectedHash = crypto.createHash('sha256').update(expected).digest();
  const providedHash = crypto.createHash('sha256').update(typeof provided === 'string' ? provided : '').digest();
  if (!provided || !crypto.timingSafeEqual(expectedHash, providedHash)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  return next();
}

app.use('/admin', requireAdminToken);

app.post('/admin/listener/start', async (req, res) => {
  if (!horizonListener) {
    return res.status(503).json({ error: 'HorizonListener not configured (missing DENYLIST_CONTRACT_ID)' });
  }
  // Fire and forget — listener runs in background
  horizonListener.start().catch((err) => {
    console.error('[demo][horizon] listener stopped with error:', err.message);
  });
  return res.json({ status: 'started' });
});

app.post('/admin/listener/stop', (_req, res) => {
  if (!horizonListener) {
    return res.status(503).json({ error: 'HorizonListener not configured' });
  }
  horizonListener.stop();
  return res.json({ status: 'stopped' });
});

// ---------------------------------------------------------------------------
// Prometheus /metrics endpoint (#286)
// ---------------------------------------------------------------------------

app.get('/metrics', async (_req, res) => {
  try {
    const metrics = await registry.metrics();
    res.set('Content-Type', registry.contentType);
    res.end(metrics);
  } catch (err) {
    res.status(500).end(err.message);
  }
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

if (require.main === module) {
  app.listen(PORT, () => {
    console.info(`\n[demo] compliance-adapters full-stack demo running on http://localhost:${PORT}`);
    console.info('[demo] Available endpoints:');
    console.info('  GET  /health                   — liveness check');
    console.info('  GET  /auth?account=G…          — issue SEP-10 challenge');
    console.info('  POST /auth                     — verify signed challenge');
    console.info('  POST /auth/revoke              — revoke a bearer token');
    console.info('  GET  /sanctions/check?address= — check an address via ProviderRegistry');
    console.info('  POST /sanctions/sync           — run a full sanctions sync');
    console.info('  POST /admin/listener/start     — start Horizon event listener');
    console.info('  POST /admin/listener/stop      — stop Horizon event listener');
    console.info('  GET  /metrics                  — Prometheus metrics\n');
  });
}

module.exports = { app, revocationStore, providerRegistry, rateLimiter };
