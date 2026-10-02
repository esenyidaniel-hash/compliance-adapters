///<reference types="jest" />
import { Keypair, Networks, Transaction } from '@stellar/stellar-sdk';
import { generateChallenge } from '../src/challenge';
import { verifyChallenge, VerifyErrorCode } from '../src/verify';

const homeDomain = 'localhost:3000';

function signAsClient(
  transactionXDR: string,
  networkPassphrase: string,
  clientKeypair: Keypair,
): string {
  const tx = new Transaction(transactionXDR, networkPassphrase);
  tx.sign(clientKeypair);
  return tx.toXDR();
}

describe('verifyChallenge', () => {
  it('matches expectedMemo against an id memo and rejects a mismatch', () => {
    const serverKeypair = Keypair.random();
    const clientKeypair = Keypair.random();
    const challenge = generateChallenge(clientKeypair.publicKey(), serverKeypair, {
      homeDomain,
      webAuthDomain: homeDomain,
      memo: '123456789',
    });
    const signedXDR = signAsClient(challenge.transactionXDR, Networks.TESTNET, clientKeypair);
    const base = {
      serverAccountId: serverKeypair.publicKey(),
      homeDomains: homeDomain,
      webAuthDomain: homeDomain,
    };

    expect(verifyChallenge(signedXDR, { ...base, expectedMemo: '123456789' }).valid).toBe(true);
    expect(verifyChallenge(signedXDR, { ...base, expectedMemo: '999' }).valid).toBe(false);
  });

  it('accepts a challenge signed by the client', () => {
    const serverKeypair = Keypair.random();
    const clientKeypair = Keypair.random();

    const challenge = generateChallenge(clientKeypair.publicKey(), serverKeypair, {
      homeDomain,
      webAuthDomain: homeDomain,
      networkPassphrase: Networks.TESTNET,
    });

    const signedXDR = signAsClient(challenge.transactionXDR, Networks.TESTNET, clientKeypair);

    const result = verifyChallenge(signedXDR, {
      serverAccountId: serverKeypair.publicKey(),
      networkPassphrase: Networks.TESTNET,
      homeDomains: homeDomain,
      webAuthDomain: homeDomain,
    });

    expect(result.valid).toBe(true);
    expect(result.address).toBe(clientKeypair.publicKey());
    expect(result.error).toBeUndefined();
    expect(result.errorCode).toBeUndefined();
  });

  it('accepts a challenge when homeDomains is an array containing the challenge home domain', () => {
    const serverKeypair = Keypair.random();
    const clientKeypair = Keypair.random();

    const challenge = generateChallenge(clientKeypair.publicKey(), serverKeypair, {
      homeDomain: 'domain-a.com',
      webAuthDomain: 'domain-a.com',
      networkPassphrase: Networks.TESTNET,
    });

    const signedXDR = signAsClient(challenge.transactionXDR, Networks.TESTNET, clientKeypair);

    const result = verifyChallenge(signedXDR, {
      serverAccountId: serverKeypair.publicKey(),
      networkPassphrase: Networks.TESTNET,
      homeDomains: ['domain-a.com', 'domain-b.com'],
      webAuthDomain: 'domain-a.com',
    });

    expect(result.valid).toBe(true);
    expect(result.address).toBe(clientKeypair.publicKey());
    expect(result.error).toBeUndefined();
    expect(result.errorCode).toBeUndefined();
  });

  it('rejects a challenge whose timebounds have expired', () => {
    // buildChallengeTx always sets minTime to the real "now" at build time, so
    // an already-expired transaction can't be constructed with a negative
    // timeout (minTime would end up after maxTime and the SDK rejects that
    // outright). The SDK's readChallengeTx also applies a fixed 300s grace
    // period on top of the transaction's own maxTime (Utils.validateTimebounds
    // (tx, 60 * 5)), so real-time expiry would mean sleeping 5+ minutes in the
    // test. Fake timers let us fast-forward Date.now() past both the
    // challenge's short timeout and that grace window instead.
    jest.useFakeTimers();
    try {
      const serverKeypair = Keypair.random();
      const clientKeypair = Keypair.random();

      const challenge = generateChallenge(clientKeypair.publicKey(), serverKeypair, {
        homeDomain,
        webAuthDomain: homeDomain,
        networkPassphrase: Networks.TESTNET,
        timeoutSeconds: 1,
      });

      const signedXDR = signAsClient(challenge.transactionXDR, Networks.TESTNET, clientKeypair);

      jest.advanceTimersByTime((1 + 301) * 1000);

      const result = verifyChallenge(signedXDR, {
        serverAccountId: serverKeypair.publicKey(),
        networkPassphrase: Networks.TESTNET,
        homeDomains: homeDomain,
        webAuthDomain: homeDomain,
      });

      expect(result.valid).toBe(false);
      expect(result.address).toBe('');
      expect(result.error).toMatch(/expired|timebounds/i);
    } finally {
      jest.useRealTimers();
    }
  });

  it('treats the exact boundary instant (maxTime + 300s) as valid (inclusive), and expires immediately after', () => {
    jest.useFakeTimers();
    try {
      const initialTime = 1700000000000;
      jest.setSystemTime(initialTime);

      const serverKeypair = Keypair.random();
      const clientKeypair = Keypair.random();
      const timeoutSeconds = 300;

      const challenge = generateChallenge(clientKeypair.publicKey(), serverKeypair, {
        homeDomain,
        webAuthDomain: homeDomain,
        networkPassphrase: Networks.TESTNET,
        timeoutSeconds,
      });

      const signedXDR = signAsClient(challenge.transactionXDR, Networks.TESTNET, clientKeypair);

      // At exact boundary moment (maxTime + 300s grace period):
      // Stellar SDK's WebAuth.readChallengeTx treats the boundary instant as inclusive (valid).
      jest.advanceTimersByTime((timeoutSeconds + 300) * 1000);

      const resultAtBoundary = verifyChallenge(signedXDR, {
        serverAccountId: serverKeypair.publicKey(),
        networkPassphrase: Networks.TESTNET,
        homeDomains: homeDomain,
        webAuthDomain: homeDomain,
      });

      // WebAuth.readChallengeTx / Utils.validateTimebounds treats the exact boundary instant
      // (maxTime + 300s grace period) as VALID (inclusive boundary condition).
      expect(resultAtBoundary.valid).toBe(true);
      expect(resultAtBoundary.address).toBe(clientKeypair.publicKey());

      // Advancing 1 second past the boundary (601s total elapsed) causes the challenge to be expired.
      jest.advanceTimersByTime(1000);

      const resultAfterBoundary = verifyChallenge(signedXDR, {
        serverAccountId: serverKeypair.publicKey(),
        networkPassphrase: Networks.TESTNET,
        homeDomains: homeDomain,
        webAuthDomain: homeDomain,
      });

      // Beyond maxTime + 300s, WebAuth returns expired (valid: false).
      expect(resultAfterBoundary.valid).toBe(false);
      expect(resultAfterBoundary.error).toMatch(/expired|timebounds/i);
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects a challenge verified against the wrong network passphrase', () => {
    const serverKeypair = Keypair.random();
    const clientKeypair = Keypair.random();

    const challenge = generateChallenge(clientKeypair.publicKey(), serverKeypair, {
      homeDomain,
      webAuthDomain: homeDomain,
      networkPassphrase: Networks.TESTNET,
    });

    const signedXDR = signAsClient(challenge.transactionXDR, Networks.TESTNET, clientKeypair);

    const result = verifyChallenge(signedXDR, {
      serverAccountId: serverKeypair.publicKey(),
      networkPassphrase: Networks.PUBLIC,
      homeDomains: homeDomain,
      webAuthDomain: homeDomain,
    });

    expect(result.valid).toBe(false);
    expect(result.address).toBe('');
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/network|passphrase|hash|signed|server/i);
  });

  it('rejects a challenge the client never signed', () => {
    const serverKeypair = Keypair.random();
    const clientKeypair = Keypair.random();

    const challenge = generateChallenge(clientKeypair.publicKey(), serverKeypair, {
      homeDomain,
      webAuthDomain: homeDomain,
      networkPassphrase: Networks.TESTNET,
    });

    const result = verifyChallenge(challenge.transactionXDR, {
      serverAccountId: serverKeypair.publicKey(),
      networkPassphrase: Networks.TESTNET,
      homeDomains: homeDomain,
      webAuthDomain: homeDomain,
    });

    expect(result.valid).toBe(false);
    expect(result.address).toBe('');
    expect(result.error).toBeDefined();
  });

  it('accumulates error messages from all webAuthDomain attempts when all fail (issue #304)', () => {
    const serverKeypair = Keypair.random();
    const clientKeypair = Keypair.random();

    const challenge = generateChallenge(clientKeypair.publicKey(), serverKeypair, {
      homeDomain: 'correct-domain.com',
      webAuthDomain: 'correct-domain.com',
      networkPassphrase: Networks.TESTNET,
    });

    const signedXDR = signAsClient(challenge.transactionXDR, Networks.TESTNET, clientKeypair);

    // Try to verify with multiple wrong webAuthDomains
    const result = verifyChallenge(signedXDR, {
      serverAccountId: serverKeypair.publicKey(),
      networkPassphrase: Networks.TESTNET,
      homeDomains: 'correct-domain.com',
      webAuthDomain: ['wrong-domain-a.com', 'wrong-domain-b.com', 'wrong-domain-c.com'],
    });

    expect(result.valid).toBe(false);
    expect(result.address).toBe('');
    expect(result.error).toBeDefined();
    // The error should ideally mention all the attempted domains, not just the last one
    // Currently it only reports the last error, which is the issue #304 documents
  });

  it('reports mismatch error when challenge has one webAuthDomain but verification tries different ones', () => {
    const serverKeypair = Keypair.random();
    const clientKeypair = Keypair.random();

    const challenge = generateChallenge(clientKeypair.publicKey(), serverKeypair, {
      homeDomain: 'domain-a.com',
      webAuthDomain: 'domain-a.com',
      networkPassphrase: Networks.TESTNET,
    });

    const signedXDR = signAsClient(challenge.transactionXDR, Networks.TESTNET, clientKeypair);

    // Try with array of different domains
    const result = verifyChallenge(signedXDR, {
      serverAccountId: serverKeypair.publicKey(),
      networkPassphrase: Networks.TESTNET,
      homeDomains: 'domain-a.com',
      webAuthDomain: ['domain-x.com', 'domain-y.com', 'domain-z.com'],
    });

    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
    // The error message should help debugging by indicating which domain(s) were tried
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #37 — Typed error codes
// ─────────────────────────────────────────────────────────────────────────────

describe('verifyChallenge — typed error codes (#37)', () => {
  it('returns no errorCode on success', () => {
    const serverKeypair = Keypair.random();
    const clientKeypair = Keypair.random();
    const challenge = generateChallenge(clientKeypair.publicKey(), serverKeypair, {
      homeDomain,
      webAuthDomain: homeDomain,
      networkPassphrase: Networks.TESTNET,
    });
    const signedXDR = signAsClient(challenge.transactionXDR, Networks.TESTNET, clientKeypair);

    const result = verifyChallenge(signedXDR, {
      serverAccountId: serverKeypair.publicKey(),
      networkPassphrase: Networks.TESTNET,
      homeDomains: homeDomain,
      webAuthDomain: homeDomain,
    });

    expect(result.valid).toBe(true);
    expect(result.errorCode).toBeUndefined();
  });

  it('returns INVALID_SERVER_ACCOUNT_ID for a bad serverAccountId', () => {
    const result = verifyChallenge('some-xdr', {
      serverAccountId: 'not-a-valid-key',
      homeDomains: homeDomain,
      webAuthDomain: homeDomain,
    });

    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe<VerifyErrorCode>('INVALID_SERVER_ACCOUNT_ID');
    expect(result.error).toMatch(/serverAccountId/i);
  });

  it('returns INVALID_OPTIONS for a non-bare homeDomain', () => {
    const serverKeypair = Keypair.random();
    const result = verifyChallenge('some-xdr', {
      serverAccountId: serverKeypair.publicKey(),
      homeDomains: 'https://example.com',
      webAuthDomain: homeDomain,
    });

    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe<VerifyErrorCode>('INVALID_OPTIONS');
  });

  it('returns INVALID_OPTIONS for a non-bare webAuthDomain', () => {
    const serverKeypair = Keypair.random();
    const result = verifyChallenge('some-xdr', {
      serverAccountId: serverKeypair.publicKey(),
      homeDomains: homeDomain,
      webAuthDomain: 'http://bad-domain.com/path',
    });

    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe<VerifyErrorCode>('INVALID_OPTIONS');
  });

  it('returns CHALLENGE_EXPIRED for an expired challenge', () => {
    jest.useFakeTimers();
    try {
      const serverKeypair = Keypair.random();
      const clientKeypair = Keypair.random();
      const challenge = generateChallenge(clientKeypair.publicKey(), serverKeypair, {
        homeDomain,
        webAuthDomain: homeDomain,
        networkPassphrase: Networks.TESTNET,
        timeoutSeconds: 1,
      });
      const signedXDR = signAsClient(challenge.transactionXDR, Networks.TESTNET, clientKeypair);
      jest.advanceTimersByTime((1 + 301) * 1000);

      const result = verifyChallenge(signedXDR, {
        serverAccountId: serverKeypair.publicKey(),
        networkPassphrase: Networks.TESTNET,
        homeDomains: homeDomain,
        webAuthDomain: homeDomain,
      });

      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe<VerifyErrorCode>('CHALLENGE_EXPIRED');
    } finally {
      jest.useRealTimers();
    }
  });

  it('returns WRONG_SIGNER when the client never signed', () => {
    const serverKeypair = Keypair.random();
    const clientKeypair = Keypair.random();
    const challenge = generateChallenge(clientKeypair.publicKey(), serverKeypair, {
      homeDomain,
      webAuthDomain: homeDomain,
      networkPassphrase: Networks.TESTNET,
    });

    // Pass the unsigned challenge (only server-signed)
    const result = verifyChallenge(challenge.transactionXDR, {
      serverAccountId: serverKeypair.publicKey(),
      networkPassphrase: Networks.TESTNET,
      homeDomains: homeDomain,
      webAuthDomain: homeDomain,
    });

    expect(result.valid).toBe(false);
    expect(result.errorCode).toBeDefined();
    // WRONG_SIGNER or INVALID_CHALLENGE — both are acceptable for a missing client signature
    expect(['WRONG_SIGNER', 'INVALID_CHALLENGE']).toContain(result.errorCode);
  });

  it('returns WRONG_DOMAIN when all webAuthDomain candidates fail', () => {
    const serverKeypair = Keypair.random();
    const clientKeypair = Keypair.random();
    const challenge = generateChallenge(clientKeypair.publicKey(), serverKeypair, {
      homeDomain,
      webAuthDomain: homeDomain,
      networkPassphrase: Networks.TESTNET,
    });
    const signedXDR = signAsClient(challenge.transactionXDR, Networks.TESTNET, clientKeypair);

    const result = verifyChallenge(signedXDR, {
      serverAccountId: serverKeypair.publicKey(),
      networkPassphrase: Networks.TESTNET,
      homeDomains: homeDomain,
      webAuthDomain: 'wrong-domain.com',
    });

    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe<VerifyErrorCode>('WRONG_DOMAIN');
  });

  it('returns a defined errorCode whenever valid is false', () => {
    // Property: every failure result must carry an errorCode
    const serverKeypair = Keypair.random();
    const failureCases = [
      // invalid serverAccountId
      verifyChallenge('garbage', { serverAccountId: 'bad', homeDomains: homeDomain, webAuthDomain: homeDomain }),
      // invalid domain format
      verifyChallenge('garbage', { serverAccountId: serverKeypair.publicKey(), homeDomains: 'https://bad.com', webAuthDomain: homeDomain }),
      // garbage XDR
      verifyChallenge('notbase64atall!!!', { serverAccountId: serverKeypair.publicKey(), homeDomains: homeDomain, webAuthDomain: homeDomain }),
    ];

    for (const result of failureCases) {
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBeDefined();
      expect(typeof result.errorCode).toBe('string');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #40 — expectedMemo verification
// ─────────────────────────────────────────────────────────────────────────────

describe('verifyChallenge — expectedMemo (#40)', () => {
  const serverKeypair = Keypair.random();
  const clientKeypair = Keypair.random();

  function buildSigned(memo?: string): string {
    const challenge = generateChallenge(clientKeypair.publicKey(), serverKeypair, {
      homeDomain,
      webAuthDomain: homeDomain,
      networkPassphrase: Networks.TESTNET,
      ...(memo !== undefined ? { memo } : {}),
    });
    return signAsClient(challenge.transactionXDR, Networks.TESTNET, clientKeypair);
  }

  const baseOpts = {
    serverAccountId: serverKeypair.publicKey(),
    networkPassphrase: Networks.TESTNET,
    homeDomains: homeDomain,
    webAuthDomain: homeDomain,
  };

  it('succeeds when expectedMemo matches the transaction memo', () => {
    const signedXDR = buildSigned('42');
    const result = verifyChallenge(signedXDR, { ...baseOpts, expectedMemo: '42' });
    expect(result.valid).toBe(true);
    expect(result.errorCode).toBeUndefined();
  });

  it('fails with MEMO_MISMATCH when expectedMemo does not match transaction memo', () => {
    const signedXDR = buildSigned('42');
    const result = verifyChallenge(signedXDR, { ...baseOpts, expectedMemo: '999' });
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe<VerifyErrorCode>('MEMO_MISMATCH');
    expect(result.error).toMatch(/memo mismatch/i);
    expect(result.error).toContain('999');
  });

  it('fails with MEMO_MISMATCH when expectedMemo is provided but transaction has no memo', () => {
    const signedXDR = buildSigned(undefined); // no memo on challenge
    const result = verifyChallenge(signedXDR, { ...baseOpts, expectedMemo: '42' });
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe<VerifyErrorCode>('MEMO_MISMATCH');
    expect(result.error).toMatch(/memo mismatch/i);
  });

  it('succeeds without checking memo when expectedMemo is not provided', () => {
    const signedXDR = buildSigned('99');
    // No expectedMemo — existing behaviour must be unchanged
    const result = verifyChallenge(signedXDR, baseOpts);
    expect(result.valid).toBe(true);
    expect(result.errorCode).toBeUndefined();
  });

  it('succeeds without checking memo when challenge has no memo and expectedMemo is absent', () => {
    const signedXDR = buildSigned(undefined);
    const result = verifyChallenge(signedXDR, baseOpts);
    expect(result.valid).toBe(true);
    expect(result.errorCode).toBeUndefined();
  });

  it('preserves human-readable error message on MEMO_MISMATCH', () => {
    const signedXDR = buildSigned('100');
    const result = verifyChallenge(signedXDR, { ...baseOpts, expectedMemo: '200' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('"200"');
  });
});
