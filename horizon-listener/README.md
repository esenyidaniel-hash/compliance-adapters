# horizon-listener

An example/reference service that polls Soroban RPC for contract events emitted
by the `denylist-gate` and `allowlist-token` contracts, logs them, and
re-emits them to a webhook. Soroban RPC's `getEvents` is a cursor-based polling
API — there is no persistent server-sent-events stream for contract events at
that layer — so this package polls on an interval and tracks a cursor between
calls rather than holding open a live connection. "Reconnect" here means the
polling loop hit an error (RPC unreachable, rate-limited, cursor expired) and
backed off before retrying, not a literal TCP reconnect. This package
demonstrates the integration pattern app developers would build on top of;
it is not itself a production event pipeline.

## Runtime compatibility

This package requires **Node.js 20 or newer** because its HTTP webhook sender
uses the native `fetch` API provided by Node 20. Older Node.js versions do not
provide the required runtime fetch support and are not supported.

## Install

```sh
npm install
```

(This package is part of the `compliance-adapters` npm workspace; run install
from the repo root.)

## Configuration

Copy the root [`.env.example`](../.env.example) to `.env` at the repo root and
fill in the `horizon-listener` variables before running the service:

| Variable | Description |
|---|---|
| `STELLAR_RPC_URL` | Soroban RPC endpoint to poll for contract events |
| `STELLAR_NETWORK_PASSPHRASE` | Must match the network the RPC endpoint serves |
| `DENYLIST_GATE_CONTRACT_ID` | Deployed `denylist-gate` contract to subscribe to |
| `ALLOWLIST_TOKEN_CONTRACT_ID` | Deployed `allowlist-token` contract to subscribe to |
| `WEBHOOK_URL` | Endpoint that receives POSTed contract events |
| `POLL_INTERVAL_MS` | Polling interval in milliseconds (default `5000`) |
| `MAX_RETRIES` | Consecutive failures before the listener gives up (default `10`) |
| `START_LEDGER` | Starting ledger for the very first cursor-less event query |
| `WEBHOOK_SIGNING_SECRET` | Secret for HMAC-signing outbound webhook requests (optional) |
| `PORT` | Port for the example Express app (sep10-auth example) |

See the comments in `.env.example` for allowed values and testnet guidance.

## Quick example

```ts
import { Networks } from '@stellar/stellar-sdk';
import { RpcEventSource, HorizonListener, HttpWebhookSender } from 'horizon-listener';

const eventSource = new RpcEventSource({
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: Networks.TESTNET,
  contractIds: [process.env.DENYLIST_GATE_CONTRACT_ID!, process.env.ALLOWLIST_TOKEN_CONTRACT_ID!],
});

const webhook = new HttpWebhookSender({
  url: 'http://localhost:4000/webhook',
  signingSecret: process.env.WEBHOOK_SIGNING_SECRET,
});

const listener = new HorizonListener({
  eventSource,
  pollIntervalMs: 5000,
  onEvent: async (event) => {
    await webhook.send(event);
  },
});

listener.start().catch((err) => {
  console.error('horizon-listener gave up after repeated failures', err);
  process.exit(1);
});
```

A minimal stub receiver to point `HttpWebhookSender` at during local
development (using [Express](https://expressjs.com/), not a dependency of this
package):

```ts
import express from 'express';

const app = express();
app.use(express.json());
app.post('/webhook', (req, res) => {
  console.log('received event', req.body);
  res.sendStatus(200);
});
app.listen(4000);
```

## Polling mode vs stream mode

`HorizonListener` supports two polling modes via the `mode` option:

- **`poll`** (default) — fixed-interval polling. The listener always waits
  `pollIntervalMs` between each `getEvents` call, regardless of whether events
  were returned. Suitable for most use cases.

- **`stream`** — backoff-only "stream-like" mode. The listener polls again
  immediately after processing a full page of events, and only sleeps
  `pollIntervalMs` when a poll returns no new events. This reduces latency for
  high-activity contracts without hammering the RPC during quiet periods.

```ts
const listener = new HorizonListener({
  eventSource,
  onEvent: async (event) => { /* ... */ },
  mode: 'stream',      // or 'poll' (default)
  pollIntervalMs: 5000, // sleep duration during quiet periods
});
```

## Webhook signature verification

When `HttpWebhookSender` is constructed with a `signingSecret`, every outbound
request carries an `X-Timestamp` header and an `X-Signature` header of the
form:

```
X-Timestamp: <unix seconds at send time>
X-Signature: sha256=<hex-encoded HMAC-SHA256 of "<X-Timestamp>.<raw request body>", keyed by signingSecret>
```

The timestamp is folded into the signed material specifically so that a
receiver can detect replayed requests: because contract event payloads are
deterministic, a captured request with a valid signature could otherwise be
replayed indefinitely. The HMAC is computed over
`` `${timestamp}.${body}` `` where `body` is the exact JSON string sent as
the request body (before any parsing), so a receiver must verify against the
raw bytes, not a re-serialized version of the parsed body — re-serializing
can change key order or whitespace and produce a different digest.

A receiver must do two things to validate a request: recompute the HMAC over
`<X-Timestamp>.<raw body>` and compare it to `X-Signature` using a
constant-time comparison (to avoid leaking the secret through timing
differences), **and** reject requests whose `X-Timestamp` falls outside a
freshness window — a receiver should reject the request if they don't match,
if either header is missing, or if the timestamp is stale:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';
import express from 'express';

const WEBHOOK_SIGNING_SECRET = process.env.WEBHOOK_SIGNING_SECRET!;
// Reasonable default: tolerates delivery latency and retry backoff while
// still bounding how long a captured request stays replayable.
const MAX_TIMESTAMP_SKEW_SECONDS = 5 * 60;

const app = express();

// Capture the raw body bytes for HMAC verification before JSON parsing.
app.use(express.json({ verify: (req, _res, buf) => {
  (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
} }));

function isFreshTimestamp(timestampHeader: string | undefined): boolean {
  if (!timestampHeader || !/^\d+$/.test(timestampHeader)) return false;

  const timestamp = Number(timestampHeader);
  const skewSeconds = Math.abs(Date.now() / 1000 - timestamp);
  return skewSeconds <= MAX_TIMESTAMP_SKEW_SECONDS;
}

function isValidSignature(
  rawBody: Buffer,
  timestampHeader: string | undefined,
  signatureHeader: string | undefined,
): boolean {
  if (!timestampHeader || !signatureHeader) return false;

  const signedMaterial = Buffer.concat([Buffer.from(`${timestampHeader}.`), rawBody]);
  const expected = createHmac('sha256', WEBHOOK_SIGNING_SECRET).update(signedMaterial).digest('hex');
  const expectedHeader = `sha256=${expected}`;

  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expectedHeader);
  return a.length === b.length && timingSafeEqual(a, b);
}

app.post('/webhook', (req, res) => {
  const rawBody = (req as express.Request & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
  const timestampHeader = req.header('X-Timestamp');

  if (
    !isFreshTimestamp(timestampHeader) ||
    !isValidSignature(rawBody, timestampHeader, req.header('X-Signature'))
  ) {
    return res.sendStatus(401);
  }

  console.log('received event', req.body);
  res.sendStatus(200);
});
app.listen(4000);
```

If `signingSecret` is omitted, `HttpWebhookSender` sends requests without
`X-Timestamp` or `X-Signature` headers, exactly as before this feature was
added.

## Reconnect / backoff behavior

If `eventSource.getEvents(...)` throws (RPC unreachable, rate-limited, cursor
expired, etc.), `HorizonListener` does not crash: it logs a warning, waits an
exponentially increasing backoff delay (see `computeBackoffDelayMs` in
`src/backoff.ts`, capped at 30s by default with jitter), and retries. The
retry counter resets to zero after any subsequent successful poll. If
`maxRetries` consecutive failures are exceeded (default 10), `start()`
rejects so the caller knows the listener gave up — in a real deployment a
process manager would be responsible for restarting the process.

Individual `onEvent` handler errors are caught and logged without stopping
the polling loop, so one bad event doesn't take down the whole listener.

## Graceful shutdown

For clean shutdown in a long-running Node process, call `HorizonListener.stop()`
from a signal handler:

```ts
process.on('SIGINT', () => {
  console.log('Shutting down gracefully...');
  listener.stop();
});

process.on('SIGTERM', () => {
  console.log('Shutting down gracefully...');
  listener.stop();
});

listener.start().catch((err) => {
  console.error('horizon-listener gave up after repeated failures', err);
  process.exit(1);
});
```

See `examples/graceful-shutdown.ts` for a complete example using the webhook
forwarder factory.

## Logging

All logging is routed through an injectable `Logger` interface with a default
console-backed implementation. Log levels are used semantically:

- **debug** — Cursor advancement and other low-level operational details
- **info** — Successful event reception (one log per event received)
- **warn** — Recoverable poll failures with automatic retry (e.g., RPC unreachable, rate-limited)
- **error** — Handler errors and critical listener failures

Pass a custom `Logger` instance to `HorizonListener` options to customize
output (e.g., to route to a production logging service).

## Links

- [Root README](../README.md)
- [`compliance-primitives`](https://github.com/stellar-compliance-kit/compliance-primitives) —
  the on-chain `denylist-gate` and `allowlist-token` Soroban contracts this
  package listens to events from.
