/**
 * Settlement assets, keyed by chain.
 *
 * x402's `exact` EVM scheme settles via EIP-3009 `transferWithAuthorization`, which
 * lets a third party submit a transfer the holder signed off-chain — the holder never
 * needs gas. An asset is only usable here if it actually implements EIP-3009.
 */

export interface Eip712Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: `0x${string}`;
}

export interface AssetConfig {
  symbol: string;
  address: `0x${string}`;
  decimals: number;
  /**
   * EIP-712 domain used for TransferWithAuthorization signatures.
   *
   * Verified against the contract's on-chain DOMAIN_SEPARATOR rather than assumed:
   * keccak256(abi.encode(EIP712Domain_typehash, keccak(name), keccak(version),
   * chainId, verifyingContract)) reproduces 0x7a3d7400b27830f4f91c2c16a082486d67c1
   * befecaec2f53b33f1f35d5b62036 exactly for name="Global Dollar", version="1".
   * USDG does not expose version(), so this could not be read directly.
   */
  domain: Eip712Domain;
  /** Expected DOMAIN_SEPARATOR — asserted at startup to catch upgrades. */
  expectedDomainSeparator: `0x${string}`;
}

export const ASSETS: Record<string, Record<string, AssetConfig>> = {
  robinhood: {
    USDG: {
      symbol: "USDG",
      address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      decimals: 6,
      domain: {
        name: "Global Dollar",
        version: "1",
        chainId: 4663,
        verifyingContract: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      },
      expectedDomainSeparator:
        "0x7a3d7400b27830f4f91c2c16a082486d67c1befecaec2f53b33f1f35d5b62036",
    },
  },
};

/** Default settlement asset per chain. */
export const DEFAULT_ASSET: Record<string, string> = {
  robinhood: "USDG",
};

export function resolveAsset(
  chainKey: string,
  symbolOrAddress?: string,
): AssetConfig | undefined {
  const forChain = ASSETS[chainKey];
  if (!forChain) return undefined;
  if (!symbolOrAddress) return forChain[DEFAULT_ASSET[chainKey]];
  const needle = symbolOrAddress.toLowerCase();
  return Object.values(forChain).find(
    (a) =>
      a.symbol.toLowerCase() === needle || a.address.toLowerCase() === needle,
  );
}

/** EIP-3009 + ERC-20 surface this facilitator relies on. */
export const EIP3009_ABI = [
  {
    type: "function",
    name: "authorizationState",
    stateMutability: "view",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "DOMAIN_SEPARATOR",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
] as const;

/** EIP-712 struct for TransferWithAuthorization, per EIP-3009. */
export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;
