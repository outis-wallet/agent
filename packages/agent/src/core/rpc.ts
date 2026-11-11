// A copy of what the agent needs from Outis's wallet core (its `@outis/core`, not published): the same
// declarations word for word, so that what is hashed and sent reads one way in the wallet and in the
// agent. Change it only as the wallet's changes.

import { toHex } from "./bytes.ts";

// A minimal Starknet JSON-RPC client (spec 0.9+). The wallet builds, estimates and submits its own
// transactions so that it controls exactly what is estimated and what the passkey signs.

/** What a node answered as an error. `method`: what it was asked, to tell which request it was in a log. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
    readonly method?: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

const CONTRACT_NOT_FOUND = 20;

/** Whether the node refused a request because there is no contract at the address (an account not deployed yet, say). */
export function contractNotFound(error: unknown): boolean {
  return error instanceof RpcError && error.code === CONTRACT_NOT_FOUND;
}
const ENTRYPOINT_NOT_FOUND = 21;
const CONTRACT_ERROR = 40;

/**
 * Whether the node answered that `contract` has no function `selector`: ENTRYPOINT_NOT_FOUND before
 * spec 0.8, and since, a CONTRACT_ERROR whose revert says so of that contract and that function
 * themselves (the call's own frame failing with 'ENTRYPOINT_NOT_FOUND', or "Entry point … not found
 * in contract" naming that function). Not any revert: a function that is there and fails is another
 * answer, and so is one failing because a function it calls in turn isn't there.
 */
export function noSuchFunction(error: unknown, contract: bigint, selector: bigint): boolean {
  if (!(error instanceof RpcError)) return false;
  if (error.code === ENTRYPOINT_NOT_FOUND) return true;
  if (error.code !== CONTRACT_ERROR) return false;
  const named = (text: string) => {
    const said = /Entry point EntryPointSelector\((0x[0-9a-fA-F]{1,64})\) not found in contract/.exec(text);
    return said !== null && BigInt(said[1]!) === selector;
  };
  const reverted = typeof error.data === "object" && error.data !== null ? (error.data as { revert_error?: unknown }).revert_error : error.data;
  if (typeof reverted === "string") return named(reverted);
  if (typeof reverted !== "object" || reverted === null) return false;
  // The call's own frame: the contract and function asked, failing itself, with no call under it (whose failure 'ENTRYPOINT_FAILED' would follow).
  const frame = reverted as { contract_address?: unknown; selector?: unknown; error?: unknown };
  const is = (written: unknown, value: bigint) => typeof written === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(written) && BigInt(written) === value;
  if (!is(frame.contract_address, contract) || !is(frame.selector, selector) || typeof frame.error !== "string") return false;
  return named(frame.error) || (/'ENTRYPOINT_NOT_FOUND'/.test(frame.error) && !/ENTRYPOINT_FAILED/.test(frame.error));
}
const TXN_HASH_NOT_FOUND = 29;
/** Requests sent in one HTTP request at most (see Rpc.batch). */
const BATCH_SIZE = 50;

/** Reads see transactions that are accepted but not yet in a closed block. */
const BLOCK = "pre_confirmed";

export type RawFeeEstimate = {
  l1_gas_consumed: string;
  l1_gas_price: string;
  l2_gas_consumed: string;
  l2_gas_price: string;
  l1_data_gas_consumed: string;
  l1_data_gas_price: string;
  overall_fee: string;
  unit: string;
};

export type Receipt = {
  transaction_hash: string;
  execution_status: "SUCCEEDED" | "REVERTED";
  finality_status: string;
  /** The block the transaction is in. That block may still be open. */
  block_number?: number;
  revert_reason?: string;
  actual_fee?: { amount: string; unit: string };
};

export type TxStatus = { finality_status: string; execution_status?: string; failure_reason?: string };

export class TransactionRevertedError extends Error {
  constructor(readonly receipt: Receipt) {
    super(`Transaction reverted: ${receipt.revert_reason ?? "no reason given"}`);
    this.name = "TransactionRevertedError";
  }
}

export class Rpc {
  private nextId = 1;

  constructor(readonly url: string) {}

  async request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const response = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
      signal,
    });
    // Some endpoints answer a JSON-RPC error with an HTTP error status; the error is still in the body.
    const text = await response.text();
    let body: { result?: T; error?: { code: number; message: string; data?: unknown } } | undefined;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (body?.error) throw new RpcError(body.error.code, body.error.message, body.error.data, method);
    if (!response.ok || !body) throw new RpcError(response.status, `RPC endpoint answered HTTP ${response.status}`, text.slice(0, 500), method);
    // Neither is no answer, as in a batch: not a result of nothing, nor "the node doesn't know the transaction".
    if (typeof body !== "object" || !("result" in body)) throw new RpcError(-1, "The RPC endpoint answered with neither a result nor an error", text.slice(0, 500), method);
    return body.result as T;
  }

  /**
   * Requests sent BATCH_SIZE to an HTTP request, the batches side by side, answered in the order
   * asked: matched by id, never by the server's order. An endpoint that doesn't take batches (one
   * the user chose, say) is asked one request at a time instead. A request that fails throws.
   */
  async batch<T>(requests: { method: string; params: unknown }[]): Promise<T[]> {
    return (await this.batchSettled<T>(requests)).map((answer) => {
      if (answer.status === "rejected") throw answer.reason;
      return answer.value;
    });
  }

  /**
   * As `batch`, with each request's answer, or why it failed, on its own: one that fails doesn't
   * fail the others. Throws only where the endpoint can't be reached.
   */
  async batchSettled<T>(requests: { method: string; params: unknown }[], signal?: AbortSignal): Promise<PromiseSettledResult<T>[]> {
    const batches: (typeof requests)[] = [];
    for (let at = 0; at < requests.length; at += BATCH_SIZE) batches.push(requests.slice(at, at + BATCH_SIZE));
    return (await Promise.all(batches.map((each) => this.oneBatch<T>(each, signal)))).flat();
  }

  private async oneBatch<T>(requests: { method: string; params: unknown }[], signal?: AbortSignal): Promise<PromiseSettledResult<T>[]> {
    signal?.throwIfAborted();
    const one = async () => {
      signal?.throwIfAborted();
      const answers = await Promise.allSettled(requests.map(({ method, params }) => this.request<T>(method, params, signal)));
      // Unreachable, as no answer at all says: thrown, as one request would throw it.
      if (answers.length > 0 && answers.every((answer) => answer.status === "rejected" && !(answer.reason instanceof RpcError))) throw (answers[0] as PromiseRejectedResult).reason;
      return answers;
    };
    if (requests.length < 2) return one();
    const sent = requests.map(({ method, params }) => ({ jsonrpc: "2.0", id: this.nextId++, method, params }));
    const response = await fetch(this.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sent), signal });
    const body: unknown = response.ok ? await response.json().catch(() => undefined) : undefined;
    signal?.throwIfAborted();
    if (!Array.isArray(body) || body.length !== sent.length) return one();
    const byId = new Map(body.map((item: { id?: unknown }) => [item?.id, item as { result?: T; error?: { code: number; message: string; data?: unknown } }]));
    return sent.map(({ id, method }): PromiseSettledResult<T> => {
      const item = byId.get(id);
      if (item?.error) return { status: "rejected", reason: new RpcError(item.error.code, item.error.message, item.error.data, method) };
      if (!item || !("result" in item)) return { status: "rejected", reason: new RpcError(-1, "The RPC endpoint left a request of the batch unanswered", undefined, method) };
      return { status: "fulfilled", value: item.result as T };
    });
  }

  async chainId(): Promise<bigint> {
    return BigInt(await this.request<string>("starknet_chainId", []));
  }

  /** Read-only calls in one HTTP request. Responses are matched by id, never by server order. */
  async batchCalls(calls: { to: bigint; selector: bigint; calldata: bigint[] }[], signal?: AbortSignal): Promise<bigint[][]> {
    if (calls.length === 0) return [];
    if (calls.length > 50) throw new Error("Too many batched calls");
    const requests = calls.map((call) => ({ jsonrpc: "2.0", id: this.nextId++, method: "starknet_call", params: {
      request: { contract_address: toHex(call.to), entry_point_selector: toHex(call.selector), calldata: call.calldata.map(toHex) }, block_id: "latest",
    } }));
    const response = await fetch(this.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(requests), signal });
    if (!response.ok) throw new Error(`Staking RPC returned HTTP ${response.status}`);
    const body = await response.json();
    if (!Array.isArray(body) || body.length !== requests.length) throw new Error("Incomplete batched RPC response");
    const byId = new Map(body.map((item) => [item?.id, item]));
    if (byId.size !== requests.length) throw new Error("Duplicate batched RPC response");
    return requests.map(({ id }) => {
      const item = byId.get(id);
      if (item?.error) throw new RpcError(item.error.code, item.error.message, item.error.data);
      if (!Array.isArray(item?.result) || !item.result.every((value: unknown) => typeof value === "string" && /^0x[0-9a-f]+$/i.test(value)))
        throw new Error("Invalid batched RPC result");
      return item.result.map((value: string) => BigInt(value));
    });
  }

  /** The version of the JSON-RPC spec the endpoint serves: "0.10.1". */
  async specVersion(): Promise<string> {
    return this.request<string>("starknet_specVersion", []);
  }

  /** The number of the latest closed block. */
  async blockNumber(): Promise<number> {
    return this.request<number>("starknet_blockNumber", []);
  }

  /** What a unit of L2 gas costs, in fri, as of the latest closed block. */
  async l2GasPrice(): Promise<bigint> {
    const block = await this.request<{ l2_gas_price: { price_in_fri: string } }>("starknet_getBlockWithTxHashes", { block_id: "latest" });
    return BigInt(block.l2_gas_price.price_in_fri);
  }

  /** Class hash of the contract at `address`, or undefined if nothing is deployed there. */
  async classHashAt(address: bigint, block: "pre_confirmed" | "latest" = BLOCK, signal?: AbortSignal): Promise<bigint | undefined> {
    try {
      return BigInt(await this.request<string>("starknet_getClassHashAt", { block_id: block, contract_address: toHex(address) }, signal));
    } catch (error) {
      if (contractNotFound(error)) return undefined;
      throw error;
    }
  }

  async nonce(address: bigint): Promise<bigint> {
    return BigInt(await this.request<string>("starknet_getNonce", { block_id: BLOCK, contract_address: toHex(address) }));
  }

  /** `block` "latest" reads closed blocks only, which is what the network checks a new transaction against. */
  async call(to: bigint, selector: bigint, calldata: bigint[] = [], block: "pre_confirmed" | "latest" = BLOCK): Promise<bigint[]> {
    const result = await this.request<string[]>("starknet_call", {
      request: { contract_address: toHex(to), entry_point_selector: toHex(selector), calldata: calldata.map(toHex) },
      block_id: block,
    });
    const felts = result.map(BigInt);
    // A felt is never below 0: a node answering one isn't answering the call.
    if (felts.some((felt) => felt < 0n)) throw new RpcError(-1, "The RPC endpoint answered with a number that isn't a felt", result, "starknet_call");
    return felts;
  }

  /**
   * Estimates with account validation included. Skipping validation would leave out the passkey
   * signature check, which is most of the cost of a passkey-signed transaction.
   */
  async estimateFee(transaction: Record<string, unknown>): Promise<RawFeeEstimate> {
    const [estimate] = await this.estimateFees([transaction]);
    if (!estimate) throw new RpcError(-1, "RPC endpoint returned no fee estimate");
    return estimate;
  }

  /** As estimateFee, for transactions run one after another: each is estimated on what those before it did. */
  async estimateFees(transactions: Record<string, unknown>[]): Promise<RawFeeEstimate[]> {
    const estimates = await this.request<RawFeeEstimate[]>("starknet_estimateFee", {
      request: transactions,
      simulation_flags: [],
      block_id: BLOCK,
    });
    if (estimates.length !== transactions.length) throw new RpcError(-1, "RPC endpoint returned no fee estimate");
    return estimates;
  }

  async addInvokeTransaction(transaction: Record<string, unknown>): Promise<bigint> {
    const result = await this.request<{ transaction_hash: string }>("starknet_addInvokeTransaction", { invoke_transaction: transaction });
    return BigInt(result.transaction_hash);
  }

  async addDeployAccountTransaction(transaction: Record<string, unknown>): Promise<bigint> {
    const result = await this.request<{ transaction_hash: string }>("starknet_addDeployAccountTransaction", {
      deploy_account_transaction: transaction,
    });
    return BigInt(result.transaction_hash);
  }

  /** The receipt, or undefined while the node doesn't know the transaction yet. */
  async receipt(transactionHash: bigint): Promise<Receipt | undefined> {
    try {
      return await this.request<Receipt>("starknet_getTransactionReceipt", { transaction_hash: toHex(transactionHash) });
    } catch (error) {
      if (error instanceof RpcError && error.code === TXN_HASH_NOT_FOUND) return undefined;
      throw error;
    }
  }

  /**
   * Where the transaction is, or undefined while the node doesn't know it: still waiting to go into a
   * block (RECEIVED, CANDIDATE), in one, or turned away (REJECTED, with why).
   */
  async transactionStatus(transactionHash: bigint): Promise<TxStatus | undefined> {
    try {
      return await this.request<TxStatus>("starknet_getTransactionStatus", { transaction_hash: toHex(transactionHash) });
    } catch (error) {
      if (error instanceof RpcError && error.code === TXN_HASH_NOT_FOUND) return undefined;
      throw error;
    }
  }

  /** Resolves once the transaction is included and succeeded; throws if it reverted or timed out. */
  async waitForTransaction(transactionHash: bigint, options: { timeoutMs?: number; intervalMs?: number } = {}): Promise<Receipt> {
    const { timeoutMs = 120_000, intervalMs = 1_000 } = options;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const receipt = await this.receipt(transactionHash);
      if (receipt) {
        if (receipt.execution_status === "REVERTED") throw new TransactionRevertedError(receipt);
        return receipt;
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for transaction ${toHex(transactionHash)}`);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}
