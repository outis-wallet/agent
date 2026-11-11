// A copy of what the agent needs from Outis's wallet core (its `@outis/core`, not published): the same
// declarations word for word, so that what is hashed and sent reads one way in the wallet and in the
// agent. Change it only as the wallet's changes.

import { hash, type constants } from "starknet";
import { executeCalldata, type Call } from "./account.ts";
import { toHex } from "./bytes.ts";

// Version 3 transactions only.

const VERSION = "0x3" as const;

export type ResourceBound = { maxAmount: bigint; maxPricePerUnit: bigint };
export type ResourceBounds = { l1Gas: ResourceBound; l2Gas: ResourceBound; l1DataGas: ResourceBound };

export type Fee = {
  /** What the node expects the transaction to cost, in fri (1e-18 STRK). */
  estimated: bigint;
  /** The most the transaction can cost with the resource bounds it is signed with. */
  max: bigint;
};

/**
 * A proof a transaction carries (SNIP-36): what a STRK20 pool checks before it applies a private
 * action. The facts are part of what the owner signs; the proof itself is not.
 */
export type TransactionProof = {
  /** The proof, base64. */
  data: string;
  facts: bigint[];
};

function hashBounds(bounds: ResourceBounds) {
  const bound = ({ maxAmount, maxPricePerUnit }: ResourceBound) => ({ max_amount: maxAmount, max_price_per_unit: maxPricePerUnit });
  return { l1_gas: bound(bounds.l1Gas), l2_gas: bound(bounds.l2Gas), l1_data_gas: bound(bounds.l1DataGas) };
}

function rpcBounds(bounds: ResourceBounds) {
  const bound = ({ maxAmount, maxPricePerUnit }: ResourceBound) => ({
    max_amount: toHex(maxAmount),
    max_price_per_unit: toHex(maxPricePerUnit),
  });
  return { l1_gas: bound(bounds.l1Gas), l2_gas: bound(bounds.l2Gas), l1_data_gas: bound(bounds.l1DataGas) };
}

const COMMON_FIELDS = {
  tip: "0x0",
  paymaster_data: [],
  nonce_data_availability_mode: "L1",
  fee_data_availability_mode: "L1",
} as const;

/** RPC payload shared by owner-signed and session-signed invokes. */
export function invokeTransaction(
  tx: { sender: bigint; calls: Call[]; nonce: bigint; bounds: ResourceBounds; proof?: TransactionProof },
  version: string,
  signature: bigint[],
): Record<string, unknown> {
  return {
    type: "INVOKE",
    version,
    sender_address: toHex(tx.sender),
    calldata: executeCalldata(tx.calls).map(toHex),
    signature: signature.map(toHex),
    nonce: toHex(tx.nonce),
    resource_bounds: rpcBounds(tx.bounds),
    account_deployment_data: [],
    ...COMMON_FIELDS,
    // Without facts there is no proof to carry, and empty proof fields make the transaction invalid.
    ...(tx.proof?.facts.length && { proof: tx.proof.data, proof_facts: tx.proof.facts.map(toHex) }),
  };
}

/** The hash of an invoke transaction: what the owner signs, and the transaction's id on the network. */
export function invokeTransactionHash(tx: {
  chainId: bigint;
  sender: bigint;
  calls: Call[];
  nonce: bigint;
  bounds: ResourceBounds;
  proof?: TransactionProof;
}): bigint {
  return BigInt(
    hash.calculateInvokeTransactionHash({
      senderAddress: tx.sender,
      version: VERSION,
      compiledCalldata: executeCalldata(tx.calls).map(toHex),
      chainId: toHex(tx.chainId) as constants.StarknetChainId,
      nonce: tx.nonce,
      accountDeploymentData: [],
      nonceDataAvailabilityMode: 0,
      feeDataAvailabilityMode: 0,
      resourceBounds: hashBounds(tx.bounds),
      tip: 0n,
      paymasterData: [],
      proofFacts: tx.proof?.facts.map(toHex),
    }),
  );
}
