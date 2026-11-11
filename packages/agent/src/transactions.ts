import {
  invokeTransaction,
  invokeTransactionHash,
  serializeAccountSignature,
  signerGuid,
  toHex,
  type Call,
  type Fee,
  type RawFeeEstimate,
  type ResourceBounds,
  type Rpc,
  type Signer,
  type SignerSignature,
} from "./core/index.ts";
import { hash, type constants } from "starknet";
import { AGENT_ACCOUNT_CLASS_HASH, AGENT_ACCOUNT_SALT, agentAccountAddress, agentConstructorCalldata } from "./account.ts";
import { sessionHash, sessionMessageHash, sessionProofs, sessionSignature, type Session, type SessionKey } from "./session.ts";

const VERSION = "0x3" as const;
const QUERY_VERSION = "0x100000000000000000000000000000003" as const;
const ZERO_BOUNDS: ResourceBounds = {
  l1Gas: { maxAmount: 0n, maxPricePerUnit: 0n },
  l2Gas: { maxAmount: 0n, maxPricePerUnit: 0n },
  l1DataGas: { maxAmount: 0n, maxPricePerUnit: 0n },
};

export type PreparedSessionInvoke = {
  kind: "session-invoke";
  chainId: bigint;
  sender: bigint;
  calls: Call[];
  nonce: bigint;
  bounds: ResourceBounds;
  session: Session;
  /** No estimate is made when the caller supplies explicit bounds. */
  fee: { estimated?: bigint; max: bigint };
  hash: bigint;
};

export type PreparedAgentDeploy = {
  kind: "agent-deploy";
  chainId: bigint;
  address: bigint;
  owner: Signer;
  bounds: ResourceBounds;
  fee: Fee;
  hash: bigint;
};

function maxFee(bounds: ResourceBounds): bigint {
  return Object.values(bounds).reduce((total, bound) => total + bound.maxAmount * bound.maxPricePerUnit, 0n);
}

function boundsFromEstimate(estimate: RawFeeEstimate, marginPercent: bigint): { bounds: ResourceBounds; fee: Fee } {
  const margin = (value: string) => (BigInt(value) * (100n + marginPercent) + 99n) / 100n;
  const bound = (amount: string, price: string) => ({ maxAmount: margin(amount), maxPricePerUnit: margin(price) });
  const bounds = {
    l1Gas: bound(estimate.l1_gas_consumed, estimate.l1_gas_price),
    l2Gas: bound(estimate.l2_gas_consumed, estimate.l2_gas_price),
    l1DataGas: bound(estimate.l1_data_gas_consumed, estimate.l1_data_gas_price),
  };
  return { bounds, fee: { estimated: BigInt(estimate.overall_fee), max: maxFee(bounds) } };
}

function assertSessionSigner(session: Session, signer: Signer): void {
  if (signerGuid(signer) !== session.sessionKey) throw new Error("The session key doesn't match the session");
}

/**
 * Prepares a registered session's invoke, estimating with its real signer and a placeholder signature.
 * Adds 15% to each resource amount and price. Explicit bounds skip estimation, including execution.
 * Owner calls on an agent account use core's prepareInvoke/submitInvoke instead.
 */
export async function prepareSessionInvoke(
  rpc: Pick<Rpc, "nonce" | "estimateFee">,
  args: { chainId: bigint; sender: bigint; session: Session; signer: Signer; calls: Call[]; bounds?: ResourceBounds },
): Promise<PreparedSessionInvoke> {
  const { chainId, sender, session, signer, calls } = args;
  assertSessionSigner(session, signer);
  const proofs = sessionProofs(session, calls);
  const placeholder = sessionSignature({
    session, sessionSignature: { signer, r: 1n, s: 1n }, proofs,
  });
  const nonce = await rpc.nonce(sender);
  let bounds: ResourceBounds;
  let fee: PreparedSessionInvoke["fee"];
  if (args.bounds) {
    bounds = args.bounds;
    fee = { max: maxFee(bounds) };
  } else {
    const estimate = (resources: ResourceBounds) => rpc.estimateFee(
      invokeTransaction({ sender, calls, nonce, bounds: resources }, QUERY_VERSION, placeholder),
    );
    const initial = boundsFromEstimate(await estimate(ZERO_BOUNDS), 15n);
    // Zero bounds charge zero to the session in validation, omitting the first nonzero fee-counter
    // storage write. Estimate again with real bounds so its data gas is included in the 15% margin.
    ({ bounds, fee } = boundsFromEstimate(await estimate(initial.bounds), 15n));
  }
  const tx = { chainId, sender, calls, nonce, bounds };
  return { kind: "session-invoke", ...tx, session, fee, hash: invokeTransactionHash(tx) };
}

/** Signs and submits a prepared invoke using the registered session key. */
export async function submitSessionInvoke(rpc: Pick<Rpc, "addInvokeTransaction">, prepared: PreparedSessionInvoke, key: SessionKey): Promise<bigint> {
  assertSessionSigner(prepared.session, key.signer);
  const identity = sessionHash(prepared.session, prepared.chainId, prepared.sender);
  const signature = sessionSignature({
    session: prepared.session,
    sessionSignature: key.sign(sessionMessageHash(prepared.hash, identity)),
    proofs: sessionProofs(prepared.session, prepared.calls),
  });
  return rpc.addInvokeTransaction(invokeTransaction(prepared, VERSION, signature));
}

function hashBounds(bounds: ResourceBounds) {
  const bound = ({ maxAmount, maxPricePerUnit }: ResourceBounds["l1Gas"]) => ({ max_amount: maxAmount, max_price_per_unit: maxPricePerUnit });
  return { l1_gas: bound(bounds.l1Gas), l2_gas: bound(bounds.l2Gas), l1_data_gas: bound(bounds.l1DataGas) };
}

function deployTransaction(owner: Signer, bounds: ResourceBounds, version: string, signature: bigint[]): Record<string, unknown> {
  const resources = hashBounds(bounds);
  return {
    type: "DEPLOY_ACCOUNT",
    version,
    signature: signature.map(toHex),
    nonce: "0x0",
    contract_address_salt: toHex(AGENT_ACCOUNT_SALT),
    constructor_calldata: agentConstructorCalldata(owner).map(toHex),
    class_hash: toHex(AGENT_ACCOUNT_CLASS_HASH),
    resource_bounds: Object.fromEntries(Object.entries(resources).map(([name, bound]) => [name, {
      max_amount: toHex(bound.max_amount), max_price_per_unit: toHex(bound.max_price_per_unit),
    }])),
    tip: "0x0",
    paymaster_data: [],
    nonce_data_availability_mode: "L1",
    fee_data_availability_mode: "L1",
  };
}

/** Estimates deployment at the agents' salt (AGENT_ACCOUNT_SALT). The counterfactual address must already hold STRK for the fee. */
export async function prepareAgentDeploy(rpc: Pick<Rpc, "estimateFee">, args: { chainId: bigint; owner: Signer }): Promise<PreparedAgentDeploy> {
  const { chainId, owner } = args;
  const address = agentAccountAddress(owner);
  const placeholder = serializeAccountSignature({ signer: owner, r: 1n, s: 1n });
  const estimate = await rpc.estimateFee(deployTransaction(owner, ZERO_BOUNDS, QUERY_VERSION, placeholder));
  // Owner-funded deployment keeps core's 50% margin; only session invokes consume a session fee budget.
  const { bounds, fee } = boundsFromEstimate(estimate, 50n);
  const transactionHash = BigInt(hash.calculateDeployAccountTransactionHash({
    contractAddress: address,
    classHash: AGENT_ACCOUNT_CLASS_HASH,
    compiledConstructorCalldata: agentConstructorCalldata(owner).map(toHex),
    salt: AGENT_ACCOUNT_SALT,
    version: VERSION,
    chainId: toHex(chainId) as constants.StarknetChainId,
    nonce: 0n,
    nonceDataAvailabilityMode: 0,
    feeDataAvailabilityMode: 0,
    resourceBounds: hashBounds(bounds),
    tip: 0n,
    paymasterData: [],
  }));
  return { kind: "agent-deploy", chainId, address, owner, bounds, fee, hash: transactionHash };
}

/** Submits the deployment with the owner's signature over prepared.hash. */
export async function submitAgentDeploy(rpc: Pick<Rpc, "addDeployAccountTransaction">, prepared: PreparedAgentDeploy, signature: SignerSignature): Promise<bigint> {
  return rpc.addDeployAccountTransaction(deployTransaction(prepared.owner, prepared.bounds, VERSION, serializeAccountSignature(signature)));
}
