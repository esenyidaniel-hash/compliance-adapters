import { Keypair } from '@stellar/stellar-sdk';
import type { NextFunction, Request, Response } from 'express';
import { createSep10Middleware, parseBearerToken } from '../src/middleware';
import { Sep10MiddlewareOptions } from '../src/middleware';
import { VerifyChallengeOptions } from '../src/verify';
import * as verifyModule from '../src/verify';
import { RevocationStore } from '../src/revocation';

const options: VerifyChallengeOptions = {
  serverAccountId: Keypair.random().publicKey(),
  homeDomains: 'example.com',
  webAuthDomain: 'example.com',
};

function makeReq(authHeader: string | undefined): Request {
  return {
    header: (name: string) => (name === 'Authorization' ? authHeader : undefined),
    ip: '127.0.0.1',
    path: '/compliance',
  } as unknown as Request;
}

function makeRes(): Response {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

// ─────────────────────────────────────────────────────────────────────────────
// parseBearerToken unit tests (#38)
// ─────────────────────────────────────────────────────────────────────────────

describe('parseBearerToken', () => {
  it('returns ok:true with the token for a well-formed Bearer header', () => {
    const result = parseBearerToken('Bearer abc123token');
    expect(result).toEqual({ ok: true, token: 'abc123token' });
  });

  it('is case-insensitive on the scheme (bearer, BEARER, bEaReR)', () => {
    for (const scheme of ['bearer', 'BEARER', 'bEaReR']) {
      const result = parseBearerToken(`${scheme} mytoken`);
      expect(result).toEqual({ ok: true, token: 'mytoken' });
    }
  });

  it('returns ok:false for an empty header string', () => {
    const result = parseBearerToken('');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing bearer token');
  });

  it('returns ok:false for a non-Bearer scheme', () => {
    const result = parseBearerToken('Basic abc123');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing bearer token');
  });

  it('returns ok:false for "Bearer" with no token (no space)', () => {
    const result = parseBearerToken('Bearer');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing bearer token');
  });

  it('returns ok:false for "Bearer " with only trailing whitespace', () => {
    const result = parseBearerToken('Bearer ');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing bearer token');
  });

  it('returns ok:false for a header with internal whitespace in token part', () => {
    const result = parseBearerToken('Bearer token with spaces');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('malformed bearer token');
  });

  it('returns ok:true with a realistic base64-XDR token string', () => {
    const token = 'AAAAAQAAAAB'.repeat(100);
    const result = parseBearerToken(`Bearer ${token}`);
    expect(result).toEqual({ ok: true, token });
  });

  it('returns ok:false for a plain string with no space (unrecognised scheme)', () => {
    const result = parseBearerToken('notaheader');
    expect(result.ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createSep10Middleware — malformed Authorization header
// ─────────────────────────────────────────────────────────────────────────────

describe('createSep10Middleware', () => {
  describe('malformed Authorization header', () => {
    it.each([
      ['a non-Bearer scheme', 'Basic abc123'],
      ['an empty header', ''],
      ['Bearer with no token', 'Bearer'],
      ['Bearer with only trailing whitespace', 'Bearer '],
      ['a header with no Authorization at all', undefined],
    ])('returns 401 with "missing bearer token" for %s', async (_description, authHeader) => {
      const middleware = createSep10Middleware(options);
      const req = makeReq(authHeader);
      const res = makeRes();
      const next = jest.fn() as unknown as NextFunction;

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: 'unauthorized',
        reason: 'missing bearer token',
      });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('maxTokenLength option', () => {
    it('rejects bearer tokens exceeding default maxTokenLength (8192)', async () => {
      const middleware = createSep10Middleware(options);
      const oversizedToken = 'a'.repeat(8193);
      const req = makeReq(`Bearer ${oversizedToken}`);
      const res = makeRes();
      const next = jest.fn() as unknown as NextFunction;

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: 'unauthorized',
        reason: 'bearer token too large',
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('rejects bearer tokens exceeding custom maxTokenLength', async () => {
      const mockLogger = { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() };
      const middleware = createSep10Middleware({
        ...options,
        maxTokenLength: 100,
        logger: mockLogger,
      });
      const req = makeReq(`Bearer ${'a'.repeat(101)}`);
      const res = makeRes();
      const next = jest.fn() as unknown as NextFunction;

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: 'unauthorized',
        reason: 'bearer token too large',
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'sep10-auth: bearer token exceeds maximum length',
        expect.objectContaining({ length: 101 }),
      );
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('challenge verification branches', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('sets req.stellarAddress and calls next() on successful verification', async () => {
      const clientAddress = Keypair.random().publicKey();
      jest.spyOn(verifyModule, 'verifyChallenge').mockReturnValue({
        valid: true,
        address: clientAddress,
      });

      const mockLogger = { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() };
      const middleware = createSep10Middleware({
        ...options,
        logger: mockLogger,
      });
      const req = makeReq('Bearer valid-xdr');
      const res = makeRes();
      const next = jest.fn() as unknown as NextFunction;

      await middleware(req, res, next);

      expect(req.stellarAddress).toBe(clientAddress);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'sep10-auth: request authenticated',
        expect.objectContaining({ address: clientAddress }),
      );
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('returns 401 when verifyChallenge returns valid: false', async () => {
      jest.spyOn(verifyModule, 'verifyChallenge').mockReturnValue({
        valid: false,
        address: '',
        error: 'Transaction has expired',
      });

      const mockLogger = { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() };
      const middleware = createSep10Middleware({
        ...options,
        logger: mockLogger,
      });
      const req = makeReq('Bearer expired-xdr');
      const res = makeRes();
      const next = jest.fn() as unknown as NextFunction;

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: 'unauthorized',
        reason: 'Transaction has expired',
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'sep10-auth: challenge verification failed',
        expect.objectContaining({ reason: 'Transaction has expired' }),
      );
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('revocationStore integration', () => {
    const clientAddress = Keypair.random().publicKey();

    beforeEach(() => {
      jest.spyOn(verifyModule, 'verifyChallenge').mockReturnValue({
        valid: true,
        address: clientAddress,
      });
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('returns 401 "address revoked" when isRevoked returns true', async () => {
      const mockStore: RevocationStore = {
        isRevoked: jest.fn().mockResolvedValue(true),
        revoke: jest.fn(),
        unrevoke: jest.fn(),
      };
      const mockLogger = { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() };

      const middleware = createSep10Middleware({
        ...options,
        revocationStore: mockStore,
        logger: mockLogger,
      });
      const req = makeReq('Bearer some-xdr');
      const res = makeRes();
      const next = jest.fn() as unknown as NextFunction;

      await middleware(req, res, next);

      expect(mockStore.isRevoked).toHaveBeenCalledWith(clientAddress);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: 'unauthorized',
        reason: 'address revoked',
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'sep10-auth: address is revoked',
        expect.objectContaining({ address: clientAddress }),
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('sets req.stellarAddress and calls next() when isRevoked returns false', async () => {
      const mockStore: RevocationStore = {
        isRevoked: jest.fn().mockResolvedValue(false),
        revoke: jest.fn(),
        unrevoke: jest.fn(),
      };

      const middleware = createSep10Middleware({
        ...options,
        revocationStore: mockStore,
      });
      const req = makeReq('Bearer some-xdr');
      const res = makeRes();
      const next = jest.fn() as unknown as NextFunction;

      await middleware(req, res, next);

      expect(mockStore.isRevoked).toHaveBeenCalledWith(clientAddress);
      expect(req.stellarAddress).toBe(clientAddress);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('calls next(error) when isRevoked throws or rejects', async () => {
      const storeError = new Error('Database connection failed');
      const mockStore: RevocationStore = {
        isRevoked: jest.fn().mockRejectedValue(storeError),
        revoke: jest.fn(),
        unrevoke: jest.fn(),
      };
      const mockLogger = { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() };

      const middleware = createSep10Middleware({
        ...options,
        revocationStore: mockStore,
        logger: mockLogger,
      });
      const req = makeReq('Bearer some-xdr');
      const res = makeRes();
      const next = jest.fn() as unknown as NextFunction;

      await middleware(req, res, next);

      expect(mockStore.isRevoked).toHaveBeenCalledWith(clientAddress);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'sep10-auth: revocation store lookup failed',
        storeError,
      );
      expect(next).toHaveBeenCalledWith(storeError);
      expect(res.status).not.toHaveBeenCalled();
    });
  });
});

describe('createSep10Middleware - bearer scheme case-insensitivity (RFC 7235)', () => {
  it.each(['bearer', 'BEARER', 'bEaReR'])('accepts the %s scheme and proceeds to verification', (scheme) => {
    const middleware = createSep10Middleware(options);
    const res = makeRes();
    const next = jest.fn() as unknown as NextFunction;

    middleware(makeReq(`${scheme} not-a-real-xdr`), res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'missing bearer token' }),
    );
  });
});

describe('createSep10Middleware - domain format validation', () => {
  it.each(['https://example.com', 'example.com/'])('rejects homeDomains %p', (bad) => {
    expect(() => createSep10Middleware({ ...options, homeDomains: bad })).toThrow(
      /bare domain/,
    );
  });

  it('rejects a non-bare webAuthDomain', () => {
    expect(() =>
      createSep10Middleware({ ...options, webAuthDomain: ['example.com', 'http://x.com'] }),
    ).toThrow(/bare domain/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #39 — construction-time validation tests
// ─────────────────────────────────────────────────────────────────────────────

describe('createSep10Middleware - construction-time option validation (#39)', () => {
  it('throws immediately for an invalid serverAccountId', () => {
    expect(() =>
      createSep10Middleware({ ...options, serverAccountId: 'not-a-valid-key' }),
    ).toThrow(/serverAccountId/);
  });

  it('throws immediately for an empty serverAccountId string', () => {
    expect(() =>
      createSep10Middleware({ ...options, serverAccountId: '' }),
    ).toThrow(/serverAccountId/);
  });

  it('throws immediately when homeDomains is an empty array', () => {
    expect(() =>
      createSep10Middleware({ ...options, homeDomains: [] as unknown as string }),
    ).toThrow(/homeDomains/);
  });

  it('throws immediately when homeDomains contains an empty string', () => {
    expect(() =>
      createSep10Middleware({ ...options, homeDomains: ['example.com', ''] }),
    ).toThrow(/homeDomains/);
  });

  it('throws immediately when webAuthDomain is an empty array', () => {
    expect(() =>
      createSep10Middleware({ ...options, webAuthDomain: [] as unknown as string }),
    ).toThrow(/webAuthDomain/);
  });

  it('throws immediately when webAuthDomain contains an empty string', () => {
    expect(() =>
      createSep10Middleware({ ...options, webAuthDomain: ['example.com', ''] }),
    ).toThrow(/webAuthDomain/);
  });

  it('does NOT throw for valid options (happy path)', () => {
    expect(() => createSep10Middleware(options)).not.toThrow();
  });

  it('does NOT throw for valid options with array homeDomains', () => {
    expect(() =>
      createSep10Middleware({ ...options, homeDomains: ['example.com', 'other.com'] }),
    ).not.toThrow();
  });
});
