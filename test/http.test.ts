import { test } from "node:test";
import assert from "node:assert/strict";
import app from "../src/index.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any; // assertions below are the real contract; typing each shape adds noise

const get = (p: string) => app.request(p);
const post = (p: string, body: unknown) =>
  app.request(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const json = (r: Response): Promise<Json> => r.json() as Promise<Json>;

test("GET / advertises verify-only and the served network", async () => {
  const r = await get("/"); const j = await json(r);
  assert.equal(r.status, 200);
  assert.deepEqual(j.networks, ["eip155:4663"]);
  assert.deepEqual(j.capabilities, ["verify"]);
});

test("GET /supported mirrors the facilitator contract", async () => {
  const j = await json(await get("/supported"));
  assert.equal(j.kinds.length, 1);
  assert.equal(j.kinds[0].network, "eip155:4663");
  assert.equal(j.kinds[0].scheme, "exact");
  assert.equal(j.kinds[0].x402Version, 2);
  assert.equal(j.kinds[0].extra.assets[0].symbol, "USDG");
  assert.equal(j.kinds[0].extra.assets[0].decimals, 6);
});

test("GET /health verifies USDG's on-chain domain separator", async () => {
  const r = await get("/health"); const j = await json(r);
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.status, "healthy");
  assert.equal(j.assets[0].domainSeparatorMatches, true);
});

test("POST /settle is explicitly refused, not silently broken", async () => {
  const r = await post("/settle", {}); const j = await json(r);
  assert.equal(r.status, 501);
  assert.equal(j.error, "not_implemented");
});

test("POST /verify rejects a malformed body with 400", async () => {
  const r = await post("/verify", { nope: true });
  assert.equal(r.status, 400);
  assert.equal((await json(r)).invalidReason, "malformed_request");
});

test("POST /verify returns 200 with isValid=false for a bad payment", async () => {
  const r = await post("/verify", {
    paymentPayload: { x402Version: 2, scheme: "exact", network: "eip155:4663",
      payload: { signature: "0x" + "11".repeat(65),
        authorization: { from: "0x000000000000000000000000000000000000dEaD",
          to: "0x000000000000000000000000000000000000dEaD", value: "1000000",
          validAfter: "0", validBefore: String(Math.floor(Date.now()/1000)+3600),
          nonce: "0x" + "22".repeat(32) } } },
    paymentRequirements: { scheme: "exact", network: "eip155:4663",
      payTo: "0x000000000000000000000000000000000000dEaD", maxAmountRequired: "1000000" },
  });
  // Rejection is a successful request — only our own faults are non-2xx.
  assert.equal(r.status, 200);
  const j = await json(r);
  assert.equal(j.isValid, false);
  assert.equal(j.invalidReason, "invalid_signature");
});
