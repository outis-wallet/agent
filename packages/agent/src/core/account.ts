// A copy of what the agent needs from Outis's wallet core (its `@outis/core`, not published): the same
// declarations word for word, so that what is hashed and sent reads one way in the wallet and in the
// agent. Change it only as the wallet's changes.

import { hash } from "starknet";

export type Call = {
  to: bigint;
  selector: bigint;
  calldata: bigint[];
};

export function selector(name: string): bigint {
  return BigInt(hash.getSelectorFromName(name));
}

/** Calldata of `__execute__(calls: Array<Call>)`. */
export function executeCalldata(calls: Call[]): bigint[] {
  return [BigInt(calls.length), ...calls.flatMap((call) => [call.to, call.selector, BigInt(call.calldata.length), ...call.calldata])];
}
