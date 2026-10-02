/**
 * Copyright (c) 2026 stellar-compliance-kit
 * SPDX-License-Identifier: MIT
 */

import { Keypair, Networks, WebAuth } from '@stellar/stellar-sdk';
import { type Logger, noopLogger } from '@compliance-adapters/logger';
import { isValidStellarAddress } from '@compliance-adapters/shared';

export class InvalidClientAddressError extends Error {
  constructor(address: string) {
    super(`Invalid client address: ${address}`);
    this.name = 'InvalidClientAddressError';
  }
}

export class InvalidMemoError extends Error {
  constructor(memo: string) {
    super(`Invalid memo: "${memo}" must be a numeric string representing a 64-bit unsigned integer`);
    this.name = 'InvalidMemoError';
  }
}

export class InvalidDomainError extends Error {
  constructor(name: string, value: string) {
    super(
      `sep10-auth: ${name} must be a bare domain (no scheme, path, or whitespace), got "${value}"`,
    );
    this.name = 'InvalidDomainError';
  }
}

export class ServerKeypairCannotSignError extends Error {
  constructor() {
    super(
      'sep10-auth: serverKeypair cannot sign — provide a keypair with a secret key, not a public-key-only keypair',
    );
    this.name = 'ServerKeypairCannotSignError';
  }
}

const MAX_UINT64 = 2n ** 64n - 1n;

/**
 * Throws {@link InvalidDomainError} when `value` is not a bare domain, i.e. it
 * contains a URL scheme (`://`), a `/`, or whitespace, as SEP-10 requires for
 * `home_domain` and `web_auth_domain`.
 */
export function assertBareDomain(name: string, value: string): void {
  if (/:\/\/|\/|\s/.test(value)) {
    throw new InvalidDomainError(name, value);
  }
}

export interface GenerateChallengeOptions {
  homeDomain?: string;
  webAuthDomain?: string;
  networkPassphrase?: string;
  timeoutSeconds?: number;
  memo?: string | null;
  /**
   * The wallet's client domain, as supplied in the SEP-10 `client_domain`
   * request parameter. When set, the challenge transaction includes an
   * additional `client_domain` ManageData operation (sourced from
   * {@link GenerateChallengeOptions.clientSigningKey}) that the wallet's
   * client-domain server must co-sign alongside the client's own key.
   * Requires {@link GenerateChallengeOptions.clientSigningKey} to also be set.
   */
  clientDomain?: string;
  /**
   * The `SIGNING_KEY` published on `<clientDomain>/.well-known/stellar.toml`.
   * The caller is responsible for resolving this value; this package does not
   * fetch stellar.toml itself. Required when {@link GenerateChallengeOptions.clientDomain} is set.
   */
  clientSigningKey?: string;
  logger?: Logger;
}

/**
 * The result of {@link generateChallenge}.
 */
export interface GeneratedChallenge {
  /** Base64-encoded XDR of the unsigned (server-signed only) challenge transaction, to be sent to the client for signing. */
  transactionXDR: string;
  /** The network passphrase the challenge transaction was built for. Must be passed back into {@link verifyChallenge} unchanged. */
  networkPassphrase: string;
  /** When the challenge stops being valid, derived from `timeoutSeconds`. A signed challenge submitted after this time will fail verification. */
  expiresAt: Date;
}

const DEFAULT_HOME_DOMAIN = 'localhost:3000';
const DEFAULT_TIMEOUT_SECONDS = 300;

// Takes the server's Keypair (not just its public address) because building
// and signing the SEP-10 challenge transaction requires the server's secret key.
export function generateChallenge(
  clientAddress: string,
  serverKeypair: Keypair,
  options: GenerateChallengeOptions = {},
): GeneratedChallenge {
  if (!serverKeypair.canSign()) {
    throw new ServerKeypairCannotSignError();
  }

  if (!isValidStellarAddress(clientAddress)) {
    throw new InvalidClientAddressError(clientAddress);
  }

  const logger = options.logger ?? noopLogger;
  const homeDomain = options.homeDomain ?? DEFAULT_HOME_DOMAIN;
  const webAuthDomain = options.webAuthDomain ?? homeDomain;

  if (!options.homeDomain && process.env.NODE_ENV === 'production') {
    logger.warn(
      `sep10-auth: generateChallenge is using the default homeDomain "${DEFAULT_HOME_DOMAIN}" ` +
        'in a production environment. Pass an explicit `homeDomain` option matching your deployed domain.',
      { homeDomain: DEFAULT_HOME_DOMAIN },
    );
  }
  assertBareDomain('homeDomain', homeDomain);
  assertBareDomain('webAuthDomain', webAuthDomain);

  if (options.memo != null && (!/^\d+$/.test(options.memo) || BigInt(options.memo) > MAX_UINT64)) {
    throw new InvalidMemoError(options.memo);
  }

  const networkPassphrase = options.networkPassphrase ?? Networks.TESTNET;
  const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;

  logger.debug('sep10-auth: generating challenge', { clientAddress, homeDomain, webAuthDomain });

  const transactionXDR = WebAuth.buildChallengeTx(
    serverKeypair,
    clientAddress,
    homeDomain,
    timeoutSeconds,
    networkPassphrase,
    webAuthDomain,
    options.memo ?? null,
    options.clientDomain ?? null,
    options.clientSigningKey ?? null,
  );

  const expiresAt = new Date(Date.now() + timeoutSeconds * 1000);
  logger.info('sep10-auth: challenge generated', { clientAddress, expiresAt });

  return {
    transactionXDR,
    networkPassphrase,
    expiresAt,
  };
}
