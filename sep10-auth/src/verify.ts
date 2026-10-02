/**
 * Copyright (c) 2026 stellar-compliance-kit
 * SPDX-License-Identifier: MIT
 */

import { Networks, Operation, WebAuth } from '@stellar/stellar-sdk';
import { assertBareDomain } from './challenge';
import { isValidStellarAddress } from '@compliance-adapters/shared';

export interface VerifyChallengeOptions {
  serverAccountId: string;
  networkPassphrase?: string;
  homeDomains: string | string[];
  webAuthDomain: string | string[];
  /**
   * Optional expected memo for the signed challenge transaction. If set,
   * verification will fail if the transaction's memo does not match.
   * Useful for replay protection (e.g., tying a challenge to a specific
   * session or request ID).
   *
   * Expected encoding depends on the transaction's memo type: the plain string
   * for `text` and `id` memos, and a hex string (case-insensitive) for `hash`
   * and `return` memos.
   */
  expectedMemo?: string;
}

/**
 * Stable, documented codes identifying why {@link verifyChallenge} failed.
 *
 * Codes are intentionally coarse-grained — they identify the category of
 * failure without leaking internal exception messages. The human-readable
 * {@link VerifyResult.error} field carries the full message.
 *
 * | Code | Meaning |
 * |------|---------|
 * | `INVALID_SERVER_ACCOUNT_ID` | `serverAccountId` option is not a valid Ed25519 public key. |
 * | `INVALID_OPTIONS` | `homeDomains` or `webAuthDomain` failed format validation (bare-domain check). |
 * | `INVALID_CHALLENGE` | The XDR could not be parsed, the transaction structure is wrong, or the server signature is missing/incorrect. |
 * | `CHALLENGE_EXPIRED` | The transaction's time-bounds have lapsed (including the SDK's built-in 300-second grace window). |
 * | `WRONG_SIGNER` | The transaction was not signed by the expected client account. |
 * | `WRONG_DOMAIN` | None of the supplied `webAuthDomain` values matched the challenge. |
 * | `MEMO_MISMATCH` | `expectedMemo` was supplied but the transaction carries a different (or absent) memo. |
 * | `UNKNOWN` | An unexpected error that does not map to any of the above categories. |
 */
export type VerifyErrorCode =
  | 'INVALID_SERVER_ACCOUNT_ID'
  | 'INVALID_OPTIONS'
  | 'INVALID_CHALLENGE'
  | 'CHALLENGE_EXPIRED'
  | 'WRONG_SIGNER'
  | 'WRONG_DOMAIN'
  | 'MEMO_MISMATCH'
  | 'UNKNOWN';

/**
 * The result of {@link verifyChallenge}.
 */
export interface VerifyResult {
  /** Whether the signed challenge transaction passed all SEP-10 checks. */
  valid: boolean;
  /** The authenticated Stellar account ID (client's master key), or `''` when `valid` is `false`. */
  address: string;
  /**
   * The wallet's client domain, present only when the challenge included a
   * `client_domain` ManageData operation (see {@link
   * GenerateChallengeOptions.clientDomain | generateChallenge's clientDomain
   * option}) and that domain's signing key co-signed the transaction.
   */
  clientDomain?: string;
  /** Human-readable reason verification failed, present only when `valid` is `false`. */
  error?: string;
  /**
   * Stable error code identifying the failure category, present only when
   * `valid` is `false`. Allows callers to branch on failure reason without
   * parsing the human-readable {@link error} string.
   *
   * See {@link VerifyErrorCode} for the full set of possible values.
   */
  errorCode?: VerifyErrorCode;
}

// Buffer#toString() defaults to utf8, which mangles the raw bytes of hash/return
// memos, so those are compared as hex instead.
function encodeMemo(memo: { type: string; value: unknown }): string {
  if (memo.value === null || memo.value === undefined) return '';
  if (Buffer.isBuffer(memo.value) || memo.value instanceof Uint8Array) {
    const buf = Buffer.from(memo.value);
    return memo.type === 'hash' || memo.type === 'return' ? buf.toString('hex') : buf.toString('utf8');
  }
  return String(memo.value);
}

/**
 * Classify an SDK or internal error into a {@link VerifyErrorCode}.
 *
 * The Stellar SDK does not expose a stable error class hierarchy that is safe
 * to `instanceof`-check, so we match on well-known substrings of the
 * error message. These patterns are derived from the SDK source and are
 * intentionally conservative: any message that does not match a known pattern
 * falls through to 'UNKNOWN'.
 */
function classifyError(err: unknown): VerifyErrorCode {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();

  // Expired / timebounds
  if (msg.includes('expired') || msg.includes('timebounds') || msg.includes('time bounds')) {
    return 'CHALLENGE_EXPIRED';
  }
  // Signer-related failures
  if (
    msg.includes('no signers') ||
    msg.includes('not signed') ||
    msg.includes('signature') ||
    msg.includes('signer') ||
    msg.includes('multisig') ||
    msg.includes('signed by') ||
    msg.includes('signing key')
  ) {
    return 'WRONG_SIGNER';
  }
  // Domain confusion or web_auth_domain mismatch
  if (
    msg.includes('web_auth_domain') ||
    msg.includes('webauthdomainoperation') ||
    msg.includes('webauthdomainkeyvalue') ||
    msg.includes('home_domain') ||
    msg.includes('homedomain')
  ) {
    return 'WRONG_DOMAIN';
  }
  // XDR parsing / structural invalidity (network passphrase, malformed XDR, …)
  // Also covers memo-type constraint errors ("The transaction has a memo but…",
  // "The transaction's memo must be of type `id`") which the SDK throws as
  // InvalidChallengeError but whose messages contain neither a signer nor a
  // domain keyword.
  if (
    msg.includes('invalid') ||
    msg.includes('parse') ||
    msg.includes('xdr') ||
    msg.includes('network') ||
    msg.includes('passphrase') ||
    msg.includes('hash') ||
    msg.includes('sequence') ||
    msg.includes('source account') ||
    msg.includes('operation') ||
    msg.includes('memo')
  ) {
    return 'INVALID_CHALLENGE';
  }

  return 'UNKNOWN';
}

export function verifyChallenge(
  signedTransactionXDR: string,
  options: VerifyChallengeOptions,
): VerifyResult {
  if (!isValidStellarAddress(options.serverAccountId)) {
    return {
      valid: false,
      address: '',
      error: `sep10-auth: Invalid serverAccountId: ${options.serverAccountId}`,
      errorCode: 'INVALID_SERVER_ACCOUNT_ID',
    };
  }

  const networkPassphrase = options.networkPassphrase ?? Networks.TESTNET;
  const homeDomainList = Array.isArray(options.homeDomains)
    ? options.homeDomains
    : [options.homeDomains];
  const webAuthDomains = Array.isArray(options.webAuthDomain)
    ? options.webAuthDomain
    : [options.webAuthDomain];

  try {
    homeDomainList.forEach((d) => assertBareDomain('homeDomains', d));
    webAuthDomains.forEach((d) => assertBareDomain('webAuthDomain', d));
  } catch (error) {
    return { valid: false, address: '', error: (error as Error).message, errorCode: 'INVALID_OPTIONS' };
  }

  // The underlying SDK only matches against a single webAuthDomain per call,
  // so try each candidate in turn and succeed on the first match.
  let lastError: unknown;

  for (const webAuthDomain of webAuthDomains) {
    try {
      const { clientAccountID, tx } = WebAuth.readChallengeTx(
        signedTransactionXDR,
        options.serverAccountId,
        networkPassphrase,
        options.homeDomains,
        webAuthDomain,
      );

      // Also validates that the client_domain operation's source key (if any)
      // co-signed the transaction, per the SEP-10 client domain flow.
      WebAuth.verifyChallengeTxSigners(
        signedTransactionXDR,
        options.serverAccountId,
        networkPassphrase,
        [clientAccountID],
        options.homeDomains,
        webAuthDomain,
      );

      if (options.expectedMemo !== undefined) {
        const txMemo = encodeMemo(tx.memo);
        const isBinaryMemo = tx.memo.type === 'hash' || tx.memo.type === 'return';
        const matches = isBinaryMemo
          ? txMemo === options.expectedMemo.toLowerCase()
          : txMemo === options.expectedMemo;
        if (!matches) {
          return {
            valid: false,
            address: '',
            error: `sep10-auth: memo mismatch, expected "${options.expectedMemo}" but got "${txMemo}"`,
            errorCode: 'MEMO_MISMATCH',
          };
        }
      }

      const clientDomainOp = tx.operations.find(
        (op): op is Operation.ManageData => op.type === 'manageData' && op.name === 'client_domain',
      );
      const clientDomain = clientDomainOp?.value?.toString();

      return {
        valid: true,
        address: clientAccountID,
        ...(clientDomain ? { clientDomain } : {}),
      };
    } catch (error) {
      lastError = error;
    }
  }

  const errorCode = classifyError(lastError);
  return {
    valid: false,
    address: '',
    error: `sep10-auth: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    errorCode,
  };
}
