import { SanctionsProvider } from '../src/SanctionsProvider';
import { ProviderRegistry, ProviderRegistryAllProvidersFailedError } from '../src/ProviderRegistry';
import { syncSanctionsToDenylist, DenylistWriter } from '../src/sync';

// A valid Stellar Ed25519 StrKey (syncSanctionsToDenylist rejects malformed
// input before it reaches the provider — see issue #342).
const ADDRESS = 'GB3RCZ4Q3OLLWLM2VUVA23MZNOZCAQSOADHQSHMFXXRXYR7427PTR4DU';

function fakeProvider(flagged: boolean, source: string): SanctionsProvider {
  return {
    async checkAddress() {
      return { flagged, source };
    },
  };
}

function throwingProvider(message: string): SanctionsProvider {
  return {
    async checkAddress() {
      throw new Error(message);
    },
  };
}

describe('ProviderRegistry', () => {
  describe('agreement', () => {
    it('all providers flagged: reports flagged under every policy', async () => {
      for (const policy of ['any-flag-wins', 'majority-vote', 'priority-override'] as const) {
        const registry = new ProviderRegistry({ policy });
        registry.register('a', fakeProvider(true, 'list-a'));
        registry.register('b', fakeProvider(true, 'list-b'));

        const result = await registry.checkAddress(ADDRESS);
        expect(result.flagged).toBe(true);
      }
    });

    it('all providers clear: reports not flagged under every policy', async () => {
      for (const policy of ['any-flag-wins', 'majority-vote', 'priority-override'] as const) {
        const registry = new ProviderRegistry({ policy });
        registry.register('a', fakeProvider(false, 'list-a'));
        registry.register('b', fakeProvider(false, 'list-b'));

        const result = await registry.checkAddress(ADDRESS);
        expect(result.flagged).toBe(false);
      }
    });
  });

  describe('disagreement: any-flag-wins', () => {
    it('flags the address if a single provider flags it', async () => {
      const registry = new ProviderRegistry({ policy: 'any-flag-wins' });
      registry.register('clean-a', fakeProvider(false, 'list-a'));
      registry.register('flagger', fakeProvider(true, 'internal-denylist'));
      registry.register('clean-b', fakeProvider(false, 'list-b'));

      const detailed = await registry.checkAddressDetailed(ADDRESS);

      expect(detailed.flagged).toBe(true);
      expect(detailed.source).toBe('flagger:internal-denylist');
      expect(detailed.results).toHaveLength(3);
      expect(detailed.errors).toHaveLength(0);
    });
  });

  describe('disagreement: majority-vote', () => {
    it('flags when a strict majority flags', async () => {
      const registry = new ProviderRegistry({ policy: 'majority-vote' });
      registry.register('a', fakeProvider(true, 'list-a'));
      registry.register('b', fakeProvider(true, 'list-b'));
      registry.register('c', fakeProvider(false, 'list-c'));

      const result = await registry.checkAddress(ADDRESS);
      expect(result.flagged).toBe(true);
    });

    it('clears when a strict majority clears', async () => {
      const registry = new ProviderRegistry({ policy: 'majority-vote' });
      registry.register('a', fakeProvider(false, 'list-a'));
      registry.register('b', fakeProvider(false, 'list-b'));
      registry.register('c', fakeProvider(true, 'list-c'));

      const result = await registry.checkAddress(ADDRESS);
      expect(result.flagged).toBe(false);
    });

    it('breaks a tie using tieBreak: "flag" (default)', async () => {
      const registry = new ProviderRegistry({ policy: 'majority-vote' });
      registry.register('a', fakeProvider(true, 'list-a'));
      registry.register('b', fakeProvider(false, 'list-b'));

      const result = await registry.checkAddress(ADDRESS);
      expect(result.flagged).toBe(true);
    });

    it('breaks a tie using tieBreak: "clear" when configured', async () => {
      const registry = new ProviderRegistry({ policy: 'majority-vote', tieBreak: 'clear' });
      registry.register('a', fakeProvider(true, 'list-a'));
      registry.register('b', fakeProvider(false, 'list-b'));

      const result = await registry.checkAddress(ADDRESS);
      expect(result.flagged).toBe(false);
    });
  });

  describe('disagreement: priority-override', () => {
    it("the highest-priority (lowest number) provider's answer wins outright", async () => {
      const registry = new ProviderRegistry({ policy: 'priority-override' });
      registry.register('internal-denylist', fakeProvider(false, 'internal-v3'), {
        priority: 0,
      });
      registry.register('external-list', fakeProvider(true, 'sdn-list'), { priority: 1 });

      const detailed = await registry.checkAddressDetailed(ADDRESS);

      expect(detailed.flagged).toBe(false);
      expect(detailed.source).toBe('internal-denylist:internal-v3');
    });

    it('falls through to the next-highest priority if the top one errored', async () => {
      const registry = new ProviderRegistry({ policy: 'priority-override' });
      registry.register('internal-denylist', throwingProvider('upstream down'), {
        priority: 0,
      });
      registry.register('external-list', fakeProvider(true, 'sdn-list'), { priority: 1 });

      const detailed = await registry.checkAddressDetailed(ADDRESS);

      expect(detailed.flagged).toBe(true);
      expect(detailed.source).toBe('external-list:sdn-list');
      expect(detailed.errors).toEqual([{ name: 'internal-denylist', error: 'upstream down' }]);
    });

    it('uses registration order when the remaining providers are unprioritized', async () => {
      const registry = new ProviderRegistry({ policy: 'priority-override' });
      registry.register('failed-primary', throwingProvider('upstream down'), { priority: 0 });
      registry.register('first-unprioritized', fakeProvider(true, 'list-a'));
      registry.register('second-unprioritized', fakeProvider(false, 'list-b'));

      const detailed = await registry.checkAddressDetailed(ADDRESS);

      expect(detailed.flagged).toBe(true);
      expect(detailed.source).toBe('first-unprioritized:list-a');
    });

    it('providers registered without a priority sort after prioritized ones', async () => {
      const registry = new ProviderRegistry({ policy: 'priority-override' });
      registry.register('no-priority', fakeProvider(true, 'list-a'));
      registry.register('prioritized', fakeProvider(false, 'list-b'), { priority: 5 });

      const result = await registry.checkAddress(ADDRESS);
      expect(result.flagged).toBe(false);
    });

    it('when two providers share the same priority, registration order is the tiebreaker', async () => {
      const registry = new ProviderRegistry({ policy: 'priority-override' });
      registry.register('first-registered', fakeProvider(false, 'list-a'), { priority: 5 });
      registry.register('second-registered', fakeProvider(true, 'list-b'), { priority: 5 });

      const detailed = await registry.checkAddressDetailed(ADDRESS);

      expect(detailed.flagged).toBe(false);
      expect(detailed.source).toBe('first-registered:list-a');
    });

    it('when three providers have no explicit priority, registration order determines the winner', async () => {
      const registry = new ProviderRegistry({ policy: 'priority-override' });
      registry.register('first', fakeProvider(true, 'flagged-list'));
      registry.register('second', fakeProvider(false, 'clean-list'));
      registry.register('third', fakeProvider(true, 'another-flagged-list'));

      const detailed = await registry.checkAddressDetailed(ADDRESS);

      expect(detailed.flagged).toBe(true);
      expect(detailed.source).toBe('first:flagged-list');
    });

    it('when three providers have no explicit priority, changing registration order changes the winner', async () => {
      const registry = new ProviderRegistry({ policy: 'priority-override' });
      registry.register('second', fakeProvider(false, 'clean-list'));
      registry.register('first', fakeProvider(true, 'flagged-list'));
      registry.register('third', fakeProvider(true, 'another-flagged-list'));

      const detailed = await registry.checkAddressDetailed(ADDRESS);

      expect(detailed.flagged).toBe(false);
      expect(detailed.source).toBe('second:clean-list');
    });
  });

  describe('a provider that errors while others succeed', () => {
    it('default onProviderError is fail-open ("ignore"): excludes errored provider from vote', async () => {
      const registry = new ProviderRegistry({ policy: 'any-flag-wins' });
      registry.register('flaky', throwingProvider('timeout'));
      registry.register('clean', fakeProvider(false, 'list-a'));

      const detailed = await registry.checkAddressDetailed(ADDRESS);

      expect(detailed.flagged).toBe(false);
      expect(detailed.results).toEqual([{ name: 'clean', flagged: false, source: 'list-a' }]);
      expect(detailed.errors).toEqual([{ name: 'flaky', error: 'timeout' }]);
    });

    it('default policy permits single healthy provider to clear despite upstream failures', async () => {
      const registry = new ProviderRegistry({ policy: 'any-flag-wins' });
      registry.register('watchlist-1', throwingProvider('unreachable'));
      registry.register('watchlist-2', throwingProvider('unavailable'));
      registry.register('watchlist-3', fakeProvider(false, 'sdn-list'));

      const result = await registry.checkAddress(ADDRESS);

      expect(result.flagged).toBe(false);
    });

    it('treats the errored provider as flagged when onProviderError: "flag"', async () => {
      const registry = new ProviderRegistry({
        policy: 'any-flag-wins',
        onProviderError: 'flag',
      });
      registry.register('flaky', throwingProvider('timeout'));
      registry.register('clean', fakeProvider(false, 'list-a'));

      const result = await registry.checkAddress(ADDRESS);
      expect(result.flagged).toBe(true);
    });

    it('throws ProviderRegistryAllProvidersFailedError when every provider errors', async () => {
      const registry = new ProviderRegistry({ policy: 'any-flag-wins' });
      registry.register('a', throwingProvider('boom-a'));
      registry.register('b', throwingProvider('boom-b'));

      await expect(registry.checkAddress(ADDRESS)).rejects.toBeInstanceOf(
        ProviderRegistryAllProvidersFailedError,
      );
    });

    it('rejects non-Error throws by stringifying them into the error message', async () => {
      const registry = new ProviderRegistry({ policy: 'any-flag-wins' });
      registry.register('a', {
        async checkAddress() {
          // eslint-disable-next-line @typescript-eslint/no-throw-literal
          throw 'raw string failure';
        },
      });
      registry.register('clean', fakeProvider(false, 'list-a'));

      const detailed = await registry.checkAddressDetailed(ADDRESS);
      expect(detailed.errors).toEqual([{ name: 'a', error: 'raw string failure' }]);
    });
  });

  describe('registration bookkeeping', () => {
    it('throws when registering a duplicate name', () => {
      const registry = new ProviderRegistry({ policy: 'any-flag-wins' });
      registry.register('a', fakeProvider(false, 'list-a'));
      expect(() => registry.register('a', fakeProvider(true, 'list-b'))).toThrow(
        /already registered/,
      );
    });

    it('unregister removes a provider from future checks', async () => {
      const registry = new ProviderRegistry({ policy: 'any-flag-wins' });
      registry.register('a', fakeProvider(true, 'list-a'));
      registry.register('b', fakeProvider(false, 'list-b'));

      registry.unregister('a');

      expect(registry.listProviders()).toEqual(['b']);
      const result = await registry.checkAddress(ADDRESS);
      expect(result.flagged).toBe(false);
    });

    it('throws if checkAddress is called with no registered providers', async () => {
      const registry = new ProviderRegistry({ policy: 'any-flag-wins' });
      await expect(registry.checkAddress(ADDRESS)).rejects.toThrow(/no registered providers/);
    });
  });

  describe('unregister during checkAddressDetailed', () => {
    it('in-flight check sees a consistent snapshot even if provider is unregistered mid-check', async () => {
      let slowProviderReady: (() => void) | undefined;
      const slowProviderStarted = new Promise<void>((resolve) => {
        slowProviderReady = resolve;
      });

      const registry = new ProviderRegistry({ policy: 'any-flag-wins' });

      // Register a slow provider that we'll unregister mid-check
      registry.register('slow', {
        async checkAddress() {
          slowProviderReady?.();
          await new Promise((resolve) => setTimeout(resolve, 100));
          return { flagged: true, source: 'slow-list' };
        },
      });
      registry.register('fast', fakeProvider(false, 'fast-list'));

      // Start the check
      const checkPromise = registry.checkAddressDetailed(ADDRESS);

      // Wait for slow provider to start
      await slowProviderStarted;

      // Unregister the slow provider while check is in flight
      registry.unregister('slow');

      // The in-flight check should still see the slow provider
      const result = await checkPromise;
      expect(result.results).toHaveLength(2);
      expect(result.results.find((r) => r.name === 'slow')).toBeDefined();
      expect(result.flagged).toBe(true);
    });
  });

  describe('interop with syncSanctionsToDenylist', () => {
    it('accepts a ProviderRegistry in place of a single SanctionsProvider', async () => {
      const registry = new ProviderRegistry({ policy: 'any-flag-wins' });
      registry.register('internal-denylist', fakeProvider(true, 'internal-v3'));
      registry.register('external-list', fakeProvider(false, 'sdn-list'));

      const writer: DenylistWriter & { addToDenylist: jest.Mock } = {
        addToDenylist: jest.fn().mockResolvedValue({ hash: 'fakehash' }),
      };

      const result = await syncSanctionsToDenylist({
        provider: registry,
        addresses: [ADDRESS],
        writer,
      });

      expect(result.flagged).toEqual([ADDRESS]);
      expect(writer.addToDenylist).toHaveBeenCalledWith(ADDRESS);
    });
  });

  describe('migration patterns (issue #325)', () => {
    it('allows migration from single provider to ProviderRegistry', async () => {
      // Before: operators with a single provider
      const singleProvider = fakeProvider(true, 'custom-list');

      // After: same provider registered in a registry
      const registry = new ProviderRegistry({ policy: 'any-flag-wins' });
      registry.register('custom-provider', singleProvider);

      // Both should produce the same result
      const singleResult = await singleProvider.checkAddress(ADDRESS);
      const registryResult = await registry.checkAddress(ADDRESS);

      expect(singleResult).toEqual(registryResult);
    });

    it('allows wrapping an existing provider in RateLimitedSanctionsProvider', async () => {
      // Import as if from the sanctions-oracle package
      const RateLimitedSanctionsProvider =
        require('../src/rateLimitedProvider').RateLimitedSanctionsProvider;

      const baseProvider = fakeProvider(false, 'custom-list');
      const rateLimited = new RateLimitedSanctionsProvider(baseProvider);

      const result = await rateLimited.checkAddress(ADDRESS);
      expect(result.flagged).toBe(false);
      expect(result.source).toBe('custom-list');
    });

    it('supports wrapping a provider then registering in ProviderRegistry', async () => {
      const RateLimitedSanctionsProvider =
        require('../src/rateLimitedProvider').RateLimitedSanctionsProvider;

      // Migration path: wrap existing provider for rate-limit resilience
      const baseProvider = fakeProvider(true, 'internal-list');
      const rateLimited = new RateLimitedSanctionsProvider(baseProvider);

      // Then register in a registry to support multiple providers
      const registry = new ProviderRegistry({ policy: 'priority-override' });
      registry.register('primary-provider', rateLimited, { priority: 0 });
      registry.register('backup-provider', fakeProvider(false, 'backup-list'), { priority: 1 });

      const detailed = await registry.checkAddressDetailed(ADDRESS);
      expect(detailed.flagged).toBe(true);
      expect(detailed.source).toBe('primary-provider:internal-list');
    });

    it('allows gradual migration by adding providers to existing registry one at a time', async () => {
      const registry = new ProviderRegistry({ policy: 'majority-vote' });

      // Start with one provider
      registry.register('provider-a', fakeProvider(false, 'list-a'));
      let result = await registry.checkAddress(ADDRESS);
      expect(result.flagged).toBe(false);

      // Add second provider
      registry.register('provider-b', fakeProvider(false, 'list-b'));
      result = await registry.checkAddress(ADDRESS);
      expect(result.flagged).toBe(false);

      // Add third provider
      registry.register('provider-c', fakeProvider(true, 'list-c'));
      result = await registry.checkAddress(ADDRESS);
      // Majority vote: 2 clear, 1 flagged = not flagged
      expect(result.flagged).toBe(false);
    });

    it('supports switching aggregation policies during migration', async () => {
      const provider1 = fakeProvider(true, 'list-a');
      const provider2 = fakeProvider(false, 'list-b');

      // Start with any-flag-wins policy
      const anyFlagRegistry = new ProviderRegistry({ policy: 'any-flag-wins' });
      anyFlagRegistry.register('a', provider1);
      anyFlagRegistry.register('b', provider2);

      const anyFlagResult = await anyFlagRegistry.checkAddress(ADDRESS);
      expect(anyFlagResult.flagged).toBe(true); // any-flag-wins: 1 flag → flag

      // Later migrate to majority-vote policy
      const majorityRegistry = new ProviderRegistry({ policy: 'majority-vote' });
      majorityRegistry.register('a', provider1);
      majorityRegistry.register('b', provider2);

      const majorityResult = await majorityRegistry.checkAddress(ADDRESS);
      expect(majorityResult.flagged).toBe(false); // majority-vote: 1 flag, 1 clear → clear
    });

    it('supports priority-override policy for gradual trust migration', async () => {
      // Common pattern: migrate from old provider (high priority) to new provider (lower priority)
      const registry = new ProviderRegistry({ policy: 'priority-override' });

      // During migration: old provider takes priority
      const oldProvider = fakeProvider(false, 'old-list');
      registry.register('old-provider', oldProvider, { priority: 0 });

      // New provider registered at lower priority
      const newProvider = fakeProvider(true, 'new-list');
      registry.register('new-provider', newProvider, { priority: 1 });

      const result = await registry.checkAddressDetailed(ADDRESS);
      // Old provider (priority 0) wins
      expect(result.source).toBe('old-provider:old-list');
      expect(result.flagged).toBe(false);

      // After migration is confident, swap priorities
      registry.unregister('old-provider');
      registry.unregister('new-provider');

      registry.register('old-provider', oldProvider, { priority: 1 });
      registry.register('new-provider', newProvider, { priority: 0 });

      const migratedResult = await registry.checkAddressDetailed(ADDRESS);
      // New provider (now priority 0) wins
      expect(migratedResult.source).toBe('new-provider:new-list');
      expect(migratedResult.flagged).toBe(true);
    });
  });
});
