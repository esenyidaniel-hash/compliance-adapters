/**
 * Copyright (c) 2026 stellar-compliance-kit
 * SPDX-License-Identifier: MIT
 */

import { RestSanctionsProvider } from '../src/restProvider';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FLAGGED_ADDRESS = 'GD7PQQDZ75ZIY3O3CZKO4P6NBRBDBYEM6PKROQUVKMXI6J2SAB4FWYAN';
const CLEAN_ADDRESS = 'GDNOTPRESENTINANYMOCKWATCHLISTAAAAAAAAAAAAAAAAAAAAAAAAAA';
const BASE_URL = 'https://api.example-watchlist.com';
const API_KEY = 'test-api-key-abc123';

/** Creates a minimal mock Response that satisfies the Fetch Response interface. */
function makeResponse(body: object, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** Builds a provider with an injected fetch mock. */
function makeProvider(
  fetchImpl: jest.MockedFunction<typeof fetch>,
  overrides: { timeoutMs?: number } = {},
) {
  return new RestSanctionsProvider({
    apiBaseUrl: BASE_URL,
    apiKey: API_KEY,
    fetchImpl,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RestSanctionsProvider', () => {
  describe('checkAddress — success paths', () => {
    it('returns flagged:true and joins the lists array when the API flags an address', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(
        makeResponse({ is_flagged: true, lists: ['OFAC-SDN', 'EU-SANCTIONS'] }),
      );
      const provider = makeProvider(fetchImpl);

      const result = await provider.checkAddress(FLAGGED_ADDRESS);

      expect(result.flagged).toBe(true);
      expect(result.source).toBe('OFAC-SDN,EU-SANCTIONS');
    });

    it('returns flagged:false when the API does not flag an address', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(
        makeResponse({ is_flagged: false, lists: [] }),
      );
      const provider = makeProvider(fetchImpl);

      const result = await provider.checkAddress(CLEAN_ADDRESS);

      expect(result.flagged).toBe(false);
    });

    it('falls back to "external-watchlist-api" as source when the lists array is empty', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(
        makeResponse({ is_flagged: true, lists: [] }),
      );
      const provider = makeProvider(fetchImpl);

      const result = await provider.checkAddress(FLAGGED_ADDRESS);

      expect(result.source).toBe('external-watchlist-api');
    });

    it('URL-encodes the address in the query string', async () => {
      const fetchImpl = jest
        .fn()
        .mockResolvedValue(makeResponse({ is_flagged: false, lists: [] }));
      const provider = makeProvider(fetchImpl);
      const addressWithSpecialChars = 'G+ADDR=WITH&SPECIAL';

      await provider.checkAddress(addressWithSpecialChars);

      const [calledUrl] = fetchImpl.mock.calls[0];
      expect(calledUrl).toContain(encodeURIComponent(addressWithSpecialChars));
    });

    it('sends the API key as a Bearer token in the Authorization header', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(
        makeResponse({ is_flagged: false, lists: [] }),
      );
      const provider = makeProvider(fetchImpl);

      await provider.checkAddress(CLEAN_ADDRESS);

      const [, init] = fetchImpl.mock.calls[0];
      expect((init?.headers as Record<string, string>)?.['Authorization']).toBe(
        `Bearer ${API_KEY}`,
      );
    });

    it('strips a trailing slash from apiBaseUrl before constructing the URL', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(
        makeResponse({ is_flagged: false, lists: [] }),
      );
      const provider = new RestSanctionsProvider({
        apiBaseUrl: `${BASE_URL}/`, // trailing slash
        apiKey: API_KEY,
        fetchImpl,
      });

      await provider.checkAddress(CLEAN_ADDRESS);

      const [calledUrl] = fetchImpl.mock.calls[0];
      expect(calledUrl).toMatch(/^https:\/\/api\.example-watchlist\.com\/check\?/);
      // must not contain double-slash before "check"
      expect(calledUrl).not.toContain('//check');
    });
  });

  describe('checkAddress — error paths', () => {
    it('throws when the API responds with a non-2xx status', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(makeResponse({}, 403));
      const provider = makeProvider(fetchImpl);

      await expect(provider.checkAddress(FLAGGED_ADDRESS)).rejects.toThrow(/HTTP 403/);
    });

    it('throws with a timeout message when fetch is aborted by the timeout controller', async () => {
      const abortError = Object.assign(new Error('The operation was aborted'), {
        name: 'AbortError',
      });
      const fetchImpl = jest.fn().mockRejectedValue(abortError);
      const provider = makeProvider(fetchImpl, { timeoutMs: 1 });

      await expect(provider.checkAddress(FLAGGED_ADDRESS)).rejects.toThrow(/timed out/i);
    });

    it('wraps a generic network error with address context', async () => {
      const networkError = new Error('ECONNREFUSED');
      const fetchImpl = jest.fn().mockRejectedValue(networkError);
      const provider = makeProvider(fetchImpl);

      await expect(provider.checkAddress(FLAGGED_ADDRESS)).rejects.toThrow(
        new RegExp(`request failed for address ${FLAGGED_ADDRESS}`),
      );
    });

    it('passes an AbortSignal to fetch so the timeout can actually fire', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(
        makeResponse({ is_flagged: false, lists: [] }),
      );
      const provider = makeProvider(fetchImpl);

      await provider.checkAddress(CLEAN_ADDRESS);

      const [, init] = fetchImpl.mock.calls[0];
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    });
  });
});
