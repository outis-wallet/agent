import { serializeSigner, type Signer } from "./core/index.ts";
import { hash, shortString } from "starknet";

/**
 * The agent account class: OutisAccount 0.6.0 (outis-wallet/contracts at dbafcfe, `main` with its gas
 * pass), the class meant for users' own accounts too, run first by agents as its testbed (user,
 * 2026-11-10: "reset and use 0.6.0"). An agent's account has an owner and no guardian. Unaudited: an
 * agent account only ever holds a small balance. Declared on Sepolia 2026-11-10 (transaction
 * 0x042fa280…7f940a, block 17928725); the artifact is in `artifacts/outis-account-0.6.0-<hash>/`.
 *
 * Every agent account address contains this hash, so it is permanent for the accounts created with it.
 */
export const AGENT_ACCOUNT_CLASS_HASH = 0x072cbe983c9c56c99c8753faf70557fef9c6b23f677ed18642aa8902b43daf42n;

/**
 * The salt every agent account is deployed with: its own, where a user's main account takes 0, so that
 * an agent's account and a main account on the same class never share an address, and an address can be
 * told an agent's by computing it again (user, 2026-11-10: agents' deployment data "specific").
 */
export const AGENT_ACCOUNT_SALT = BigInt(shortString.encodeShortString("outis/agent"));

/** `constructor(owner: Signer, guardian: Option<Signer>)`: an agent has no guardian (`Option::None`, serialized as 1). */
export function agentConstructorCalldata(owner: Signer): bigint[] {
  return [...serializeSigner(owner), 1n];
}

/**
 * Address of the agent account owned by `owner`. The same whether it is deployed by a deploy-account
 * transaction or through the UDC with `unique` false: both deploy from address zero.
 */
export function agentAccountAddress(owner: Signer, salt: bigint = AGENT_ACCOUNT_SALT): bigint {
  const DEPLOYER = 0n;
  return BigInt(hash.calculateContractAddressFromHash(salt, AGENT_ACCOUNT_CLASS_HASH, agentConstructorCalldata(owner), DEPLOYER));
}
