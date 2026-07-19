/**
 * Chains this facilitator serves.
 *
 * Self-contained by design. This was briefly a vendored copy of
 * universal-blockchain-mcp's registry, which was the wrong dependency in both
 * directions: that package is a ZetaChain client and has no reason to carry
 * Robinhood Chain, and a facilitator should not need a sibling checkout to build.
 *
 * Chain IDs were confirmed against the live RPCs via eth_chainId (mainnet 0x1237 =
 * 4663, testnet 0xb626 = 46630) rather than taken from documentation.
 */

export interface ChainConfig {
  key: string;
  name: string;
  chainId: number;
  rpcUrl: string;
  explorerUrl?: string;
  explorerName?: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  testnet: boolean;
  aliases?: string[];
}

export const CHAINS: Record<string, ChainConfig> = {
  robinhood: {
    key: "robinhood",
    name: "Robinhood Chain",
    chainId: 4663,
    rpcUrl: "https://rpc.mainnet.chain.robinhood.com/",
    explorerUrl: "https://robinhoodchain.blockscout.com",
    explorerName: "Blockscout",
    // Arbitrum Orbit L2 settling on Ethereum; gas is ETH, not a custom token.
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    testnet: false,
    aliases: ["robinhood-mainnet", "rh"],
  },
  "robinhood-testnet": {
    key: "robinhood-testnet",
    name: "Robinhood Chain Testnet",
    chainId: 46630,
    rpcUrl: "https://rpc.testnet.chain.robinhood.com/",
    explorerUrl: "https://explorer.testnet.chain.robinhood.com",
    explorerName: "Blockscout",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    testnet: true,
    aliases: ["rh-testnet"],
  },
};

export const ACCEPTED_NETWORK_VALUES: string[] = Object.values(CHAINS).flatMap((c) => [
  c.key,
  ...(c.aliases ?? []),
]);

export const DEFAULT_CHAIN_KEY = "robinhood";

/** Resolve a key, alias, or chain ID. Returns undefined rather than throwing. */
export function resolveChain(network?: string): ChainConfig | undefined {
  const needle = (network ?? DEFAULT_CHAIN_KEY).trim().toLowerCase();
  return Object.values(CHAINS).find(
    (c) =>
      c.key === needle ||
      (c.aliases ?? []).includes(needle) ||
      String(c.chainId) === needle,
  );
}

/**
 * RPC endpoint, honouring env overrides in precedence order:
 *   1. RPC_URL_<KEY>  (e.g. RPC_URL_ROBINHOOD)
 *   2. RPC_URL
 *   3. the configured default
 */
export function resolveRpcUrl(chain: ChainConfig): string {
  const envKey = `RPC_URL_${chain.key.toUpperCase().replace(/-/g, "_")}`;
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env;
  return env?.[envKey] || env?.RPC_URL || chain.rpcUrl;
}

/** viem's `Chain` shape, structurally — keeps viem optional for consumers. */
export interface ViemChainShape {
  id: number;
  name: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrls: { default: { http: string[] } };
  blockExplorers?: { default: { name: string; url: string } };
  testnet: boolean;
}

/**
 * Derive a viem-compatible Chain. viem's `defineChain` is effectively identity — it
 * exists for const type inference — so a structurally identical object is accepted
 * by createPublicClient without importing viem here.
 */
export function toViemChain(chainOrKey: ChainConfig | string): ViemChainShape {
  const chain = typeof chainOrKey === "string" ? resolveChain(chainOrKey) : chainOrKey;
  if (!chain) {
    throw new Error(
      `Unknown network "${chainOrKey}". Valid values: ${ACCEPTED_NETWORK_VALUES.join(", ")}`,
    );
  }
  return {
    id: chain.chainId,
    name: chain.name,
    nativeCurrency: { ...chain.nativeCurrency },
    rpcUrls: { default: { http: [resolveRpcUrl(chain)] } },
    ...(chain.explorerUrl
      ? {
          blockExplorers: {
            default: { name: chain.explorerName ?? "Explorer", url: chain.explorerUrl },
          },
        }
      : {}),
    testnet: chain.testnet,
  };
}
