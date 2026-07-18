/**
 * x402 EVM facilitator — verify-only.
 *
 * The hosted facilitator at x402.org/facilitator serves exactly one EVM network
 * (eip155:84532, Base Sepolia). This one serves Robinhood Chain (eip155:4663),
 * settling in USDG — the chain's native stablecoin, which implements EIP-3009.
 *
 * SCOPE: /verify only. There is deliberately no /settle, because settling requires a
 * funded hot signer submitting transferWithAuthorization on mainnet. That is a
 * separate, sign-off-gated change. This service holds no keys and can move no funds.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { CHAINS, resolveChain } from "./chains.ts";
import { ASSETS, resolveAsset } from "./assets.ts";
import { verifyPayment, checkAssetDomain, fromCaip2 } from "./verify.ts";
import type { PaymentPayload, PaymentRequirements } from "./verify.ts";

const app = new Hono();
app.use("/*", cors());

/** Chains this facilitator will verify for — those with a configured EIP-3009 asset. */
const SERVED_CHAINS = Object.keys(ASSETS).filter((k) => resolveChain(k));

const caip2 = (key: string) => `eip155:${resolveChain(key)!.chainId}`;

app.get("/", (c) =>
  c.json({
    service: "x402-facilitator-evm",
    scheme: "exact",
    capabilities: ["verify"],
    settlement: "not supported — this facilitator holds no keys",
    networks: SERVED_CHAINS.map(caip2),
  }),
);

/**
 * Mirrors the shape of the hosted facilitator's /supported so existing x402 clients
 * can point here without special-casing.
 */
app.get("/supported", (c) =>
  c.json({
    kinds: SERVED_CHAINS.map((key) => ({
      x402Version: 2,
      scheme: "exact",
      network: caip2(key),
      extra: {
        assets: Object.values(ASSETS[key]).map((a) => ({
          symbol: a.symbol,
          address: a.address,
          decimals: a.decimals,
        })),
        verifyOnly: true,
      },
    })),
  }),
);

/** Liveness + a real correctness check: has the asset's EIP-712 domain drifted? */
app.get("/health", async (c) => {
  const assets = await Promise.all(
    SERVED_CHAINS.flatMap((key) =>
      Object.values(ASSETS[key]).map(async (a) => {
        const d = await checkAssetDomain(key, a);
        return {
          network: caip2(key),
          asset: a.symbol,
          domainSeparatorMatches: d.ok,
          ...(d.ok ? {} : { expected: a.expectedDomainSeparator, onchain: d.onchain, detail: d.detail }),
        };
      }),
    ),
  );
  const healthy = assets.every((a) => a.domainSeparatorMatches);
  return c.json({ status: healthy ? "healthy" : "degraded", assets }, healthy ? 200 : 503);
});

app.post("/verify", async (c) => {
  let body: { paymentPayload?: PaymentPayload; paymentRequirements?: PaymentRequirements };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ isValid: false, invalidReason: "malformed_request", detail: "body is not valid JSON" }, 400);
  }

  const { paymentPayload, paymentRequirements } = body;
  if (!paymentPayload?.payload?.authorization || !paymentRequirements) {
    return c.json(
      {
        isValid: false,
        invalidReason: "malformed_request",
        detail: "expected { paymentPayload: { payload: { signature, authorization } }, paymentRequirements }",
      },
      400,
    );
  }

  const result = await verifyPayment(paymentPayload, paymentRequirements);
  // A failed verification is a successful request: 200 with isValid=false. Only our
  // own faults are non-2xx, so clients can tell "you were rejected" from "we broke".
  const status = result.invalidReason === "unexpected_verify_error" ? 502 : 200;
  return c.json(result, status);
});

app.post("/settle", (c) =>
  c.json(
    {
      error: "not_implemented",
      detail:
        "This facilitator is verify-only. Settlement requires a funded signer to submit transferWithAuthorization; that is a separate, approval-gated deployment.",
    },
    501,
  ),
);

export { app, SERVED_CHAINS, caip2, fromCaip2, resolveAsset, CHAINS };
export default app;
