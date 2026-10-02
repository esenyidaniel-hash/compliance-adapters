/**
 * Copyright (c) 2026 stellar-compliance-kit
 * SPDX-License-Identifier: MIT
 */

/**
 * Implement this interface to plug an external sanctions/watchlist data
 * source into the denylist-gate sync flow (see `sync.ts`).
 *
 * `sync.ts` only depends on this shape, so any provider — a REST client
 * for a commercial watchlist API, a local CSV loader, a cache in front of
 * multiple upstream lists, etc. — can be swapped in without touching the
 * sync logic itself.
 *
 * @example
 * Use the built-in {@link RestSanctionsProvider} to query a watchlist
 * REST API.  See {@link RestSanctionsProvider} for the full source and
 * constructor options (apiBaseUrl, apiKey, timeoutMs, fetchImpl).
 *
 * ```ts
 * import { RestSanctionsProvider, syncSanctionsToDenylist } from 'sanctions-oracle';
 *
 * const provider = new RestSanctionsProvider({
 *   apiBaseUrl: 'https://api.watchlist-provider.com',
 *   apiKey: process.env.WATCHLIST_API_KEY!,
 * });
 *
 * await syncSanctionsToDenylist({ provider, addresses, writer });
 * ```
 */
export interface SanctionsProvider {
  checkAddress(address: string): Promise<{ flagged: boolean; source: string }>;
}
