/**
 * Copyright (c) 2026 stellar-compliance-kit
 * SPDX-License-Identifier: MIT
 */

import { RequestHandler } from 'express';
import { StrKey } from '@stellar/stellar-sdk';
import { type Logger, noopLogger } from '@compliance-adapters/logger';
import { verifyChallenge, VerifyChallengeOptions } from './verify';
import { RevocationStore } from './revocation';
import { assertBareDomain } from './challenge';

declare global {
  namespace Express {
    interface Request {
      stellarAddress?: string;
    }
  }
}

/**
 * The result of {@link parseBearerToken}.
 *
 * A discriminated union: `ok: true` carries the extracted token; `ok: false`
 * carries a human-readable reason string explaining why parsing failed.
 */
export type ParseBearerTokenResult =
  | { ok: true; token: string }
  | { ok: false; reason: string };

/**
 * Extracts the Bearer token from a raw `Authorization` header value.
 *
 * Accepts the standard `Bearer <token>` format (scheme matching is
 * case-insensitive, as required by RFC 7235). Returns a discriminated-union
 * result rather than throwing so callers can handle errors without try/catch.
 *
 * @param header - The raw value of the `Authorization` header. Pass an empty
 *   string or `undefined` (coerced to `''`) when the header is absent.
 *
 * @returns `{ ok: true, token }` when a non-empty Bearer token was found, or
 *   `{ ok: false, reason }` for any of the following failure cases:
 *   - header is missing or empty
 *   - the scheme is not `Bearer` (case-insensitive)
 *   - the token portion is missing or empty (e.g. `"Bearer "` with trailing space only)
 *   - the header contains more than two whitespace-separated parts (malformed)
 *
 * @example
 * ```ts
 * const result = parseBearerToken(req.header('Authorization') ?? '');
 * if (!result.ok) {
 *   res.status(401).json({ error: result.reason });
 *   return;
 * }
 * // result.token is the raw base64-XDR string
 * ```
 */
export function parseBearerToken(header: string): ParseBearerTokenResult {
  if (!header) {
    return { ok: false, reason: 'missing bearer token' };
  }

  // Split on a single space only. RFC 7235 §2.1 says the token68 value is
  // a single contiguous string, so legitimate Bearer headers are exactly
  // two whitespace-separated parts. We split on the first space only so that
  // a token that itself contains spaces is never silently truncated — instead
  // it produces the correct "malformed" error.
  const spaceIndex = header.indexOf(' ');
  if (spaceIndex === -1) {
    // e.g. "Bearer" with no space at all
    return { ok: false, reason: 'missing bearer token' };
  }

  const scheme = header.slice(0, spaceIndex);
  const rest = header.slice(spaceIndex + 1);

  if (scheme.toLowerCase() !== 'bearer') {
    return { ok: false, reason: 'missing bearer token' };
  }

  // Reject trailing-space-only values and anything with embedded whitespace
  // (a valid XDR token is a single base64 string with no spaces).
  const token = rest.trim();
  if (!token) {
    return { ok: false, reason: 'missing bearer token' };
  }

  // A legitimate Bearer token must not contain internal whitespace.
  if (/\s/.test(rest)) {
    return { ok: false, reason: 'malformed bearer token' };
  }

  return { ok: true, token };
}

export interface Sep10MiddlewareOptions extends VerifyChallengeOptions {
  /**
   * Optional store consulted after a challenge verifies successfully, to
   * reject addresses revoked before their challenge naturally expired.
   */
  revocationStore?: RevocationStore;
  /** Optional injectable logger for observability. Nothing is logged if omitted. */
  logger?: Logger;
  /**
   * Maximum accepted length (in characters) of the bearer token, rejected
   * with 401 before XDR parsing is attempted. A signed SEP-10 challenge XDR
   * has a well-known bounded size, so this guards against unauthenticated
   * callers forcing expensive XDR-parsing work with oversized garbage input.
   * @default 8192
   */
  maxTokenLength?: number;
}

const DEFAULT_MAX_TOKEN_LENGTH = 8192;

// Reference pattern only: expects the raw signed SEP-10 challenge XDR on every
// request via `Authorization: Bearer <base64-xdr>`. A production app would
// typically verify once and issue a short-lived session JWT instead of
// re-verifying the challenge transaction on every request; that is out of
// scope for this package.
export function createSep10Middleware(options: Sep10MiddlewareOptions): RequestHandler {
  const logger = options.logger ?? noopLogger;
  const maxTokenLength = options.maxTokenLength ?? DEFAULT_MAX_TOKEN_LENGTH;

  // ── #39: Validate required configuration at construction time ──────────────
  // Catch misconfiguration early rather than on first request.

  if (!StrKey.isValidEd25519PublicKey(options.serverAccountId)) {
    throw new Error(
      `sep10-auth: Invalid serverAccountId: ${options.serverAccountId}`,
    );
  }

  const homeDomains = Array.isArray(options.homeDomains)
    ? options.homeDomains
    : [options.homeDomains];
  if (homeDomains.length === 0 || homeDomains.some((d) => !d)) {
    throw new Error('sep10-auth: homeDomains must be a non-empty array of non-empty strings');
  }
  homeDomains.forEach((d) => assertBareDomain('homeDomains', d));

  const webAuthDomains = Array.isArray(options.webAuthDomain)
    ? options.webAuthDomain
    : [options.webAuthDomain];
  if (webAuthDomains.length === 0 || webAuthDomains.some((d) => !d)) {
    throw new Error('sep10-auth: webAuthDomain must be a non-empty array of non-empty strings');
  }
  webAuthDomains.forEach((d) => assertBareDomain('webAuthDomain', d));

  // ── Request handler ─────────────────────────────────────────────────────────

  return async (req, res, next) => {
    // ── #38: Use parseBearerToken helper ──────────────────────────────────────
    const parsed = parseBearerToken(req.header('Authorization') ?? '');

    if (!parsed.ok) {
      logger.warn('sep10-auth: missing or malformed bearer token', {
        ip: req.ip,
        path: req.path,
      });
      res.status(401).json({ error: 'unauthorized', reason: parsed.reason });
      return;
    }

    const token = parsed.token;

    if (token.length > maxTokenLength) {
      logger.warn('sep10-auth: bearer token exceeds maximum length', {
        ip: req.ip,
        path: req.path,
        length: token.length,
      });
      res.status(401).json({ error: 'unauthorized', reason: 'bearer token too large' });
      return;
    }

    const result = verifyChallenge(token, options);

    if (!result.valid) {
      logger.warn('sep10-auth: challenge verification failed', {
        reason: result.error,
        ip: req.ip,
        path: req.path,
      });
      res.status(401).json({ error: 'unauthorized', reason: result.error });
      return;
    }

    if (options.revocationStore) {
      let revoked: boolean;
      try {
        revoked = await options.revocationStore.isRevoked(result.address);
      } catch (error) {
        logger.error('sep10-auth: revocation store lookup failed', error);
        next(error);
        return;
      }

      if (revoked) {
        logger.warn('sep10-auth: address is revoked', { address: result.address });
        res.status(401).json({ error: 'unauthorized', reason: 'address revoked' });
        return;
      }
    }

    logger.debug('sep10-auth: request authenticated', { address: result.address, path: req.path });
    req.stellarAddress = result.address;
    next();
  };
}
