/**
 * x402 `exact` scheme verification for EVM chains, via EIP-3009.
 *
 * Verification is deliberately total: every check runs against live chain state, and
 * the function returns a single machine-readable `invalidReason` rather than throwing.
 * A caller must be able to distinguish "this signature is forged" from "this RPC is
 * down" — the former is a client error, the latter is ours. Unreachable chain state
 * yields `unexpected_verify_error`, never `invalid_signature`.
 */

import {
  createPublicClient,
  http,
  getAddress,
  verifyTypedData,
  type Chain,
} from "viem";
import { resolveChain, resolveRpcUrl, toViemChain } from "./chains.ts";
import {
  resolveAsset,
  EIP3009_ABI,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  type AssetConfig,
} from "./assets.ts";

export interface Authorization {
  from: `0x${string}`;
  to: `0x${string}`;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: `0x${string}`;
}

export interface PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  payload: {
    signature: `0x${string}`;
    authorization: Authorization;
  };
}

export interface PaymentRequirements {
  scheme: string;
  network: string;
  payTo: string;
  maxAmountRequired: string;
  asset?: string;
  maxTimeoutSeconds?: number;
}

export type InvalidReason =
  | "unsupported_scheme"
  | "unsupported_network"
  | "network_mismatch"
  | "unsupported_asset"
  | "invalid_signature"
  | "authorization_already_used"
  | "authorization_not_yet_valid"
  | "authorization_expired"
  | "authorization_expires_too_soon"
  | "recipient_mismatch"
  | "insufficient_value"
  | "insufficient_funds"
  | "unexpected_verify_error";

export interface VerifyResult {
  isValid: boolean;
  invalidReason?: InvalidReason;
  /** Detail for humans; never parse this. */
  detail?: string;
  payer?: `0x${string}`;
}

const SUPPORTED_SCHEME = "exact";

/** CAIP-2 (`eip155:4663`) -> registry key. */
export function fromCaip2(network: string): string | undefined {
  const m = /^eip155:(\d+)$/.exec(network.trim());
  const chain = resolveChain(m ? m[1] : network);
  return chain?.key;
}

function clientFor(chainKey: string) {
  const chain = resolveChain(chainKey)!;
  // toViemChain emits viem's Chain shape structurally (see chains.ts); the assertion
  // bridges the two nominal types without pulling viem into the registry module.
  return createPublicClient({
    chain: toViemChain(chain) as Chain,
    transport: http(resolveRpcUrl(chain)),
  });
}

const fail = (r: InvalidReason, detail?: string): VerifyResult => ({
  isValid: false,
  invalidReason: r,
  ...(detail ? { detail } : {}),
});

export async function verifyPayment(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  opts: { now?: number } = {},
): Promise<VerifyResult> {
  if (payload.scheme !== SUPPORTED_SCHEME)
    return fail("unsupported_scheme", `expected "${SUPPORTED_SCHEME}"`);
  if (requirements.scheme !== SUPPORTED_SCHEME)
    return fail("unsupported_scheme", "requirements specify a different scheme");
  if (payload.network !== requirements.network)
    return fail(
      "network_mismatch",
      `payload ${payload.network} vs requirements ${requirements.network}`,
    );

  const chainKey = fromCaip2(payload.network);
  if (!chainKey) return fail("unsupported_network", payload.network);

  const asset = resolveAsset(chainKey, requirements.asset);
  if (!asset)
    return fail(
      "unsupported_asset",
      `no EIP-3009 asset for ${chainKey}${requirements.asset ? ` matching ${requirements.asset}` : ""}`,
    );

  const auth = payload.payload.authorization;

  // --- Pure checks first: cheap, and they need no network. ---

  let from: `0x${string}`, to: `0x${string}`, payTo: `0x${string}`;
  try {
    from = getAddress(auth.from);
    to = getAddress(auth.to);
    payTo = getAddress(requirements.payTo);
  } catch {
    return fail("invalid_signature", "malformed address in authorization");
  }

  if (to !== payTo)
    return fail("recipient_mismatch", `authorization pays ${to}, expected ${payTo}`);

  let value: bigint, required: bigint, validAfter: bigint, validBefore: bigint;
  try {
    value = BigInt(auth.value);
    required = BigInt(requirements.maxAmountRequired);
    validAfter = BigInt(auth.validAfter);
    validBefore = BigInt(auth.validBefore);
  } catch {
    return fail("invalid_signature", "non-numeric amount or time bound");
  }

  if (value < required)
    return fail("insufficient_value", `authorized ${value} < required ${required}`);

  const now = BigInt(opts.now ?? Math.floor(Date.now() / 1000));
  if (validAfter > now)
    return fail("authorization_not_yet_valid", `validAfter=${validAfter} > now=${now}`);
  if (validBefore <= now)
    return fail("authorization_expired", `validBefore=${validBefore} <= now=${now}`);

  // The settlement tx must still be valid by the time it lands, not merely now.
  const grace = BigInt(requirements.maxTimeoutSeconds ?? 60);
  if (validBefore <= now + grace)
    return fail(
      "authorization_expires_too_soon",
      `validBefore=${validBefore} leaves under ${grace}s to settle`,
    );

  // --- Signature: verified against the asset's own EIP-712 domain. ---

  let signatureValid: boolean;
  try {
    signatureValid = await verifyTypedData({
      address: from,
      domain: asset.domain,
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: { from, to, value, validAfter, validBefore, nonce: auth.nonce },
      signature: payload.payload.signature,
    });
  } catch (e) {
    return fail("invalid_signature", `malformed signature: ${errText(e)}`);
  }
  if (!signatureValid)
    return fail("invalid_signature", "signature does not recover to authorization.from");

  // --- Chain state last: only reached once the payload is internally sound. ---

  try {
    const client = clientFor(chainKey);
    const [used, balance] = await Promise.all([
      client.readContract({
        address: asset.address,
        abi: EIP3009_ABI,
        functionName: "authorizationState",
        args: [from, auth.nonce],
      }) as Promise<boolean>,
      client.readContract({
        address: asset.address,
        abi: EIP3009_ABI,
        functionName: "balanceOf",
        args: [from],
      }) as Promise<bigint>,
    ]);

    // Replay protection: EIP-3009 nonces are random bytes32, not sequential.
    if (used)
      return fail("authorization_already_used", `nonce ${auth.nonce} already consumed`);
    if (balance < value)
      return fail("insufficient_funds", `balance ${balance} < value ${value}`);

    return { isValid: true, payer: from };
  } catch (e) {
    // Chain unreachable is OUR failure, not a bad payment. Never report it as invalid.
    return fail("unexpected_verify_error", `chain state read failed: ${errText(e)}`);
  }
}

/**
 * Assert an asset's on-chain DOMAIN_SEPARATOR still matches what we hold. A diamond
 * upgrade that changed the domain would otherwise silently invalidate every signature
 * while looking like user error.
 */
export async function checkAssetDomain(
  chainKey: string,
  asset: AssetConfig,
): Promise<{ ok: boolean; onchain?: string; detail?: string }> {
  try {
    const onchain = (await clientFor(chainKey).readContract({
      address: asset.address,
      abi: EIP3009_ABI,
      functionName: "DOMAIN_SEPARATOR",
    })) as string;
    return {
      ok: onchain.toLowerCase() === asset.expectedDomainSeparator.toLowerCase(),
      onchain,
    };
  } catch (e) {
    return { ok: false, detail: errText(e) };
  }
}

function errText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 200);
}
