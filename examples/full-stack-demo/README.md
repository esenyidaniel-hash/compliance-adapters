# Full-stack Demo

This example app demonstrates an end-to-end integration of the three monorepo packages:

- `sep10-auth` protects a private Express route with SEP-10 bearer token verification
- `horizon-listener` watches Soroban RPC contract events and forwards them to a webhook
- `sanctions-oracle` syncs flagged addresses using a mock provider in dry-run mode

## Run the demo

From the repository root:

```bash
npm install
npm run build --workspaces --if-present
npm start --workspace=examples/full-stack-demo
```

The app listens on `http://localhost:3000` and exposes:

- `GET  /health`                   — liveness check; returns `{ status: 'ok', serverPublicKey }`.
- `GET  /auth?account=G…`          — issue a SEP-10 challenge for the given Stellar address.
- `POST /auth`                     — verify a signed SEP-10 challenge and return the authenticated address.
- `POST /auth/revoke`              — revoke a previously-issued token (logout).
- `GET  /sanctions/check?address=` — check a single Stellar address against the provider registry.
- `POST /sanctions/sync`           — trigger a full sanctions sync run; body: `{ addresses: string[], dryRun?: boolean }`.
- `POST /admin/listener/start`     — start the Horizon event listener (requires `X-Admin-Token` header).
- `POST /admin/listener/stop`      — stop the Horizon event listener (requires `X-Admin-Token` header).
- `GET  /metrics`                  — Prometheus metrics in text exposition format.

## Configuration

Use environment variables to customize runtime values:

- `PORT` — HTTP port the server listens on (default: `3001`).
- `HOME_DOMAIN` — SEP-10 home domain included in challenges (default: `localhost:<PORT>`).
- `SERVER_SECRET` — Stellar secret key (`S…`) used to sign SEP-10 challenges. Falls back to an ephemeral random keypair (regenerated on every restart) if unset — fine for a single local run, not for anything shared.
- `NETWORK_PASSPHRASE` — Stellar network passphrase (default: testnet passphrase).
- `CSV_SANCTIONS_PATH` — Path to a CSV watchlist file. When set, a `CsvSanctionsProvider` is prepended to the provider registry ahead of the mock provider.
- `DENYLIST_CONTRACT_ID` — Deployed `denylist-gate` contract ID. Required to enable the live RPC denylist writer and the Horizon event listener.
- `SOROBAN_RPC_URL` — Soroban RPC endpoint (default: `https://soroban-testnet.stellar.org`).
- `WEBHOOK_URL` — Webhook target URL for `horizon-listener` events. When unset, events are logged to stdout instead.
- `HORIZON_START_LEDGER` — Starting ledger for Horizon event polling.
- `ADMIN_TOKEN` — Shared secret required in the `X-Admin-Token` header for `POST /admin/listener/start` and `/admin/listener/stop`. When unset, all `/admin/*` routes return `503` (fail closed). Admin routes are also IP rate-limited.

## Hardening features not wired into this demo

This demo intentionally stays minimal, but each package it wires together has grown additional
hardening features that a production deployment would typically layer on top:

- **`sep10-auth`** — a `rateLimiter` middleware for throttling challenge/verify requests, and a
  `RevocationStore` for invalidating previously-issued sessions.
- **`sanctions-oracle`** — a `ProviderRegistry` for falling back across multiple sanctions data
  sources, a `CsvSanctionsProvider` for loading watchlists from a CSV file instead of the mock
  provider, and metrics/tracing instrumentation around sync runs.
- **`horizon-listener`** — matching metrics/tracing instrumentation around event polling and
  webhook delivery.

See each package's own README for usage details.
