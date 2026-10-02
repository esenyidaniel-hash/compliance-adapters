# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **sep10-auth** — rate limiting middleware for challenge/verify endpoints, session revocation
  via `RevocationStore`, and `client_domain` verification support.
- **sanctions-oracle** — `ProviderRegistry` for falling back across multiple sanctions data
  sources, `CsvSanctionsProvider` for CSV-backed watchlists, `RestSanctionsProvider`
  for REST-backed watchlist API calls, `RateLimitedSanctionsProvider`
  wrapper, `withRetry` retry-with-backoff helper, and metrics/tracing instrumentation around
  sync runs.
- **horizon-listener** — HMAC webhook request signing, stream/poll event source modes, and
  metrics/tracing instrumentation around event polling and webhook delivery.
- **backoff** — shared `@compliance-adapters/backoff` package extracting the exponential-backoff
  formula previously duplicated across `horizon-listener` and `sanctions-oracle`.
- End-to-end test suite (`e2e-tests`) exercising the packages against a live Soroban RPC/Horizon
  stack.

## [0.1.0] - 2024-07-24

### Added

- **sep10-auth** — SEP-10 web authentication challenge builder and verifier for Stellar addresses, with example Express middleware for protecting compliance endpoints.
- **sanctions-oracle** — `SanctionsProvider` interface and mock implementation for managing sanctioned address lists, plus sync script for pushing flagged addresses into deployed `denylist-gate` contract instances.
- **horizon-listener** — Event listener service polling Soroban RPC for `denylist-gate` and `allowlist-token` contract events, with webhook re-emission pattern for reacting to on-chain compliance state changes.
- Consolidated ESLint and Prettier configuration across monorepo packages.
- GitHub Actions CI workflow enforcing linting, building, and testing on all PRs and pushes to main.
- TypeScript configuration with Jest and ts-jest for all packages.
- MIT license and contributing guidelines.

[Unreleased]: https://github.com/stellar-compliance-kit/compliance-adapters/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/stellar-compliance-kit/compliance-adapters/releases/tag/v0.1.0
