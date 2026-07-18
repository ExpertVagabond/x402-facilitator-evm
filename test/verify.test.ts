/**
 * Verification tests against LIVE Robinhood Chain state.
 *
 * The signatures here are real: each test derives a throwaway key, signs an actual
 * EIP-3009 TransferWithAuthorization over USDG's verified domain, and runs it through
 * verifyPayment. A freshly generated account holds no USDG, so a fully valid payload
 * lands on `insufficient_funds` — which is itself the proof that signature recovery
 * and nonce lookup both succeeded, since those run first.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { verifyPayment, fromCaip2 } from "../src/verify.ts";
import { resolveAsset, TRANSFER_WITH_AUTHORIZATION_TYPES } from "../src/assets.ts";

const NETWORK = "eip155:4663";
const PAY_TO = "0x000000000000000000000000000000000000dEaD";
const usdg = resolveAsset("robinhood")!;

const now = () => Math.floor(Date.now() / 1000);

function randomNonce(): `0x${string}` {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return `0x${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

async function signedPayload(overrides: Record<string, unknown> = {}) {
  const account = privateKeyToAccount(generatePrivateKey());
  const auth = {
    from: account.address,
    to: PAY_TO as `0x${string}`,
    value: 1_000_000n, // 1 USDG (6 decimals)
    validAfter: BigInt(now() - 60),
    validBefore: BigInt(now() + 3600),
    nonce: randomNonce(),
    ...overrides,
  };
  const signature = await account.signTypedData({
    domain: usdg.domain,
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: auth,
  });
  return {
    account,
    payload: {
      x402Version: 2,
      scheme: "exact",
      network: NETWORK,
      payload: {
        signature,
        authorization: {
          from: auth.from,
          to: auth.to,
          value: auth.value.toString(),
          validAfter: auth.validAfter.toString(),
          validBefore: auth.validBefore.toString(),
          nonce: auth.nonce,
        },
      },
    },
  };
}

const requirements = (over: Record<string, unknown> = {}) => ({
  scheme: "exact",
  network: NETWORK,
  payTo: PAY_TO,
  maxAmountRequired: "1000000",
  maxTimeoutSeconds: 60,
  ...over,
});

test("CAIP-2 eip155:4663 resolves to the robinhood registry key", () => {
  assert.equal(fromCaip2("eip155:4663"), "robinhood");
  assert.equal(fromCaip2("eip155:999999"), undefined);
});

test("valid signature passes recovery and reaches chain state", async () => {
  const { payload, account } = await signedPayload();
  const r = await verifyPayment(payload, requirements());
  // Throwaway account holds no USDG — reaching this reason means the signature
  // verified and the nonce lookup succeeded.
  assert.equal(r.invalidReason, "insufficient_funds", `got ${r.invalidReason}: ${r.detail}`);
  assert.equal(r.isValid, false);
  assert.match(r.detail!, /balance 0 </);
  assert.ok(account.address);
});

test("tampered signature is rejected as invalid_signature", async () => {
  const { payload } = await signedPayload();
  const sig = payload.payload.signature;
  // Flip one byte in r.
  payload.payload.signature = (sig.slice(0, 10) +
    (sig[10] === "a" ? "b" : "a") +
    sig.slice(11)) as `0x${string}`;
  const r = await verifyPayment(payload, requirements());
  assert.equal(r.invalidReason, "invalid_signature");
});

test("authorization for a different recipient is rejected", async () => {
  const { payload } = await signedPayload();
  const r = await verifyPayment(
    payload,
    requirements({ payTo: "0x0000000000000000000000000000000000000001" }),
  );
  assert.equal(r.invalidReason, "recipient_mismatch");
});

test("underpayment is rejected before any network call", async () => {
  const { payload } = await signedPayload();
  const r = await verifyPayment(payload, requirements({ maxAmountRequired: "2000000" }));
  assert.equal(r.invalidReason, "insufficient_value");
});

test("expired authorization is rejected", async () => {
  const { payload } = await signedPayload({
    validAfter: BigInt(now() - 7200),
    validBefore: BigInt(now() - 3600),
  });
  const r = await verifyPayment(payload, requirements());
  assert.equal(r.invalidReason, "authorization_expired");
});

test("authorization expiring inside the settle window is rejected", async () => {
  const { payload } = await signedPayload({ validBefore: BigInt(now() + 10) });
  const r = await verifyPayment(payload, requirements({ maxTimeoutSeconds: 60 }));
  assert.equal(r.invalidReason, "authorization_expires_too_soon");
});

test("not-yet-valid authorization is rejected", async () => {
  const { payload } = await signedPayload({ validAfter: BigInt(now() + 3600) });
  const r = await verifyPayment(payload, requirements());
  assert.equal(r.invalidReason, "authorization_not_yet_valid");
});

test("network mismatch between payload and requirements is rejected", async () => {
  const { payload } = await signedPayload();
  const r = await verifyPayment(payload, requirements({ network: "eip155:84532" }));
  assert.equal(r.invalidReason, "network_mismatch");
});

test("unsupported network is rejected", async () => {
  const { payload } = await signedPayload();
  payload.network = "eip155:999999";
  const r = await verifyPayment(payload, requirements({ network: "eip155:999999" }));
  assert.equal(r.invalidReason, "unsupported_network");
});

test("non-exact scheme is rejected", async () => {
  const { payload } = await signedPayload();
  payload.scheme = "upto";
  const r = await verifyPayment(payload, requirements());
  assert.equal(r.invalidReason, "unsupported_scheme");
});

test("a signature valid for another chain does not verify here", async () => {
  // Same struct, wrong chainId in the domain — the classic replay a naive
  // implementation would accept.
  const account = privateKeyToAccount(generatePrivateKey());
  const auth = {
    from: account.address,
    to: PAY_TO as `0x${string}`,
    value: 1_000_000n,
    validAfter: BigInt(now() - 60),
    validBefore: BigInt(now() + 3600),
    nonce: randomNonce(),
  };
  const signature = await account.signTypedData({
    domain: { ...usdg.domain, chainId: 84532 },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: auth,
  });
  const r = await verifyPayment(
    {
      x402Version: 2,
      scheme: "exact",
      network: NETWORK,
      payload: {
        signature,
        authorization: {
          from: auth.from,
          to: auth.to,
          value: auth.value.toString(),
          validAfter: auth.validAfter.toString(),
          validBefore: auth.validBefore.toString(),
          nonce: auth.nonce,
        },
      },
    },
    requirements(),
  );
  assert.equal(r.invalidReason, "invalid_signature");
});
