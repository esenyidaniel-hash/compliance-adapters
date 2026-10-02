/**
 * Copyright (c) 2026 stellar-compliance-kit
 * SPDX-License-Identifier: MIT
 */

import * as fs from 'fs';
import {
  Contract,
  Keypair,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  rpc,
} from '@stellar/stellar-sdk';
import { isValidStellarAddress } from '@compliance-adapters/shared';
import { type Logger, noopLogger, consoleLogger } from '@compliance-adapters/logger';
export type { Logger } from '@compliance-adapters/logger';
import { SanctionsProvider } from './SanctionsProvider';
import { SyncCheckpointStore } from './checkpoint';
import { MockSanctionsProvider } from './mockProvider';
import { CsvSanctionsProvider } from './csvProvider';
import { RateLimitedSanctionsProvider } from './rateLimitedProvider';
import { type AnyTracer, NoopTracer } from './tracing';
import { type AnyMetricsRegistry, NoopMetricsRegistry } from './metrics';
import { withRetry, RetryOptions } from './retry';
import { computeBackoffDelayMs, BackoffOptions } from '@compliance-adapters/backoff';

interface CacheEntry {
  result: { flagged: boolean; source: string };
  timestamp: number;
}

/**
 * Optional cache layer for SanctionsProvider results.
 * Avoids redundant provider calls for addresses checked recently.
 */
export class ProviderResultCache {
  private cache: Map<string, CacheEntry> = new Map();
  private readonly ttlMs: number;
  private readonly maxEntries?: number;
  private readonly inFlight = new Map<string, Promise<{ flagged: boolean; source: string }>>();

  /**
   * Create a result cache with a specified time-to-live (TTL).
   * @param ttlMs Time-to-live for cached results in milliseconds
   * @param maxEntries Optional maximum number of entries to retain. When set,
   * the least-recently-used entry is evicted once the cache would exceed this size.
   */
  constructor(ttlMs: number = 3600000, maxEntries?: number) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  /**
   * Get a cached result if available and not expired.
   * @returns The cached result, or undefined if not found or expired
   */
  get(address: string): { flagged: boolean; source: string } | undefined {
    const entry = this.cache.get(address);
    if (!entry) return undefined;

    const now = Date.now();
    if (now - entry.timestamp > this.ttlMs) {
      this.cache.delete(address);
      return undefined;
    }

    // Refresh recency for LRU eviction.
    this.cache.delete(address);
    this.cache.set(address, entry);

    return entry.result;
  }

  /**
   * Store a result in the cache.
   */
  set(address: string, result: { flagged: boolean; source: string }): void {
    this.cache.delete(address);
    this.cache.set(address, {
      result,
      timestamp: Date.now(),
    });

    if (this.maxEntries !== undefined) {
      while (this.cache.size > this.maxEntries) {
        const oldestKey = this.cache.keys().next().value;
        if (oldestKey === undefined) break;
        this.cache.delete(oldestKey);
      }
    }
  }

  /**
   * Remove a single cached entry, e.g. after an operator determines it's stale.
   * @returns Whether an entry was present and removed.
   */
  delete(address: string): boolean {
    return this.cache.delete(address);
  }

  /**
   * Retrieve a cached result or coalesce concurrent misses behind a single
   * in-flight promise, so concurrent lookups for the same address do not race to
   * populate the cache with duplicate provider calls.
   */
  async getOrLoad(
    address: string,
    load: () => Promise<{ flagged: boolean; source: string }>,
  ): Promise<{ flagged: boolean; source: string }> {
    const cached = this.get(address);
    if (cached) {
      return cached;
    }

    const existing = this.inFlight.get(address);
    if (existing) {
      return existing;
    }

    let resolve!: (value: { flagged: boolean; source: string }) => void;
    let reject!: (reason?: unknown) => void;
    const next = new Promise<{ flagged: boolean; source: string }>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    this.inFlight.set(address, next);

    (async () => {
      try {
        const result = await load();
        this.set(address, result);
        resolve(result);
      } catch (error) {
        reject(error);
      } finally {
        const current = this.inFlight.get(address);
        if (current === next) {
          this.inFlight.delete(address);
        }
      }
    })();

    return next;
  }

  /**
   * Clear all cached entries.
   */
  clear(): void {
    this.cache.clear();
    this.inFlight.clear();
  }
}

export interface AuditLogEntry {
  /** The address added to the denylist. */
  address: string;
  /** Timestamp when the write occurred (ISO 8601 string). */
  timestamp: string;
  /** The source watchlist that flagged the address. */
  source: string;
  /** The transaction hash resulting from the write. */
  txHash: string;
}

export type AuditLogger = (entry: AuditLogEntry) => void | Promise<void>;

export interface DenylistWriter {
  addToDenylist(address: string): Promise<{ hash: string }>;
}

export interface SyncOptions {
  provider: SanctionsProvider;
  /**
   * Candidate addresses to check. In a real deployment this might come
   * from a chain scan or an existing account list; here it's just an
   * injected array so this function stays pure and easily testable
   * without a network dependency.
   */
  addresses: string[];
  writer: DenylistWriter;
  dryRun?: boolean;
  /** Retry-with-backoff config applied around each provider.checkAddress call. */
  retry?: RetryOptions;
  /**
   * Optional cache to avoid redundant provider lookups for recently checked addresses.
   * If provided, results are cached with a configurable TTL.
   */
  cache?: ProviderResultCache;
  /**
   * Optional logger for progress logging during large address syncs.
   * If provided, logs will be emitted periodically (every progressInterval addresses).
   */
  logger?: Logger;
  /**
   * Number of addresses to process before emitting a progress log.
   * Defaults to 100 if logger is provided.
   */
  progressInterval?: number;
  /**
   * Optional concurrency limit for provider.checkAddress calls.
   * If provided, limits the number of concurrent address checks.
   * Defaults to unlimited (sequential processing).
   */
  concurrency?: number;
  /**
   * Optional current denylist contents. When provided, flagged addresses that
   * are already present in the current denylist are still reported as flagged,
   * but they are skipped during the actual write phase.
   */
  currentDenylist?: string[];
  /**
   * Optional metrics registry.  Pass a `MetricsRegistry` instance to record
   * per-phase counters and latency histograms for `address_check` and
   * `denylist_write` operations.  When omitted all instrumentation is a no-op.
   */
  metrics?: AnyMetricsRegistry;
  /**
   * Optional tracer for OpenTelemetry-compatible distributed tracing.
   * When omitted, a no-op tracer is used — zero overhead and no exports.
   *
   * Stellar addresses are NOT attached to spans unless
   * `TracingOptions.redactPayload` is explicitly set to `false` on the
   * tracer; the span will carry only phase and outcome attributes.
   */
  tracer?: AnyTracer;
  /**
   * Optional checkpoint store that makes a large sync resumable after a crash.
   * As each address is finished, it is recorded via `checkpoint.markComplete`
   * (clean addresses right after the provider check; flagged addresses only
   * once the denylist write succeeds). Pass {@link SyncOptions.resume} on a
   * later run to skip everything already recorded.
   */
  checkpoint?: SyncCheckpointStore;
  /**
   * When true and a {@link SyncOptions.checkpoint} is provided, addresses the
   * checkpoint already reports as complete are skipped (returned in
   * {@link SyncResult.skipped}) instead of being re-checked and re-written.
   * Defaults to false.
   */
  resume?: boolean;
}

/**
 * A single address whose provider check failed on every retry attempt,
 * paired with the message from the last error that caused it to fail.
 */
export interface FailedAddress {
  address: string;
  /** Message of the final error thrown by `provider.checkAddress` (after retries). */
  error: string;
}

/**
 * Result of a sanctions sync operation.
 */
export interface SyncResult {
  /** Total number of candidate addresses checked against the provider. */
  checked: number;
  /** Addresses flagged by the sanctions provider. */
  flagged: string[];
  /** Addresses successfully written to the denylist (empty if dryRun is true). */
  written: string[];
  /**
   * Addresses whose provider check failed on every retry attempt.
   *
   * This is kept as a bare `string[]` for backward compatibility; use
   * {@link SyncResult.failedWithReasons} when you need the error message that
   * caused each failure (e.g. to distinguish rate-limit failures from genuine
   * provider errors programmatically).
   */
  failed: string[];
  /**
   * The same addresses as {@link SyncResult.failed}, each paired with the
   * message of the final error that caused it to fail.
   */
  failedWithReasons: FailedAddress[];
  /**
   * Input entries that are not valid Stellar Ed25519 public keys (StrKey
   * `G...`). These are never checked against the provider — a malformed entry
   * (typo, truncated paste, a non-Stellar identifier) is reported here rather
   * than silently landing in neither `flagged` nor `failed`.
   */
  invalid: string[];
  /**
   * Addresses skipped because a {@link SyncOptions.checkpoint} already recorded
   * them as complete and {@link SyncOptions.resume} was set. Empty otherwise.
   */
  skipped: string[];
  /** Whether this was a dry-run (read-only) operation. */
  dryRun: boolean;
}

interface FlaggedAddressWithSource {
  address: string;
  source: string;
}

async function executeConcurrent<T>(
  items: T[],
  fn: (item: T) => Promise<void>,
  concurrency?: number,
): Promise<void> {
  if (!concurrency || concurrency >= items.length) {
    for (const item of items) {
      await fn(item);
    }
    return;
  }

  const queue = [...items];
  const active: Promise<void>[] = [];

  while (queue.length > 0 || active.length > 0) {
    while (active.length < concurrency && queue.length > 0) {
      const item = queue.shift()!;
      const promise = fn(item).then(() => {
        active.splice(active.indexOf(promise), 1);
      });
      active.push(promise);
    }

    if (active.length > 0) {
      await Promise.race(active);
    }
  }
}

export async function syncSanctionsToDenylist(options: SyncOptions): Promise<SyncResult> {
  const {
    provider,
    addresses,
    writer,
    dryRun = false,
    logger = noopLogger,
    retry,
    cache,
    progressInterval = 100,
    concurrency,
    currentDenylist = [],
    metrics = new NoopMetricsRegistry(),
    tracer = new NoopTracer(),
    checkpoint,
    resume = false,
  } = options;

  const legacyLogger = logger as Logger & { log?: (...args: unknown[]) => void };
  const safeLogger = {
    debug: (...args: unknown[]) =>
      typeof legacyLogger.debug === 'function' ? legacyLogger.debug(...args) : legacyLogger.log?.(...args),
    info: (...args: unknown[]) =>
      typeof legacyLogger.info === 'function' ? legacyLogger.info(...args) : legacyLogger.log?.(...args),
    warn: (...args: unknown[]) =>
      typeof legacyLogger.warn === 'function' ? legacyLogger.warn(...args) : legacyLogger.log?.(...args),
    error: (...args: unknown[]) =>
      typeof legacyLogger.error === 'function' ? legacyLogger.error(...args) : legacyLogger.log?.(...args),
  };
  const progressLogger = (message: string) => {
    if (typeof (logger as Logger & { log?: (...args: unknown[]) => void }).log === 'function') {
      (logger as Logger & { log?: (...args: unknown[]) => void }).log!(message);
      return;
    }
    safeLogger.debug(message);
  };

  safeLogger.info('sanctions-oracle: starting sync', { total: addresses.length, dryRun });

  const uniqueAddresses = Array.from(new Set(addresses));

  // Reject malformed input up front so a typo / truncated paste / non-Stellar
  // identifier is reported distinctly instead of being checked and quietly
  // landing in neither `flagged` nor `failed`.
  const invalid: string[] = [];
  const validAddresses: string[] = [];
  for (const address of uniqueAddresses) {
    if (isValidStellarAddress(address)) {
      validAddresses.push(address);
    } else {
      invalid.push(address);
    }
  }
  if (invalid.length > 0) {
    safeLogger.warn('sanctions-oracle: skipping malformed addresses', { count: invalid.length });
  }

  // On a resume run, drop anything a prior run already finished.
  const skipped: string[] = [];
  let pendingAddresses = validAddresses;
  if (resume && checkpoint) {
    pendingAddresses = [];
    for (const address of validAddresses) {
      if (await checkpoint.isComplete(address)) {
        skipped.push(address);
      } else {
        pendingAddresses.push(address);
      }
    }
    if (skipped.length > 0) {
      safeLogger.info('sanctions-oracle: resuming sync', {
        skipped: skipped.length,
        pending: pendingAddresses.length,
      });
    }
  }

  const currentDenylistSet = new Set(currentDenylist);
  const inflightChecks = new Map<string, Promise<{ flagged: boolean; source: string }>>();
  const flagged: string[] = [];
  const flaggedWithSource: FlaggedAddressWithSource[] = [];
  const failed: string[] = [];
  const failedWithReasons: FailedAddress[] = [];
  let checked = 0;

  const getAddressResult = async (address: string): Promise<{ flagged: boolean; source: string }> => {
    if (cache) {
      return cache.getOrLoad(address, () => withRetry(() => provider.checkAddress(address), retry));
    }

    const cached = inflightChecks.get(address);
    if (cached) {
      return cached;
    }

    let resolve!: (value: { flagged: boolean; source: string }) => void;
    let reject!: (reason?: unknown) => void;
    const pending = new Promise<{ flagged: boolean; source: string }>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    inflightChecks.set(address, pending);

    (async () => {
      try {
        const result = await withRetry(() => provider.checkAddress(address), retry);
        resolve(result);
      } catch (error) {
        reject(error);
      } finally {
        if (inflightChecks.get(address) === pending) {
          inflightChecks.delete(address);
        }
      }
    })();

    return pending;
  };

  await executeConcurrent(
    pendingAddresses,
    async (address) => {
      const start = Date.now();
      const span = tracer.startSpan('address_check');
      // address is omitted from spans by default (privacy / cardinality).
      span.setAttribute('address_check.index', addresses.indexOf(address));
      try {
        const result = await getAddressResult(address);
        const durationMs = Date.now() - start;
        metrics.counter.inc('address_check', 'success');
        metrics.histogram.observe('address_check', durationMs);
        span.setAttribute('address_check.flagged', result.flagged);
        span.end('ok');
        if (result.flagged) {
          flagged.push(address);
          flaggedWithSource.push({ address, source: result.source });
        } else {
          // Clean address: nothing left to do for it, so it can be checkpointed
          // now. Flagged addresses are checkpointed only after a successful
          // write (below) so an interrupted write is retried on resume.
          await checkpoint?.markComplete(address);
        }
      } catch (err) {
        const durationMs = Date.now() - start;
        metrics.counter.inc('address_check', 'failure');
        metrics.histogram.observe('address_check', durationMs);
        span.end('error', err instanceof Error ? err : new Error(String(err)));
        failed.push(address);
        failedWithReasons.push({
          address,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        checked += 1;
        if (checked % progressInterval === 0) {
          progressLogger(`Progress: ${checked}/${uniqueAddresses.length} addresses checked`);
        }
      }
    },
    concurrency,
  );

safeLogger.info('sanctions-oracle: screening complete', {
    checked: addresses.length,
    flagged: flagged.length,
  });

  const written: string[] = [];
  if (dryRun) {
    for (const { address } of flaggedWithSource) {
      if (currentDenylistSet.has(address)) {
        continue;
      }
      safeLogger.info('sanctions-oracle: [dry-run] would call add_to_denylist', { address });
    }
  } else {
    const currentDenylistSet = new Set(currentDenylist);
    for (const { address, source } of flaggedWithSource) {
      if (currentDenylistSet.has(address)) {
        continue;
      }
      const start = Date.now();
      const span = tracer.startSpan('denylist_write');
      try {
        // Call writer with extended interface if available
        const writerExt = writer as DenylistWriter & {
          addToDenylistWithSource?: (
            address: string,
            source: string,
          ) => Promise<{ hash: string; auditLog?: AuditLogEntry }>;
        };
        let result: { hash: string; auditLog?: AuditLogEntry };
        if (writerExt.addToDenylistWithSource) {
          result = await writerExt.addToDenylistWithSource(address, source);
        } else {
          result = await writer.addToDenylist(address);
        }
        const durationMs = Date.now() - start;
        metrics.counter.inc('denylist_write', 'success');
        metrics.histogram.observe('denylist_write', durationMs);
        // transaction hash is set after success — it's a stable, non-PII identifier
        span.setAttribute('denylist_write.tx_hash', result.hash);
        span.end('ok');
        written.push(address);
        await checkpoint?.markComplete(address);
        safeLogger.info('sanctions-oracle: address written to denylist', {
          address,
          hash: result.hash,
        });
      } catch (err) {
        const durationMs = Date.now() - start;
        metrics.counter.inc('denylist_write', 'failure');
        metrics.histogram.observe('denylist_write', durationMs);
        span.end('error', err instanceof Error ? err : new Error(String(err)));
        if (written.length > 0) {
          continue;
        }
        throw err;
      }
    }
  }

  return {
    checked: pendingAddresses.length,
    flagged,
    written,
    failed,
    failedWithReasons,
    invalid,
    skipped,
    dryRun,
  };
}

export interface RpcDenylistWriterOptions {
  rpcUrl: string;
  networkPassphrase: string;
  contractId: string;
  sourceKeypair: Keypair;
  /**
   * Optional audit logger to record each denylist write for compliance purposes.
   * Called with address, timestamp, source, and resulting transaction hash.
   */
  auditLogger?: AuditLogger;
  /**
   * Optional maximum number of retry attempts for sendTransaction.
   * Defaults to 3.
   */
  maxRetries?: number;
  /**
   * Optional backoff options for retry delays.
   */
  backoffOptions?: BackoffOptions;
  /**
   * Optional logger used to record an audit-logging failure without failing
   * the write it accompanies. Defaults to a no-op logger.
   */
  logger?: Logger;
}

// Kept behind the DenylistWriter interface (rather than called directly
// from syncSanctionsToDenylist) so tests can inject a fake writer instead
// of touching a live RPC endpoint.
export function createRpcDenylistWriter(options: RpcDenylistWriterOptions): DenylistWriter & {
  addToDenylistWithSource?: (
    address: string,
    source: string,
  ) => Promise<{ hash: string; auditLog?: AuditLogEntry }>;
} {
  const {
    rpcUrl,
    networkPassphrase,
    contractId,
    sourceKeypair,
    auditLogger,
    maxRetries = 3,
    backoffOptions,
    logger = noopLogger,
  } = options;
  const server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });
  const contract = new Contract(contractId);

  // Shared by both public methods below so the retry/backoff behavior around
  // sendTransaction can't drift between the audited and non-audited paths.
  async function buildPrepareSignAndSend(address: string): Promise<{ hash: string }> {
    const account = await server.getAccount(sourceKeypair.publicKey());

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(contract.call('add_to_denylist', nativeToScVal(address, { type: 'address' })))
      .setTimeout(30)
      .build();

    let prepared;
    try {
      prepared = await server.prepareTransaction(tx);
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to prepare transaction (simulation error): ${err}`);
    }

    prepared.sign(sourceKeypair);

    let lastError;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const sendResult = await server.sendTransaction(prepared);
        return { hash: sendResult.hash };
      } catch (error) {
        lastError = error;
        if (attempt < maxRetries - 1) {
          const delayMs = computeBackoffDelayMs(attempt, backoffOptions);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }

    const err = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`Failed to send transaction after ${maxRetries} attempts: ${err}`);
  }

  return {
    async addToDenylist(address: string): Promise<{ hash: string }> {
      return buildPrepareSignAndSend(address);
    },
    async addToDenylistWithSource(
      address: string,
      source: string,
    ): Promise<{ hash: string; auditLog?: AuditLogEntry }> {
      const { hash } = await buildPrepareSignAndSend(address);

      const auditEntry: AuditLogEntry = {
        address,
        timestamp: new Date().toISOString(),
        source,
        txHash: hash,
      };

      if (auditLogger) {
        try {
          await auditLogger(auditEntry);
        } catch (error) {
          // The on-chain write above already succeeded — an audit-logging
          // failure must not fail this address's write or propagate up
          // through syncSanctionsToDenylist's write loop.
          logger.error?.('sanctions-oracle: audit logger failed after successful denylist write', {
            address,
            txHash: hash,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return { hash, auditLog: auditEntry };
    },
  };
}

export interface CliArgs {
  addressesPath?: string;
  dryRun: boolean;
  contractId?: string;
  rpcUrl?: string;
  networkPassphrase?: string;
  secretKey?: string;
  help?: boolean;
  /** Path to a CSV file of flagged addresses, used to build a CsvSanctionsProvider. */
  csvPath?: string;
  /** Path to a module exporting a SanctionsProvider-compatible default export. */
  providerModulePath?: string;
  /** Wrap the selected provider with RateLimitedSanctionsProvider's backoff/concurrency protection. */
  rateLimit?: boolean;
}

/**
 * Returns a copy of `args` safe for logging, with `secretKey` masked.
 * Use this instead of logging the raw `CliArgs` object.
 */
export function toSafeLogString(args: CliArgs): string {
  return JSON.stringify({ ...args, secretKey: args.secretKey ? '[REDACTED]' : undefined });
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--addresses':
        args.addressesPath = argv[++i];
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--contract-id':
        args.contractId = argv[++i];
        break;
      case '--rpc-url':
        args.rpcUrl = argv[++i];
        break;
      case '--network-passphrase':
        args.networkPassphrase = argv[++i];
        break;
      case '--secret-key':
        args.secretKey = argv[++i];
        break;
      case '--csv':
        args.csvPath = argv[++i];
        break;
      case '--provider-module':
        args.providerModulePath = argv[++i];
        break;
      case '--rate-limit':
        args.rateLimit = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        break;
    }
  }
  return args;
}

function printHelp(): void {
  // CLI-only: help text is written straight to stdout by convention, not routed
  // through an injectable Logger.
  // eslint-disable-next-line no-console
  console.log(`
sanctions-oracle sync - Synchronize sanctions data to a Soroban denylist

USAGE:
  sanctions-oracle sync [OPTIONS]

OPTIONS:
  --addresses <path>          Path to JSON file containing array of addresses to check
  --contract-id <id>          Soroban contract ID (required for live sync)
  --rpc-url <url>             Soroban RPC endpoint URL (required for live sync)
  --network-passphrase <str>  Network passphrase (required for live sync)
  --secret-key <key>          Source account secret key (required for live sync unless
                               SANCTIONS_ORACLE_SECRET_KEY is set; discouraged outside
                               local testing since it is visible in shell history/process lists)
  --csv <path>                Use a CsvSanctionsProvider backed by the given CSV file
  --provider-module <path>    Dynamically import a module whose default export is a
                               SanctionsProvider to use instead of the mock/CSV provider
  --rate-limit                Wrap the selected provider with RateLimitedSanctionsProvider
  --dry-run                   Preview output without writing to the contract
  --help, -h                  Show this help message

ENVIRONMENT:
  SANCTIONS_ORACLE_SECRET_KEY  Source account secret key (preferred over --secret-key)

EXAMPLES:
  # Dry-run mode: check addresses without writing
  sanctions-oracle sync --addresses addresses.json --dry-run

  # Live mode: sync flagged addresses to contract (preferred, via env var)
  SANCTIONS_ORACLE_SECRET_KEY=SBXXXX sanctions-oracle sync \\
    --addresses addresses.json \\
    --contract-id CXXXX \\
    --rpc-url https://soroban-testnet.stellar.org \\
    --network-passphrase "Test SDF Network ; September 2015"
  `);
}

export async function runCli(argv?: string[]): Promise<void> {
  // The CLI entrypoint uses consoleLogger so dry-run output and errors are
  // visible by default; programmatic callers should inject their own logger.
  const logger = consoleLogger;

  const processArgv = argv ?? process.argv.slice(2);
  const args = parseArgs(processArgv);

  if (args.help) {
    printHelp();
    return;
  }

  if (!args.addressesPath) {
    logger.error?.('sanctions-oracle: Missing required flag: --addresses <path-to-json-array>');
    process.exitCode = 1;
    return;
  }

  let addresses: string[];
  try {
    const parsed = JSON.parse(fs.readFileSync(args.addressesPath, 'utf8'));
    if (!Array.isArray(parsed)) {
      throw new Error('Addresses file must contain a JSON array');
    }
    if (!parsed.every((item) => typeof item === 'string')) {
      throw new Error('All entries in the addresses array must be strings');
    }
    const emptyStrings = parsed.filter((addr) => addr === '');
    if (emptyStrings.length > 0) {
      throw new Error(`Addresses file contains ${emptyStrings.length} empty string entries`);
    }
    const uniqueAddresses = Array.from(new Set(parsed));
    const duplicateCount = parsed.length - uniqueAddresses.length;
    if (duplicateCount > 0) {
      logger.info(`sanctions-oracle: deduplicating ${duplicateCount} duplicate addresses`);
    }
    addresses = parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(
      `sanctions-oracle: Failed to load addresses from ${args.addressesPath}: ${message}`,
    );
    process.exitCode = 1;
    return;
  }
  let provider: SanctionsProvider;
  if (args.providerModulePath) {
    try {
      const imported = await import(args.providerModulePath);
      provider = (imported.default ?? imported) as SanctionsProvider;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to load provider module ${args.providerModulePath}: ${message}`);
      process.exitCode = 1;
      return;
    }
  } else if (args.csvPath) {
    provider = new CsvSanctionsProvider(args.csvPath);
  } else {
    provider = new MockSanctionsProvider();
  }

  if (args.rateLimit) {
    provider = new RateLimitedSanctionsProvider(provider);
  }

  if (args.dryRun) {
    const result = await syncSanctionsToDenylist({
      provider,
      addresses,
      writer: {
        async addToDenylist(): Promise<{ hash: string }> {
          throw new Error('addToDenylist should not be called in dry-run mode');
        },
      },
      dryRun: true,
      logger,
    });
    logger.info('sanctions-oracle: dry-run result', result);
    // CLI-only: the machine-readable result is written to stdout so it can be
    // piped/redirected independently of the human-readable logger stream.
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Prefer the environment variable over --secret-key: CLI args are visible
  // in shell history and process listings (e.g. `ps`), which the flag alone
  // is vulnerable to.
  const secretKey = process.env.SANCTIONS_ORACLE_SECRET_KEY ?? args.secretKey;

  if (!args.contractId || !args.rpcUrl || !args.networkPassphrase || !secretKey) {
    logger.error?.(
      'sanctions-oracle: Missing required flags for a live sync. Required: --contract-id, --rpc-url, --network-passphrase, and SANCTIONS_ORACLE_SECRET_KEY (env, preferred) or --secret-key (or pass --dry-run).',
    );
    process.exitCode = 1;
    return;
  }

  const writer = createRpcDenylistWriter({
    rpcUrl: args.rpcUrl,
    networkPassphrase: args.networkPassphrase,
    contractId: args.contractId,
    sourceKeypair: Keypair.fromSecret(secretKey),
  });

  const result = await syncSanctionsToDenylist({
    provider,
    addresses,
    writer,
    dryRun: false,
    logger,
  });
  // CLI-only: machine-readable result to stdout (see dry-run branch above).
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  runCli().catch((err) => {
    // CLI-only: last-resort crash handler for the binary entrypoint; no logger
    // is in scope here.
    // eslint-disable-next-line no-console
    console.error('sanctions-oracle:', err);
    process.exitCode = 1;
  });
}
