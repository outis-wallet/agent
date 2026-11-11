import { homedir } from "node:os";
import { join } from "node:path";

// Where the CLI talks to and where it keeps its files. Everything can be set from the environment, so
// an agent's harness can point it elsewhere without flags.

export type Network = {
  name: string;
  /** Starknet JSON-RPC 0.10. */
  rpcUrl: string;
  /**
   * Where the link the user opens to approve a session points: the site's /agent page, which the Outis
   * extension takes it from into its own wallet, and which says how to open it without the extension
   * (the README's "How an agent gets a session"). The hosted keychain at key.outis.xyz is retired: it
   * sends links made for it to the site's home page, which the extension takes them from too.
   */
  keychainUrl: string;
};

const NETWORKS: Record<string, Network> = {
  // Outis's node answers requests that name no origin on Sepolia.
  sepolia: { name: "sepolia", rpcUrl: "https://rpc.outis.xyz/sepolia/rpc/v0_10", keychainUrl: "https://outis.xyz/agent" },
  devnet: { name: "devnet", rpcUrl: "http://127.0.0.1:5050/rpc", keychainUrl: "http://localhost:5173" },
};

export const DEFAULT_NETWORK = "sepolia";

export function network(name = process.env.OUTIS_NETWORK ?? DEFAULT_NETWORK): Network {
  const known = NETWORKS[name];
  if (!known) throw new Error(`Unknown network "${name}": use ${Object.keys(NETWORKS).join(" or ")}`);
  return {
    ...known,
    rpcUrl: process.env.OUTIS_RPC_URL ?? known.rpcUrl,
    keychainUrl: process.env.OUTIS_KEYCHAIN_URL ?? known.keychainUrl,
  };
}

/** The CLI's own directory: a session key and the sessions found for it, per network. */
export function home(): string {
  return process.env.OUTIS_AGENT_HOME ?? join(homedir(), ".config", "outis", "agent");
}
