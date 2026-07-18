/**
 * Re-prepend the vendoring header after `sync:registry` overwrites src/chains.ts
 * with the canonical copy. Idempotent — running twice does not duplicate the header.
 */
import { readFileSync, writeFileSync } from "node:fs";

const TARGET = new URL("../src/chains.ts", import.meta.url);
const MARKER = " * Chain registry — the single source of truth";
const HEADER = ` * VENDORED COPY — DO NOT EDIT HERE.
 *
 * Canonical source: ../../universal-blockchain-mcp/src/chains.ts
 * Edit there, then re-run \`npm run sync:registry\` in this package.
 *
 * Vendored rather than imported because universal-blockchain-mcp cannot currently
 * \`npm install\` (pre-existing peer-dependency conflict between typescript@5.9.3 and
 * @typescript-eslint/eslint-plugin@8.57.2), which makes a \`file:\` dependency on it
 * unreliable. \`npm run check:registry\` diffs the two and fails loudly on drift, so
 * divergence is caught in CI rather than discovered in production.
 *
`;

const src = readFileSync(TARGET, "utf8");

if (src.includes("VENDORED COPY")) {
  console.log("restore-vendor-header — header already present, nothing to do");
  process.exit(0);
}

const idx = src.indexOf(MARKER);
if (idx === -1) {
  console.error(`restore-vendor-header — marker not found: "${MARKER}"`);
  console.error("The canonical file's opening comment changed; update this script.");
  process.exit(1);
}

writeFileSync(TARGET, src.slice(0, idx) + HEADER + src.slice(idx));
console.log("restore-vendor-header — vendoring header restored");
