import { SanctionsProvider } from '../src/SanctionsProvider';
import { MockSanctionsProvider, MOCK_FLAGGED_ADDRESSES } from '../src/mockProvider';
import { CsvSanctionsProvider } from '../src/csvProvider';
import { RestSanctionsProvider } from '../src/restProvider';
import * as path from 'path';
import { assertSanctionsProviderContract } from './providerContract';

const KNOWN_FLAGGED_ADDRESS = Object.keys(MOCK_FLAGGED_ADDRESSES)[0];
const KNOWN_UNFLAGGED_ADDRESS = 'GDNOTPRESENTINANYMOCKWATCHLISTAAAAAAAAAAAAAAAAAAAAAAAAAA';

describe('SanctionsProvider interface conformance', () => {
  it('MockSanctionsProvider conforms to the SanctionsProvider contract', async () => {
    const provider = new MockSanctionsProvider();
    await assertSanctionsProviderContract(provider);
  });

  it('CsvSanctionsProvider conforms to the SanctionsProvider contract', async () => {
    const csvPath = path.join(__dirname, 'fixtures', 'addresses.csv');
    await assertSanctionsProviderContract(new CsvSanctionsProvider(csvPath));
  });

  it('RestSanctionsProvider conforms to the SanctionsProvider contract', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ is_flagged: false, lists: [] }),
    } as unknown as Response);
    const provider = new RestSanctionsProvider({
      apiBaseUrl: 'https://api.example.com',
      apiKey: 'test-key',
      fetchImpl,
    });
    await assertSanctionsProviderContract(provider);
  });
});

describe('MockSanctionsProvider', () => {
  it('flags a known mock-watchlist address', async () => {
    const provider = new MockSanctionsProvider();
    const result = await provider.checkAddress(KNOWN_FLAGGED_ADDRESS);
    expect(result.flagged).toBe(true);
    expect(result.source).toBe(MOCK_FLAGGED_ADDRESSES[KNOWN_FLAGGED_ADDRESS]);
  });

  it('does not flag an address absent from the mock watchlist', async () => {
    const provider = new MockSanctionsProvider();
    const result = await provider.checkAddress(KNOWN_UNFLAGGED_ADDRESS);
    expect(result.flagged).toBe(false);
    expect(result.source).toBe('mock-watchlist-v1');
  });
});
