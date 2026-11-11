import {
  bytesToBigInt,
  selector,
  signerGuid,
  toHex,
  u256ToFelts,
  type Call,
  type Signer,
  type SignerSignature,
} from "./core/index.ts";
import { encodeValue, structHash, structValues, typedDataHash } from "@outis-wallet/typed-data";
import { ec, hash, merkle, shortString, type TypedData } from "starknet";

// A session of an agent account, as the contract defines it (agent-account/src/session/). The owner
// registers the session; the session key then signs the account's transactions and messages. Both
// sides build the same SNIP-12 typed data: agent-account/scripts/session-fixture.mjs and the Cairo
// test `session_hash_matches_starknet_js` pin the encoding, and this package's tests check it again.
// Every SNIP-12 hash here is the outis-typed-data crate's (crates/typed-data, which the keychain
// hashes with too), so that what an agent signs and what the keychain reviews can't be hashed two ways.

/** First felt of a session's transaction signature. */
export const SESSION_MAGIC = BigInt(shortString.encodeShortString("session-token"));
/** First felt of a session's message signature. */
export const SESSION_MESSAGE_MAGIC = BigInt(shortString.encodeShortString("session-message"));

const MAX_U64 = (1n << 64n) - 1n;
const MAX_U128 = (1n << 128n) - 1n;

const DOMAIN_TYPE = [
  { name: "name", type: "shortstring" },
  { name: "version", type: "shortstring" },
  { name: "chainId", type: "shortstring" },
  { name: "revision", type: "shortstring" },
];

/**
 * The session's types. The allowed methods and messages are Merkle roots typed as felts, not SNIP-12
 * merkletrees: a session may allow none of either, and starknet.js can't hash an empty merkletree.
 */
export const SESSION_TYPES = {
  StarknetDomain: DOMAIN_TYPE,
  "Spending Limit": [
    { name: "Token", type: "ContractAddress" },
    { name: "Amount", type: "u256" },
    { name: "Period", type: "u128" },
  ],
  "Fee Limit": [
    { name: "Amount", type: "u128" },
    { name: "Period", type: "u128" },
  ],
  Session: [
    { name: "Expires At", type: "timestamp" },
    { name: "Allowed Methods", type: "felt" },
    { name: "Allowed Messages", type: "felt" },
    { name: "Spending Limits", type: "Spending Limit*" },
    { name: "Fee Limit", type: "Fee Limit" },
    { name: "Metadata", type: "string" },
    { name: "Session Key", type: "felt" },
  ],
};

/** The structs the Merkle leaves of the allowed methods and messages are hashed as. */
const LEAF_TYPES = {
  StarknetDomain: DOMAIN_TYPE,
  "Allowed Method": [
    { name: "Contract Address", type: "ContractAddress" },
    { name: "selector", type: "selector" },
  ],
  "Allowed Message": [
    { name: "Domain Hash", type: "felt" },
    { name: "Type Hash", type: "felt" },
  ],
};

/** A method a session may call: one entry point of one contract. */
export type AllowedMethod = { contract: bigint; selector: bigint };

/** A kind of SNIP-12 revision 1 message a session may sign: its domain hash and its primary type's hash. */
export type AllowedMessage = { domainHash: bigint; typeHash: bigint };

/** How much of `token` a session may spend in each `period` seconds (0: for the life of the session). */
export type SpendingLimit = { token: bigint; amount: bigint; period: bigint };

/**
 * How much the session's transactions may pay in fees, in fri, each `period` seconds. Each is charged
 * the most it can cost. An amount of 0: the session sends no transactions of its own.
 */
export type FeeLimit = { amount: bigint; period: bigint };

export type Session = {
  /** Unix seconds; the session works up to and including this time, its transactions until an hour before. */
  expiresAt: bigint;
  allowedMethods: AllowedMethod[];
  allowedMessages: AllowedMessage[];
  spendingLimits: SpendingLimit[];
  feeLimit: FeeLimit;
  /**
   * Free text the owner signs with the session. Revocation and spending are kept per session hash,
   * so a new session needs something unique here to get a fresh budget.
   */
  metadata: string;
  /** GUID of the session key's signer. */
  sessionKey: bigint;
};

function assertFits(value: bigint, max: bigint, what: string): void {
  if (value < 0n || value > max) throw new RangeError(`${what} is out of range`);
}

function assertValid(session: Session): void {
  assertFits(session.expiresAt, MAX_U64, "The expiry");
  const methods = new Set(session.allowedMethods.map(methodLeaf));
  if (methods.size !== session.allowedMethods.length) throw new Error("A session lists a method twice");
  const messages = new Set(session.allowedMessages.map(messageLeaf));
  if (messages.size !== session.allowedMessages.length) throw new Error("A session lists a kind of message twice");
  const tokens = new Set(session.spendingLimits.map((limit) => limit.token));
  if (tokens.size !== session.spendingLimits.length) throw new Error("A session limits a token twice");
  for (const limit of session.spendingLimits) {
    assertFits(limit.period, MAX_U64, "A spending period");
    u256ToFelts(limit.amount);
  }
  assertFits(session.feeLimit.amount, MAX_U128, "The fee budget");
  assertFits(session.feeLimit.period, MAX_U64, "The fee period");
}

/**
 * The typed data that defines the session's identity. The domain's version is the short string '1'
 * (0x31), which is what the contract uses: starknet.js reads a bare "1" as the number 1, so it is passed encoded.
 */
export function sessionTypedData(session: Session, chainId: bigint): TypedData {
  assertValid(session);
  return {
    types: SESSION_TYPES,
    primaryType: "Session",
    domain: { name: "OutisAccount.session", version: shortString.encodeShortString("1"), chainId: toHex(chainId), revision: "1" },
    message: {
      "Expires At": session.expiresAt.toString(),
      "Allowed Methods": toHex(allowedMethodsRoot(session.allowedMethods)),
      "Allowed Messages": toHex(allowedMessagesRoot(session.allowedMessages)),
      "Spending Limits": session.spendingLimits.map((limit) => {
        const [low, high] = u256ToFelts(limit.amount);
        return { Token: toHex(limit.token), Amount: { low: toHex(low), high: toHex(high) }, Period: limit.period.toString() };
      }),
      "Fee Limit": { Amount: session.feeLimit.amount.toString(), Period: session.feeLimit.period.toString() },
      Metadata: session.metadata,
      "Session Key": toHex(session.sessionKey),
    },
  };
}

/** The session's hash on `account`: the session's identity on-chain. */
export function sessionHash(session: Session, chainId: bigint, account: bigint): bigint {
  return typedDataHash(account, sessionTypedData(session, chainId));
}

function allowedMethodMessage(method: AllowedMethod) {
  return { "Contract Address": toHex(method.contract), selector: toHex(method.selector) };
}

export function methodLeaf(method: AllowedMethod): bigint {
  return structHash(LEAF_TYPES, "Allowed Method", allowedMethodMessage(method), "1");
}

export function messageLeaf(message: AllowedMessage): bigint {
  const value = { "Domain Hash": toHex(message.domainHash), "Type Hash": toHex(message.typeHash) };
  return structHash(LEAF_TYPES, "Allowed Message", value, "1");
}

/** A tree of the leaves, or undefined for none: starknet.js can't build an empty tree. */
function tree(leaves: bigint[]): merkle.MerkleTree | undefined {
  return leaves.length ? new merkle.MerkleTree(leaves.map(toHex), hash.computePoseidonHash) : undefined;
}

/** The root over the leaves; 0 for none, which no proof reaches. */
function root(leaves: bigint[]): bigint {
  return BigInt(tree(leaves)?.root ?? 0n);
}

/** The proof of `leaf` in the tree of `leaves`, or undefined if it isn't one of them. */
function proof(leaves: bigint[], leaf: bigint): bigint[] | undefined {
  const built = tree(leaves);
  if (!built || !leaves.includes(leaf)) return undefined;
  return built.getProof(toHex(leaf)).map(BigInt);
}

export function allowedMethodsRoot(methods: AllowedMethod[]): bigint {
  return root(methods.map(methodLeaf));
}

export function allowedMessagesRoot(messages: AllowedMessage[]): bigint {
  return root(messages.map(messageLeaf));
}

export class MethodNotAllowedError extends Error {
  constructor(readonly call: Call) {
    super(`The session doesn't allow selector ${toHex(call.selector)} on ${toHex(call.to)}`);
    this.name = "MethodNotAllowedError";
  }
}

/** A Merkle proof for each call's method. Throws for a call the session doesn't allow. */
export function sessionProofs(session: Session, calls: Call[]): bigint[][] {
  const leaves = session.allowedMethods.map(methodLeaf);
  return calls.map((call) => {
    const found = proof(leaves, methodLeaf({ contract: call.to, selector: call.selector }));
    if (!found) throw new MethodNotAllowedError(call);
    return found;
  });
}

export class MessageNotAllowedError extends Error {
  constructor(readonly message_: AllowedMessage) {
    super(`The session doesn't allow messages of type ${toHex(message_.typeHash)} in domain ${toHex(message_.domainHash)}`);
    this.name = "MessageNotAllowedError";
  }
}

/** The Merkle proof that the session allows messages of this kind. Throws if it doesn't. */
export function messageProof(session: Session, message: AllowedMessage): bigint[] {
  const found = proof(session.allowedMessages.map(messageLeaf), messageLeaf(message));
  if (!found) throw new MessageNotAllowedError(message);
  return found;
}

/** SNIP-12 `string` value of the metadata, as the contract stores it in the session. */
export function metadataHash(metadata: string): bigint {
  return encodeValue(SESSION_TYPES, "string", metadata, "1");
}

/** Cairo `Serde` encoding of `Session`. */
export function serializeSession(session: Session): bigint[] {
  assertValid(session);
  return [
    session.expiresAt,
    allowedMethodsRoot(session.allowedMethods),
    allowedMessagesRoot(session.allowedMessages),
    BigInt(session.spendingLimits.length),
    ...session.spendingLimits.flatMap((limit) => [limit.token, ...u256ToFelts(limit.amount), limit.period]),
    session.feeLimit.amount,
    session.feeLimit.period,
    metadataHash(session.metadata),
    session.sessionKey,
  ];
}

/** The call the owner makes on the agent account to register a session and publish its allowlists. */
export function registerSessionCall(account: bigint, session: Session): Call {
  return {
    to: account,
    selector: selector("register_session"),
    calldata: [
      ...serializeSession(session),
      BigInt(session.allowedMethods.length),
      ...session.allowedMethods.flatMap((method) => [method.contract, method.selector]),
      BigInt(session.allowedMessages.length),
      ...session.allowedMessages.flatMap((message) => [message.domainHash, message.typeHash]),
    ],
  };
}

/** The call the owner makes on the agent account to revoke a session: from then on it works for nothing. */
export function revokeSessionCall(account: bigint, sessionHash: bigint): Call {
  return { to: account, selector: selector("revoke_session"), calldata: [sessionHash] };
}

/** A registered session's signature over SNIP-12 revision 1 typed data, for `is_valid_signature`. */
export function sessionMessageSignature(args: {
  session: Session;
  chainId: bigint;
  account: bigint;
  message: TypedData;
  key: SessionKey;
}): bigint[] {
  const { session, chainId, account, message, key } = args;
  if (message.domain.revision !== "1") throw new Error("Session messages must use SNIP-12 revision 1");
  if (key.guid !== session.sessionKey) throw new Error("The session key doesn't match the session");

  const domainHash = structHash(message.types, "StarknetDomain", message.domain, "1");
  const [typeHash, ...fields] = structValues(message.types, message.primaryType, message.message, "1") as [bigint, ...bigint[]];
  const proof = messageProof(session, { domainHash, typeHash });
  const messageHash = typedDataHash(account, message);
  // Cairo uses PoseidonTrait's span hash here, including its padding, even with just two elements.
  const signed = BigInt(hash.computePoseidonHashOnElements([messageHash, sessionHash(session, chainId, account)]));
  const { signer, r, s } = key.sign(signed);
  return [
    SESSION_MESSAGE_MAGIC,
    ...serializeSession(session),
    0n,
    signer.pubkey,
    r,
    s,
    domainHash,
    typeHash,
    BigInt(fields.length),
    ...fields,
    BigInt(proof.length),
    ...proof,
  ];
}

/** What the session key signs for each execution. */
export function sessionMessageHash(executionHash: bigint, sessionHash: bigint): bigint {
  return BigInt(hash.computePoseidonHashOnElements([executionHash, sessionHash]));
}

export type SessionToken = {
  session: Session;
  /** The session key's signature over `sessionMessageHash`. */
  sessionSignature: SignerSignature;
  proofs: bigint[][];
};

/** The signature of a session invoke or outside execution: the magic value, then the `SessionToken`. */
export function sessionSignature(token: SessionToken): bigint[] {
  const { signer, r, s } = token.sessionSignature;
  return [
    SESSION_MAGIC,
    ...serializeSession(token.session),
    // SignerSignature::Starknet((signer, signature)): a single signature, without a count
    0n,
    signer.pubkey,
    r,
    s,
    BigInt(token.proofs.length),
    ...token.proofs.flatMap((proof) => [BigInt(proof.length), ...proof]),
  ];
}

/** A session key: a Stark-curve key the agent holds. Whoever holds it can do what its session allows. */
export class SessionKey {
  readonly signer: Signer;
  readonly #privateKey: string;

  private constructor(privateKey: string) {
    this.#privateKey = privateKey;
    this.signer = { pubkey: BigInt(ec.starkCurve.getStarkKey(privateKey)) };
  }

  static generate(): SessionKey {
    return new SessionKey(toHex(bytesToBigInt(ec.starkCurve.utils.randomPrivateKey())));
  }

  static fromPrivateKey(privateKey: string): SessionKey {
    return new SessionKey(privateKey);
  }

  /** What a `Session` names as its key. */
  get guid(): bigint {
    return signerGuid(this.signer);
  }

  sign(hash: bigint): SignerSignature {
    const { r, s } = ec.starkCurve.sign(hash.toString(16), this.#privateKey);
    return { signer: this.signer, r, s };
  }

  exportPrivateKey(): string {
    return this.#privateKey;
  }
}
