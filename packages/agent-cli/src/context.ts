import { Rpc } from "@outis-wallet/agent/core";
import { network, type Network } from "./config.ts";
import { CliError } from "./output.ts";
import { currentSession, loadSessions, type StoredSession } from "./store.ts";

export type Context = {
  network: Network;
  rpc: Rpc;
  chainId(): Promise<bigint>;
  /** The latest block's timestamp, in seconds: what expiry is measured against. */
  now(): Promise<bigint>;
};

export function context(networkName?: string): Context {
  const net = network(networkName);
  const rpc = new Rpc(net.rpcUrl);
  let chainId: Promise<bigint> | undefined;
  return {
    network: net,
    rpc,
    chainId: () => (chainId ??= rpc.chainId()),
    async now() {
      const block = await rpc.request<{ timestamp: number }>("starknet_getBlockWithTxHashes", { block_id: "latest" });
      return BigInt(block.timestamp);
    },
  };
}

/** The session to act in: the newest registered one that hasn't expired. */
export async function requireSession(ctx: Context): Promise<StoredSession> {
  const sessions = await loadSessions(ctx.network.name);
  if (sessions.length === 0) {
    throw new CliError("no_session", "No session yet", "Run `outis connect` and have the user approve it");
  }
  const current = currentSession(sessions, await ctx.now());
  if (!current) {
    throw new CliError("session_expired", "Every session has expired", "Run `outis connect` for a new one");
  }
  return current;
}
