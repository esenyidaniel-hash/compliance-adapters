/**
 * Copyright (c) 2026 stellar-compliance-kit
 * SPDX-License-Identifier: MIT
 */

import { SanctionsProvider } from './SanctionsProvider';

export type ConflictResolutionPolicy = 'any-flag-wins' | 'majority-vote' | 'priority-override';

export type ProviderErrorMode = 'ignore' | 'flag';

export type TieBreak = 'flag' | 'clear';

export interface ProviderRegistryOptions {
  policy: ConflictResolutionPolicy;
  /**
   * What to do when a registered provider's `checkAddress` throws.
   * - 'ignore' (default): exclude it from the vote; still recorded in `errors`.
   * - 'flag': treat the failure as if the provider had answered `flagged: true`
   *   (fail-closed — prefer over-blocking to a silent gap in coverage).
   */
  onProviderError?: ProviderErrorMode;
  /**
   * Only consulted by the 'majority-vote' policy. Default 'flag' (fail-closed).
   */
  tieBreak?: TieBreak;
}

export interface RegisterOptions {
  /** Only consulted by the 'priority-override' policy. Lower wins. */
  priority?: number;
}

export interface ProviderCheckOutcome {
  name: string;
  flagged: boolean;
  source: string;
}

export interface ProviderErrorOutcome {
  name: string;
  error: string;
}

export interface RegistryCheckResult {
  flagged: boolean;
  source: string;
  policy: ConflictResolutionPolicy;
  results: ProviderCheckOutcome[];
  errors: ProviderErrorOutcome[];
}

export class ProviderRegistryAllProvidersFailedError extends Error {
  constructor(public readonly errors: ProviderErrorOutcome[]) {
    super(
      `sanctions-oracle: all ${errors.length} registered provider(s) failed to answer: ` +
        errors.map((e) => `${e.name} (${e.error})`).join('; '),
    );
    this.name = 'ProviderRegistryAllProvidersFailedError';
  }
}

interface RegisteredProvider {
  name: string;
  provider: SanctionsProvider;
  priority: number;
  registrationIndex: number;
}

const DEFAULT_PRIORITY = Number.POSITIVE_INFINITY;

/**
 * Holds multiple SanctionsProviders, queries all of them for a given
 * address, and resolves disagreements according to a configurable policy.
 *
 * Implements SanctionsProvider itself, so it's a drop-in replacement for a
 * single provider anywhere one is expected (including
 * `syncSanctionsToDenylist`'s `provider` option).
 *
 * See ../docs/provider-registry-design.md for the full design rationale.
 */
export class ProviderRegistry implements SanctionsProvider {
  private readonly providers = new Map<string, RegisteredProvider>();
  private readonly policy: ConflictResolutionPolicy;
  private readonly onProviderError: ProviderErrorMode;
  private readonly tieBreak: TieBreak;
  private nextRegistrationIndex = 0;

  constructor(options: ProviderRegistryOptions) {
    this.policy = options.policy;
    this.onProviderError = options.onProviderError ?? 'ignore';
    this.tieBreak = options.tieBreak ?? 'flag';
  }

  register(name: string, provider: SanctionsProvider, options: RegisterOptions = {}): void {
    if (this.providers.has(name)) {
      throw new Error(`sanctions-oracle: a provider named "${name}" is already registered`);
    }
    this.providers.set(name, {
      name,
      provider,
      priority: options.priority ?? DEFAULT_PRIORITY,
      registrationIndex: this.nextRegistrationIndex++,
    });
  }

  unregister(name: string): void {
    this.providers.delete(name);
  }

  listProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  async checkAddress(address: string): Promise<{ flagged: boolean; source: string }> {
    const result = await this.checkAddressDetailed(address);
    return { flagged: result.flagged, source: result.source };
  }

  async checkAddressDetailed(address: string): Promise<RegistryCheckResult> {
    if (this.providers.size === 0) {
      throw new Error('sanctions-oracle: ProviderRegistry has no registered providers');
    }

    const registered = Array.from(this.providers.values());

    const settled = await Promise.all(
      registered.map(
        async (
          entry,
        ): Promise<
          | { entry: RegisteredProvider; outcome: ProviderCheckOutcome }
          | { entry: RegisteredProvider; error: string }
        > => {
          try {
            const { flagged, source } = await entry.provider.checkAddress(address);
            return { entry, outcome: { name: entry.name, flagged, source } };
          } catch (err) {
            return { entry, error: err instanceof Error ? err.message : String(err) };
          }
        },
      ),
    );

    const results: ProviderCheckOutcome[] = [];
    const errors: ProviderErrorOutcome[] = [];

    for (const settledEntry of settled) {
      if ('outcome' in settledEntry) {
        results.push(settledEntry.outcome);
      } else {
        errors.push({ name: settledEntry.entry.name, error: settledEntry.error });
      }
    }

    // Errored providers optionally still cast a (flagged) vote even though
    // they have no real `source` to report.
    const votingResults: ProviderCheckOutcome[] =
      this.onProviderError === 'flag'
        ? [
            ...results,
            ...errors.map((e) => ({ name: e.name, flagged: true, source: `error: ${e.error}` })),
          ]
        : results;

    if (votingResults.length === 0) {
      throw new ProviderRegistryAllProvidersFailedError(errors);
    }

    const { flagged, source } = this.resolve(registered, votingResults);

    return { flagged, source, policy: this.policy, results, errors };
  }

  private resolve(
    registered: RegisteredProvider[],
    votingResults: ProviderCheckOutcome[],
  ): { flagged: boolean; source: string } {
    switch (this.policy) {
      case 'any-flag-wins':
        return this.resolveAnyFlagWins(votingResults);
      case 'majority-vote':
        return this.resolveMajorityVote(votingResults);
      case 'priority-override':
        return this.resolvePriorityOverride(registered, votingResults);
      default: {
        const exhaustiveCheck: never = this.policy;
        throw new Error(`sanctions-oracle: unknown conflict-resolution policy ${exhaustiveCheck}`);
      }
    }
  }

  private resolveAnyFlagWins(votingResults: ProviderCheckOutcome[]): {
    flagged: boolean;
    source: string;
  } {
    const flaggers = votingResults.filter((r) => r.flagged);
    const flagged = flaggers.length > 0;
    const relevant = flagged ? flaggers : votingResults;
    return { flagged, source: formatSources(relevant) };
  }

  private resolveMajorityVote(votingResults: ProviderCheckOutcome[]): {
    flagged: boolean;
    source: string;
  } {
    const flaggers = votingResults.filter((r) => r.flagged);
    const clearers = votingResults.filter((r) => !r.flagged);

    let flagged: boolean;
    if (flaggers.length > clearers.length) {
      flagged = true;
    } else if (clearers.length > flaggers.length) {
      flagged = false;
    } else {
      flagged = this.tieBreak === 'flag';
    }

    const relevant = flagged ? flaggers : clearers;
    const source =
      relevant.length > 0 ? formatSources(relevant) : `majority-vote tie-break (${this.tieBreak})`;
    return { flagged, source };
  }

  private resolvePriorityOverride(
    registered: RegisteredProvider[],
    votingResults: ProviderCheckOutcome[],
  ): { flagged: boolean; source: string } {
    const metadataByName = new Map(
      registered.map((entry) => [
        entry.name,
        { priority: entry.priority, registrationIndex: entry.registrationIndex },
      ]),
    );
    const ordered = [...votingResults].sort((a, b) => {
      const metadataA = metadataByName.get(a.name);
      const metadataB = metadataByName.get(b.name);
      if (!metadataA || !metadataB) return 0;
      if (metadataA.priority < metadataB.priority) return -1;
      if (metadataA.priority > metadataB.priority) return 1;
      return metadataA.registrationIndex - metadataB.registrationIndex;
    });
    const winner = ordered[0];
    return { flagged: winner.flagged, source: formatSources([winner]) };
  }
}

function formatSources(outcomes: ProviderCheckOutcome[]): string {
  return outcomes.map((o) => `${o.name}:${o.source}`).join(', ');
}
