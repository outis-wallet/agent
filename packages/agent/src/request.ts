import { base64UrlDecode, base64UrlEncode, selector, signerGuid, toHex, utf8 } from "./core/index.ts";
import { structHash, typeHash } from "@outis-wallet/typed-data";
import type { TypedData } from "starknet";

// What an agent asks the keychain for, carried by a link: `<keychain>/#agent=<base64url JSON>`. The
// CLI writes it; the keychain reads it, checks it, and shows the user what the session would allow
// (this repository's README, "How an agent gets a session"). Nothing in it is trusted: the keychain recomputes
// what it can, and the user decides.

export const AGENT_REQUEST_FRAGMENT = "#agent=";

export type RequestedMethod = { contract: string; entrypoint: string; selector: string; why?: string };

export type RequestedMessage = {
  domain: TypedData["domain"];
  primaryType: string;
  /** The message's types, without StarknetDomain: what the keychain shows the user. */
  types: Record<string, { name: string; type: string; contains?: string }[]>;
  domainHash: string;
  typeHash: string;
  why?: string;
};

export type AgentRequest = {
  v: 1;
  chainId: string;
  /** The session key's public key and GUID. */
  pubkey: string;
  guid: string;
  /** The session's metadata, which must be registered unchanged: the CLI checks the hash. */
  metadata: string;
  /** The agent's name, as it introduces itself. */
  name: string;
  /** Actions the keychain knows: `send`, `swap`, `sign`. */
  asks: string[];
  /** Contracts and methods asked for by name. */
  methods: RequestedMethod[];
  /** Kinds of SNIP-12 revision 1 message to sign, by domain and primary type. */
  messages: RequestedMessage[];
};

/**
 * A short code for the session key, shown by both the CLI and the keychain, so the user can tell the
 * request they approve is their agent's: the last sixteen hex digits of the key's GUID, as
 * XXXX-XXXX-XXXX-XXXX. Sixteen, not eight: the bot sends the code beside the link, so whoever sees it
 * may grind a key of their own to the same code, and 2^32 tries is hours on rented hardware.
 */
export function fingerprint(guid: bigint): string {
  const hex = guid.toString(16).padStart(16, "0").slice(-16).toUpperCase();
  return hex.match(/.{4}/g)!.join("-");
}

export function agentRequestLink(keychainUrl: string, request: AgentRequest): string {
  // The page as given (https://outis.xyz/agent), or an origin's root (https://key.outis.test/), without a fragment of its own.
  const page = new URL(keychainUrl);
  page.hash = "";
  return `${page.href}${AGENT_REQUEST_FRAGMENT}${base64UrlEncode(utf8(JSON.stringify(request)))}`;
}

export class InvalidAgentRequestError extends Error {
  constructor(reason: string) {
    super(`This agent request isn't valid: ${reason}`);
    this.name = "InvalidAgentRequestError";
  }
}

const isHex = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(value);
const ENTRYPOINT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_TEXT = 200;

/**
 * Reads a request from a location's fragment, or undefined if the fragment isn't one. Checks what can
 * be checked: the shape, that the GUID is the public key's, that each selector is its entry point's,
 * and that each kind of message hashes to what it claims. It doesn't check the chain: the caller
 * compares it with its network.
 */
export function readAgentRequest(fragment: string): AgentRequest | undefined {
  if (!fragment.startsWith(AGENT_REQUEST_FRAGMENT)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(base64UrlDecode(fragment.slice(AGENT_REQUEST_FRAGMENT.length))));
  } catch {
    throw new InvalidAgentRequestError("it can't be read");
  }
  const r = raw as Partial<AgentRequest>;
  if (r.v !== 1) throw new InvalidAgentRequestError("unknown version");
  if (!isHex(r.chainId) || !isHex(r.pubkey) || !isHex(r.guid)) throw new InvalidAgentRequestError("missing key or chain");
  if (signerGuid({ pubkey: BigInt(r.pubkey) }) !== BigInt(r.guid)) throw new InvalidAgentRequestError("the key's GUID doesn't match the key");
  if (typeof r.metadata !== "string" || r.metadata.length > 1000) throw new InvalidAgentRequestError("bad metadata");
  if (typeof r.name !== "string" || r.name.length === 0 || r.name.length > MAX_TEXT) throw new InvalidAgentRequestError("bad name");
  if (!Array.isArray(r.asks) || !r.asks.every((a) => typeof a === "string")) throw new InvalidAgentRequestError("bad actions");
  if (!Array.isArray(r.methods) || !Array.isArray(r.messages)) throw new InvalidAgentRequestError("missing methods or messages");
  for (const m of r.methods) {
    if (!isHex(m.contract) || typeof m.entrypoint !== "string" || !ENTRYPOINT.test(m.entrypoint)) throw new InvalidAgentRequestError("bad method");
    if (m.why !== undefined && (typeof m.why !== "string" || m.why.length > MAX_TEXT)) throw new InvalidAgentRequestError("bad reason");
    if (!isHex(m.selector) || BigInt(m.selector) !== selector(m.entrypoint)) throw new InvalidAgentRequestError(`${m.entrypoint}'s selector doesn't match it`);
  }
  for (const m of r.messages) {
    if (String(m.domain?.revision) !== "1" || typeof m.primaryType !== "string" || typeof m.types !== "object") throw new InvalidAgentRequestError("bad message kind");
    const types = { StarknetDomain: DOMAIN_TYPE, ...m.types };
    // Hashed by the outis-typed-data crate, as the keychain hashes a message of this kind to sign it: a kind
    // the crate refuses (a type or field named with a separator, which reads as another layout of the
    // same type hash, Bramble's finding) is no kind, though starknet.js would hash it.
    let domainHash: bigint;
    let kindHash: bigint;
    try {
      domainHash = structHash(types, "StarknetDomain", m.domain as Record<string, unknown>, "1");
      kindHash = typeHash(types, m.primaryType, "1");
    } catch {
      throw new InvalidAgentRequestError(`${m.primaryType} is a kind of message the wallet can't hash`);
    }
    if (domainHash !== BigInt(m.domainHash)) throw new InvalidAgentRequestError(`${m.primaryType}'s domain doesn't hash to what it claims`);
    if (kindHash !== BigInt(m.typeHash)) throw new InvalidAgentRequestError(`${m.primaryType}'s type doesn't hash to what it claims`);
  }
  return {
    v: 1,
    chainId: r.chainId,
    pubkey: r.pubkey,
    guid: toHex(BigInt(r.guid)),
    metadata: r.metadata,
    name: r.name,
    asks: r.asks,
    methods: r.methods,
    messages: r.messages,
  };
}

const DOMAIN_TYPE = [
  { name: "name", type: "shortstring" },
  { name: "version", type: "shortstring" },
  { name: "chainId", type: "shortstring" },
  { name: "revision", type: "shortstring" },
];
