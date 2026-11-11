import { selector, toHex, type Rpc } from "./core/index.ts";
import { AGENT_ACCOUNT_CLASS_HASH } from "./account.ts";
import { allowedMessagesRoot, allowedMethodsRoot, serializeSession, sessionHash, type AllowedMessage, type AllowedMethod, type FeeLimit, type Session, type SpendingLimit } from "./session.ts";

const REGISTERED = selector("SessionRegistered");

type RegistrationEvent = {
  from_address: string;
  keys: string[];
  data: string[];
  transaction_hash: string;
  block_number: number;
};

export type RegisteredSession = {
  account: bigint;
  session: Session;
  hash: bigint;
  transactionHash: bigint;
  blockNumber: number;
};

/** Events carry a metadata hash; only the CLI's original metadata text can reconstruct the session. */
function decodeRegistration(event: RegistrationEvent, metadata: string, sessionKeyGuid: bigint, chainId: bigint): RegisteredSession | undefined {
  try {
    const keys = event.keys.map(BigInt);
    if (keys.length !== 2 || keys[0] !== REGISTERED || keys[1] !== sessionKeyGuid) return undefined;
    const data = event.data.map(BigInt);
    let offset = 0;
    const take = () => {
      const value = data[offset++];
      if (value === undefined || value < 0n) throw new Error("Invalid registration data");
      return value;
    };
    const list = <T>(width: number, read: () => T): T[] => {
      const count = take();
      if (count > BigInt(Math.floor((data.length - offset) / width))) throw new Error("Truncated registration list");
      return Array.from({ length: Number(count) }, read);
    };
    const uint256 = () => {
      const low = take();
      const high = take();
      if (low >= 1n << 128n || high >= 1n << 128n) throw new Error("Invalid u256 limb");
      return low + (high << 128n);
    };

    const claimedHash = take();
    const expiresAt = take();
    take(); // methods root, checked against the reconstructed session below
    take(); // messages root
    const spendingLimits = list(4, () => ({ token: take(), amount: uint256(), period: take() }));
    const feeLimit = { amount: take(), period: take() };
    take(); // metadata hash
    const sessionKey = take();
    const encodedSession = data.slice(1, offset);
    const allowedMethods = list(2, () => ({ contract: take(), selector: take() }));
    const allowedMessages = list(2, () => ({ domainHash: take(), typeHash: take() }));
    if (offset !== data.length || sessionKey !== sessionKeyGuid) return undefined;

    const session = { expiresAt, allowedMethods, allowedMessages, spendingLimits, feeLimit, metadata, sessionKey };
    const encoded = serializeSession(session);
    if (encoded.length !== encodedSession.length || encoded.some((value, i) => value !== encodedSession[i])) return undefined;
    const account = BigInt(event.from_address);
    if (sessionHash(session, chainId, account) !== claimedHash) return undefined;
    return { account, session, hash: claimedHash, transactionHash: BigInt(event.transaction_hash), blockNumber: event.block_number };
  } catch {
    // Anyone can emit an event with these keys. Ignore malformed or inconsistent candidates.
    return undefined;
  }
}

/**
 * Finds registrations by session key across all accounts, paging through a snapshot of closed blocks.
 * Accepts only the agent class and sessions that match the CLI's metadata and chain. Discovery does
 * not assert that a registration is still live: expiry and revocation are enforced by the account.
 */
export async function findRegisteredSessions(
  rpc: Pick<Rpc, "blockNumber" | "request" | "classHashAt">,
  args: { sessionKeyGuid: bigint; metadata: string; chainId: bigint; fromBlock?: number },
): Promise<RegisteredSession[]> {
  const { sessionKeyGuid, metadata, chainId, fromBlock = 0 } = args;
  const toBlock = await rpc.blockNumber();
  if (fromBlock > toBlock) return [];
  const registrations: RegisteredSession[] = [];
  const classes = new Map<bigint, bigint | undefined>();
  let continuationToken: string | undefined;
  do {
    const page = await rpc.request<{ events: RegistrationEvent[]; continuation_token?: string }>("starknet_getEvents", {
      filter: {
        from_block: { block_number: fromBlock },
        to_block: { block_number: toBlock },
        keys: [[toHex(REGISTERED)], [toHex(sessionKeyGuid)]],
        chunk_size: 100,
        ...(continuationToken && { continuation_token: continuationToken }),
      },
    });
    for (const event of page.events) {
      const registration = decodeRegistration(event, metadata, sessionKeyGuid, chainId);
      if (!registration) continue;
      const { account } = registration;
      if (!classes.has(account)) classes.set(account, await rpc.classHashAt(account));
      if (classes.get(account) === AGENT_ACCOUNT_CLASS_HASH) registrations.push(registration);
    }
    if (page.continuation_token && page.continuation_token === continuationToken) throw new Error("Repeated events continuation token");
    continuationToken = page.continuation_token;
  } while (continuationToken);
  return registrations;
}

/**
 * A session as its registration event's data has it (`SessionRegistered`: session hash, session,
 * allowed methods, allowed messages), as the indexer serves it for an agent's account: everything but
 * the metadata's text, of which the event carries only the hash. So the session's hash can't be
 * computed again from it: the lists are checked against the session's roots instead, and the data
 * must be whole, with nothing after it. Nothing for data that isn't one.
 */
export type DecodedRegistration = {
  hash: bigint;
  expiresAt: bigint;
  spendingLimits: SpendingLimit[];
  feeLimit: FeeLimit;
  metadataHash: bigint;
  sessionKey: bigint;
  allowedMethods: AllowedMethod[];
  allowedMessages: AllowedMessage[];
};

export function decodeRegistrationData(data: bigint[]): DecodedRegistration | undefined {
  try {
    let offset = 0;
    const take = () => {
      const value = data[offset++];
      if (value === undefined || value < 0n) throw new Error("Invalid registration data");
      return value;
    };
    const list = <T>(width: number, read: () => T): T[] => {
      const count = take();
      if (count > BigInt(Math.floor((data.length - offset) / width))) throw new Error("Truncated registration list");
      return Array.from({ length: Number(count) }, read);
    };
    const uint256 = () => {
      const low = take();
      const high = take();
      if (low >= 1n << 128n || high >= 1n << 128n) throw new Error("Invalid u256 limb");
      return low + (high << 128n);
    };
    const hash = take();
    const expiresAt = take();
    const methodsRoot = take();
    const messagesRoot = take();
    const spendingLimits = list(4, () => ({ token: take(), amount: uint256(), period: take() }));
    const feeLimit = { amount: take(), period: take() };
    const metadataHash = take();
    const sessionKey = take();
    const allowedMethods = list(2, () => ({ contract: take(), selector: take() }));
    const allowedMessages = list(2, () => ({ domainHash: take(), typeHash: take() }));
    if (offset !== data.length) return undefined;
    if (allowedMethodsRoot(allowedMethods) !== methodsRoot || allowedMessagesRoot(allowedMessages) !== messagesRoot) return undefined;
    return { hash, expiresAt, spendingLimits, feeLimit, metadataHash, sessionKey, allowedMethods, allowedMessages };
  } catch {
    return undefined;
  }
}
