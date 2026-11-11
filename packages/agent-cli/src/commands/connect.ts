import { readFile } from "node:fs/promises";
import { selector, toHex } from "@outis-wallet/agent/core";
import {
  agentRequestLink,
  findRegisteredSessions,
  fingerprint,
  type AgentRequest,
  type RequestedMessage,
  type RequestedMethod,
} from "@outis-wallet/agent";
import { structHash, typeHash } from "@outis-wallet/typed-data";
import { shortString, type TypedData } from "starknet";
import type { Context } from "../context.ts";
import { CliError, type Printer } from "../output.ts";
import { clearRequest, ensureKey, loadRequest, loadSessions, saveRequest, saveSessions, type StoredSession } from "../store.ts";

export { fingerprint, type AgentRequest };

// Pairing goes through the chain: the CLI prints a link with what it asks for, the user approves in the
// keychain, which registers the session from the agent account, and the CLI finds the registration by
// its key (the README's "How an agent gets a session").

/** Methods no session gets: an allowance or an operator would let value leave outside the limits. */
const APPROVALS = new Set(["approve", "increase_allowance", "increaseAllowance", "set_approval_for_all", "setApprovalForAll"]);

/** `<contract>:<entrypoint>[:<why>]` */
export function parseMethod(text: string): RequestedMethod {
  const [contract = "", entrypoint = "", ...why] = text.split(":");
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(contract) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entrypoint)) {
    throw new CliError("usage", `"${text}" isn't <contract>:<entrypoint>[:<why>]`);
  }
  if (APPROVALS.has(entrypoint)) {
    throw new CliError("usage", `No session can call ${entrypoint}: an allowance would let value leave outside the limits`);
  }
  return { contract: toHex(BigInt(contract)), entrypoint, selector: toHex(selector(entrypoint)), ...(why.length && { why: why.join(":") }) };
}

function chainOf(value: unknown): bigint | undefined {
  if (value === undefined) return undefined;
  const text = String(value);
  return /^0x[0-9a-fA-F]+$/.test(text) ? BigInt(text) : BigInt(shortString.encodeShortString(text));
}

/** A kind of message, from an example of it: typed data in a file, for the network's chain. */
export async function parseMessage(file: string, chainId: bigint, why?: string): Promise<RequestedMessage> {
  let example: TypedData;
  try {
    example = JSON.parse(await readFile(file, "utf8")) as TypedData;
  } catch {
    throw new CliError("usage", `${file} isn't a typed data JSON file`);
  }
  if (String(example.domain?.revision) !== "1") throw new CliError("usage", `${file}: only SNIP-12 revision 1 messages can be signed`);
  // the chain is part of the domain hash: a message for another chain would never verify here
  if (chainOf(example.domain.chainId) !== chainId) throw new CliError("usage", `${file}: its domain names another chain than this network's`);
  const { StarknetDomain: _, ...types } = example.types;
  // Hashed by the wallet's core, as the keychain checks them and hashes a message of this kind to sign it.
  let hashes: { domainHash: string; typeHash: string };
  try {
    hashes = { domainHash: toHex(structHash(example.types, "StarknetDomain", example.domain, "1")), typeHash: toHex(typeHash(example.types, example.primaryType, "1")) };
  } catch (error) {
    throw new CliError("usage", `${file}: a kind of message the wallet can't hash (${error instanceof Error ? error.message : String(error)})`);
  }
  return {
    domain: example.domain,
    primaryType: example.primaryType,
    types: types as RequestedMessage["types"],
    ...hashes,
    ...(why && { why }),
  };
}

export async function connect(
  ctx: Context,
  out: Printer,
  options: { name: string; asks: string[]; methods: string[]; messages: string[]; wait: boolean; timeoutSeconds: number },
): Promise<void> {
  const name = ctx.network.name;
  const chainId = await ctx.chainId();
  // checked before anything is saved: a refused request leaves the pending one as it was
  const methods = options.methods.map(parseMethod);
  const messages = await Promise.all(options.messages.map((file) => parseMessage(file, chainId)));
  const key = await ensureKey(name);
  // `connect` asks anew; `connect --wait` waits for the request already made, if there is one
  let pending = options.wait ? await loadRequest(name) : undefined;
  if (!pending) {
    // something unique, so that a new session gets a new hash and a fresh budget
    const metadata = JSON.stringify({ agent: options.name || "agent", key: toHex(key.guid), at: Number(await ctx.now()) });
    pending = { metadata, fromBlock: await ctx.rpc.blockNumber() };
    await saveRequest(name, pending);
  }
  const request: AgentRequest = {
    v: 1,
    chainId: toHex(chainId),
    pubkey: toHex(key.signer.pubkey),
    guid: toHex(key.guid),
    metadata: pending.metadata,
    name: options.name || "agent",
    asks: options.asks,
    methods,
    messages,
  };
  const link = agentRequestLink(ctx.network.keychainUrl, request);
  if (!options.wait) {
    out.result(
      { link, fingerprint: fingerprint(key.guid), waiting: false },
      [
        "Ask the user to open this link and approve:",
        link,
        `The keychain shows the code ${fingerprint(key.guid)}: it must match.`,
        "Then run `outis connect --wait` (or `outis sync`).",
      ],
    );
    return;
  }
  if (!out.json) {
    process.stderr.write(`Ask the user to open this link and approve:\n${link}\nThe keychain shows the code ${fingerprint(key.guid)}: it must match.\nWaiting…\n`);
  }
  const deadline = Date.now() + options.timeoutSeconds * 1000;
  for (;;) {
    const found = await sync(ctx);
    if (found.length) {
      const newest = found[found.length - 1]!;
      out.result(
        { link, fingerprint: fingerprint(key.guid), account: toHex(newest.account), session: toHex(newest.hash), expiresAt: Number(newest.session.expiresAt) },
        [`Approved: session ${toHex(newest.hash)} on ${toHex(newest.account)}`],
      );
      return;
    }
    if (Date.now() > deadline) {
      throw new CliError("no_session", "The user hasn't approved yet", "Run `outis connect --wait` again once they have", { link });
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

/**
 * Looks for registrations of the pending request's session and keeps them. Returns the ones found
 * this time. The reader checks that each comes from an agent account and hashes to what it claims.
 */
export async function sync(ctx: Context): Promise<StoredSession[]> {
  const name = ctx.network.name;
  const pending = await loadRequest(name);
  const key = await ensureKey(name);
  if (!pending) return [];
  const found = await findRegisteredSessions(ctx.rpc, {
    sessionKeyGuid: key.guid,
    metadata: pending.metadata,
    chainId: await ctx.chainId(),
    fromBlock: pending.fromBlock,
  });
  if (found.length === 0) return [];
  const known = await loadSessions(name);
  const added = found
    .filter((f) => !known.some((k) => k.hash === f.hash))
    .map((f) => ({ account: f.account, hash: f.hash, session: f.session, block: f.blockNumber ?? pending.fromBlock }));
  if (added.length) await saveSessions(name, [...known, ...added]);
  await clearRequest(name);
  return added;
}

export async function syncCommand(ctx: Context, out: Printer): Promise<void> {
  const added = await sync(ctx);
  out.result(
    { added: added.map((s) => ({ account: toHex(s.account), session: toHex(s.hash), expiresAt: Number(s.session.expiresAt) })) },
    added.length ? added.map((s) => `found session ${toHex(s.hash)} on ${toHex(s.account)}`) : ["nothing new"],
  );
}
