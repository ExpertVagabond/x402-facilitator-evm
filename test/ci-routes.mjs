/**
 * Hermetic CI check: the app must construct and serve its static routes without any
 * chain access.
 *
 * `/` and `/supported` are pure — they read config only. `/health` deliberately is
 * NOT exercised here, because it asserts USDG's DOMAIN_SEPARATOR against the live
 * contract; that belongs in the scheduled canary, not in a push gate.
 */
import app from "../src/index.ts";

let failed = false;
const check = (label, cond, detail) => {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    failed = true;
  }
};

const root = await (await app.request("/")).json();
check("GET / advertises verify-only", root.capabilities?.length === 1 && root.capabilities[0] === "verify",
  JSON.stringify(root.capabilities));
check("GET / serves eip155:4663", root.networks?.includes("eip155:4663"), JSON.stringify(root.networks));
check("GET / states it holds no keys", /no keys/i.test(root.settlement ?? ""), root.settlement);

const supported = await (await app.request("/supported")).json();
check("GET /supported returns exact scheme", supported.kinds?.[0]?.scheme === "exact");
check("GET /supported is x402Version 2", supported.kinds?.[0]?.x402Version === 2);
check("GET /supported lists USDG", supported.kinds?.[0]?.extra?.assets?.[0]?.symbol === "USDG");

const settle = await app.request("/settle", { method: "POST", body: "{}" });
check("POST /settle refuses with 501", settle.status === 501, `got ${settle.status}`);

const bad = await app.request("/verify", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ nope: true }),
});
check("POST /verify rejects malformed body with 400", bad.status === 400, `got ${bad.status}`);

if (failed) process.exit(1);
console.log("OK: static routes well-formed");
