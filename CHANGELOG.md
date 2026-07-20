# Changelog

All notable changes to this project are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Deployed

- Live at `https://x402-facilitator-evm.purplesquirrelnetworks.workers.dev` (Cloudflare Workers, PSM account). Verified in production against live chain: `/health` reports USDG `domainSeparatorMatches: true`; `/verify` correctly returns `insufficient_funds` for a valid signature from an empty account (proves recovery + live balance read), and `invalid_signature` for both a tampered signature and a cross-chain replay.

### Changed

- wrangler 3 → 4 and `@cloudflare/workers-types` 4 → 5. wrangler 3.114 warned on every invocation that it was out-of-date and risked critical errors; wrangler 4 requires workers-types v5 as a peer, so both had to move together. `wrangler.toml` needed no changes.
  - Verified: typecheck clean, 18/18 tests, hermetic route check 8/8.
  - **Not** verified: bundling or deploying. wrangler cannot authenticate (expired Cloudflare OAuth token), which blocks even `--dry-run` locally, and CI does not invoke wrangler. Unproven end-to-end until the first deploy.

## [0.1.0] — 2026-07-19

Initial build. Verify-only x402 facilitator for Robinhood Chain (`eip155:4663`), settling in USDG.

### Added

- `GET /`, `GET /supported`, `GET /health`, `POST /verify`.
- `POST /settle` returns `501 not_implemented` — settlement needs a funded hot signer on mainnet and is deliberately out of scope.
- Full EIP-3009 `exact`-scheme verification: signature recovery against USDG's verified EIP-712 domain, nonce replay check, balance check, and time-window validation.

### Why this exists

The hosted facilitator at `x402.org/facilitator` serves exactly one EVM network — `eip155:84532` — confirmed by querying its `/supported` endpoint. Robinhood Chain needs its own.

Robinhood Chain has no canonical USDC; bridged USDC arrives as USDG, so whether USDG implements EIP-3009 determined whether this was possible at all. It does — established by probing revert selectors, since USDG is an EIP-2535 Diamond whose facets are invisible to a bytecode scan.

### Design decisions worth keeping

- **A rejected payment is a successful request** (`200`, `isValid: false`, typed `invalidReason`). Only our own faults are non-2xx, so an unreachable RPC returns `502 unexpected_verify_error` and never `invalid_signature` — clients must be able to tell "you were rejected" from "we broke".
- **`authorization_expires_too_soon`** rejects an authorization that is valid now but expires within the settle window, which would otherwise pass verification and then revert on-chain.
- **Verification order is cheap-checks → signature → chain state**, so a forged or malformed payload costs no RPC calls.
- **`GET /health` re-asserts USDG's `DOMAIN_SEPARATOR`** against the live contract, so a Diamond upgrade surfaces as `degraded` rather than as a flood of unexplained `invalid_signature` rejections.

### Infrastructure

- CI enforces the verify-only invariant: a job greps `src/` for any key-handling surface and fails the build if one appears, and asserts `/settle` still refuses. Holding no keys is a property CI defends, not just a README claim.
- Live canary runs the real signing suite daily against mainnet.
- Chain config is self-contained; an earlier vendored copy of `universal-blockchain-mcp`'s registry, with its drift-check script, was removed as the wrong dependency in both directions.

[unreleased]: https://github.com/ExpertVagabond/x402-facilitator-evm/compare/main...HEAD
[0.1.0]: https://github.com/ExpertVagabond/x402-facilitator-evm/releases/tag/v0.1.0
