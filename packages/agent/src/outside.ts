import { executeCalldata, selector, toHex, type Call } from "./core/index.ts";
import { typedDataHash } from "@outis-wallet/typed-data";
import { shortString, type TypedData } from "starknet";

// Outside execution (SNIP-9 v2): the session key signs the execution and a sponsor submits it by
// calling `execute_from_outside_v2`. For invokes paid by the agent account, see transactions.ts.

/** The `caller` that lets anyone submit an execution. */
export const ANY_CALLER = BigInt(shortString.encodeShortString("ANY_CALLER"));

export type OutsideExecution = {
  /** Who may submit it: one address, or `ANY_CALLER`. */
  caller: bigint;
  /** Any value not used before by this account; it can't be used again. */
  nonce: bigint;
  /** Unix seconds, exclusive at both ends. */
  executeAfter: bigint;
  executeBefore: bigint;
  calls: Call[];
};

const OUTSIDE_EXECUTION_TYPES = {
  StarknetDomain: [
    { name: "name", type: "shortstring" },
    { name: "version", type: "shortstring" },
    { name: "chainId", type: "shortstring" },
    { name: "revision", type: "shortstring" },
  ],
  OutsideExecution: [
    { name: "Caller", type: "ContractAddress" },
    { name: "Nonce", type: "felt" },
    { name: "Execute After", type: "u128" },
    { name: "Execute Before", type: "u128" },
    { name: "Calls", type: "Call*" },
  ],
  Call: [
    { name: "To", type: "ContractAddress" },
    { name: "Selector", type: "selector" },
    { name: "Calldata", type: "felt*" },
  ],
};

/**
 * The typed data an outside execution is signed as. Selectors are given as hex, which starknet.js
 * passes through (its own helper only takes entry point names). The domain's version is the number
 * 2, as the account has it.
 */
export function outsideExecutionTypedData(execution: OutsideExecution, chainId: bigint): TypedData {
  return {
    types: OUTSIDE_EXECUTION_TYPES,
    primaryType: "OutsideExecution",
    domain: { name: "Account.execute_from_outside", version: "2", chainId: toHex(chainId), revision: "1" },
    message: {
      Caller: toHex(execution.caller),
      Nonce: toHex(execution.nonce),
      "Execute After": execution.executeAfter.toString(),
      "Execute Before": execution.executeBefore.toString(),
      Calls: execution.calls.map((call) => ({ To: toHex(call.to), Selector: toHex(call.selector), Calldata: call.calldata.map(toHex) })),
    },
  };
}

/** The hash the signer signs: the account's `get_outside_execution_message_hash_rev_1`, by the outis-typed-data crate (the keychain's hash). */
export function outsideExecutionHash(execution: OutsideExecution, chainId: bigint, account: bigint): bigint {
  return typedDataHash(account, outsideExecutionTypedData(execution, chainId));
}

/** Cairo `Serde` encoding of `OutsideExecution`. */
export function serializeOutsideExecution(execution: OutsideExecution): bigint[] {
  return [execution.caller, execution.nonce, execution.executeAfter, execution.executeBefore, ...executeCalldata(execution.calls)];
}

/** The call the submitter makes: `execute_from_outside_v2(outside_execution, signature)` on the account. */
export function executeFromOutsideCall(account: bigint, execution: OutsideExecution, signature: bigint[]): Call {
  return {
    to: account,
    selector: selector("execute_from_outside_v2"),
    calldata: [...serializeOutsideExecution(execution), BigInt(signature.length), ...signature],
  };
}

/** A random nonce. Outside execution nonces aren't sequential: any unused value works. */
export function randomNonce(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(31));
  return bytes.reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
}
