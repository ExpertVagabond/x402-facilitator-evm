# x402-facilitator-evm

[![CI](https://github.com/ExpertVagabond/x402-facilitator-evm/actions/workflows/ci.yml/badge.svg)](https://github.com/ExpertVagabond/x402-facilitator-evm/actions/workflows/ci.yml)
[![Live chain canary](https://github.com/ExpertVagabond/x402-facilitator-evm/actions/workflows/live.yml/badge.svg)](https://github.com/ExpertVagabond/x402-facilitator-evm/actions/workflows/live.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Verify-only [x402](https://x402.org) facilitator for **Robinhood Chain** (`eip155:4663`), settling in **USDG**.

## Why this exists

The hosted facilitator at `x402.org/facilitator` serves exactly one EVM network. Confirmed by querying it directly:

```bash
curl -s https://x402.org/facilitator/supported | jq '[.kinds[] | select(.network|startswith("eip155"))] | map(.network) | unique'
# => ["eip155:84532"]          # Base Sepolia, and nothing else
```

So x402 payments on Robinhood Chain need their own facilitator. This is it.

## The asset question

x402's `exact` EVM scheme settles via EIP-3009 `transferWithAuthorization` — the holder signs off-chain, a third party submits, the holder never needs gas. That requires an EIP-3009 asset.

**Robinhood Chain has no canonical USDC.** USDC bridged in from any of 13 supported chains arrives as **USDG** (Paxos Global Dollar), the chain's native stablecoin. So the question is whether USDG implements EIP-3009. It does — verified by probing revert selectors, since USDG is an EIP-2535 Diamond whose facets don't show up in the proxy bytecode:

| Call | Revert | Meaning |
| --- | --- | --- |
| `transferWithAuthorization` | `0x0f05f5bf` `AuthorizationExpired()` | present |
| `receiveWithAuthorization` | `0x5454b17d` `CallerMustBePayee()` | present |
| `cancelAuthorization` | `0x8baa579f` `InvalidSignature()` | present |
| `permit` | `0x1a15a3cc` `PermitExpired()` | EIP-2612 also present |
| *unknown selector* | `0x800ab12c` `FacetNotFound()` | control |

Domain errors thrown from inside real function bodies — not dispatch failures.

### EIP-712 domain

USDG does not expose `version()`, so the domain was **derived by matching the on-chain `DOMAIN_SEPARATOR`** rather than assumed:

```
name="Global Dollar", version="1", chainId=4663,
verifyingContract=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
  -> 0x7a3d7400b27830f4f91c2c16a082486d67c1befecaec2f53b33f1f35d5b62036  ✓ matches on-chain
```

`GET /health` re-asserts this against the live contract, so a Diamond upgrade that changes the domain surfaces as `degraded` (HTTP 503) rather than as a flood of mysterious `invalid_signature` rejections.

## Scope: verify only

There is **no `/settle`**, deliberately. Settlement requires a funded hot signer submitting `transferWithAuthorization` on mainnet. This service holds no keys and can move no funds. `POST /settle` returns `501 not_implemented` rather than failing obscurely.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/` | Service description and served networks |
| `GET` | `/supported` | x402 facilitator contract — drop-in for clients |
| `GET` | `/health` | Liveness **plus** on-chain domain-separator assertion |
| `POST` | `/verify` | Verify an `exact`-scheme payment payload |
| `POST` | `/settle` | `501` — out of scope by design |

### Error semantics

A rejected payment is a **successful request**: `200` with `isValid: false` and a machine-readable `invalidReason`. Only our own faults are non-2xx — an unreachable RPC returns `502 unexpected_verify_error`, never `invalid_signature`. Clients must be able to distinguish "you were rejected" from "we broke."

`invalidReason` values: `unsupported_scheme`, `unsupported_network`, `network_mismatch`, `unsupported_asset`, `invalid_signature`, `authorization_already_used`, `authorization_not_yet_valid`, `authorization_expired`, `authorization_expires_too_soon`, `recipient_mismatch`, `insufficient_value`, `insufficient_funds`, `unexpected_verify_error`.

### Verification order

Cheap pure checks → signature recovery → chain state. Chain reads only happen once the payload is internally sound, so a malformed or forged request costs no RPC calls.

`authorization_expires_too_soon` deserves note: an authorization valid *now* but expiring within `maxTimeoutSeconds` would pass a naive check and then fail on-chain when the settlement tx lands. It's rejected up front.

## Chain registry

`src/chains.ts` is self-contained — no sibling checkout, no vendoring, no sync script.

It briefly mirrored `universal-blockchain-mcp`'s registry, which was the wrong dependency in both directions: that package is a ZetaChain client with no reason to carry Robinhood Chain, and a facilitator should not need a neighbouring repo to build. Robinhood Chain now lives here and in `robinhood-chain-mcp`, each owning what it serves.

`toViemChain()` emits viem's `Chain` shape structurally without importing viem, so the definitions stay usable by consumers that have no EVM library.

## Development

```bash
npm install
npm run quality      # typecheck + tests
npm run dev          # wrangler dev
npm run deploy       # wrangler deploy
```

### CI split

- **`ci.yml`** gates every push, hermetically: typecheck on node 20/22/24 plus a static-route check. It also enforces the invariant this service exists under — a job greps `src/` for any signing or key-handling surface (`privateKey`, `mnemonic`, `signTransaction`, `walletClient`, …) and fails the build if one appears, and asserts `/settle` still returns `not_implemented`. Verify-only is a property CI defends, not just a README claim.
- **`live.yml`** runs daily. It signs real authorizations against live chain state, so a failure means USDG changed underneath us — most consequentially a `DOMAIN_SEPARATOR` change, which would silently invalidate every signature this facilitator has ever accepted.

Tests sign **real** EIP-3009 authorizations with throwaway keys and run them against live Robinhood Chain state. A fully valid payload from a fresh account lands on `insufficient_funds` — which is the proof that signature recovery and nonce lookup both succeeded, since they run first.

## Status

Not deployed (Cloudflare auth pending). Verify-only, no keys, no settlement.
