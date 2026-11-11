import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { toHex } from "@outis-wallet/agent/core";
import { SessionKey, type Session } from "@outis-wallet/agent";
import { home } from "./config.ts";

// The CLI's files, one directory per network:
//   key.json       the session key (mode 0600: whoever reads it can act within the session)
//   request.json   what the CLI asked the keychain for, while it waits
//   sessions.json  the sessions registered for the key, as found on-chain
// The limits are on-chain, so a stolen file costs at most what its sessions allow.

export type StoredSession = {
  account: bigint;
  hash: bigint;
  session: Session;
  /** The block the registration was found in. */
  block: number;
};

export type PendingRequest = {
  metadata: string;
  /** Where to start looking for the registration: the block when the request was made. */
  fromBlock: number;
};

function directory(network: string): string {
  return join(home(), network);
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writePrivate(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function loadKey(network: string): Promise<SessionKey | undefined> {
  const stored = await readJson<{ privateKey: string }>(join(directory(network), "key.json"));
  return stored && SessionKey.fromPrivateKey(stored.privateKey);
}

/** The session key, made on first use. */
export async function ensureKey(network: string): Promise<SessionKey> {
  const existing = await loadKey(network);
  if (existing) return existing;
  const key = SessionKey.generate();
  await writePrivate(join(directory(network), "key.json"), { privateKey: key.exportPrivateKey() });
  return key;
}

function sessionToJson(session: Session) {
  return {
    expiresAt: toHex(session.expiresAt),
    allowedMethods: session.allowedMethods.map((m) => ({ contract: toHex(m.contract), selector: toHex(m.selector) })),
    allowedMessages: session.allowedMessages.map((m) => ({ domainHash: toHex(m.domainHash), typeHash: toHex(m.typeHash) })),
    spendingLimits: session.spendingLimits.map((l) => ({ token: toHex(l.token), amount: toHex(l.amount), period: toHex(l.period) })),
    feeLimit: { amount: toHex(session.feeLimit.amount), period: toHex(session.feeLimit.period) },
    metadata: session.metadata,
    sessionKey: toHex(session.sessionKey),
  };
}

function sessionFromJson(json: ReturnType<typeof sessionToJson>): Session {
  return {
    expiresAt: BigInt(json.expiresAt),
    allowedMethods: json.allowedMethods.map((m) => ({ contract: BigInt(m.contract), selector: BigInt(m.selector) })),
    allowedMessages: json.allowedMessages.map((m) => ({ domainHash: BigInt(m.domainHash), typeHash: BigInt(m.typeHash) })),
    spendingLimits: json.spendingLimits.map((l) => ({ token: BigInt(l.token), amount: BigInt(l.amount), period: BigInt(l.period) })),
    feeLimit: { amount: BigInt(json.feeLimit.amount), period: BigInt(json.feeLimit.period) },
    metadata: json.metadata,
    sessionKey: BigInt(json.sessionKey),
  };
}

type StoredSessionJson = { account: string; hash: string; session: ReturnType<typeof sessionToJson>; block: number };

export async function loadSessions(network: string): Promise<StoredSession[]> {
  const stored = (await readJson<StoredSessionJson[]>(join(directory(network), "sessions.json"))) ?? [];
  return stored.map((s) => ({ account: BigInt(s.account), hash: BigInt(s.hash), session: sessionFromJson(s.session), block: s.block }));
}

export async function saveSessions(network: string, sessions: StoredSession[]): Promise<void> {
  const json: StoredSessionJson[] = sessions.map((s) => ({
    account: toHex(s.account),
    hash: toHex(s.hash),
    session: sessionToJson(s.session),
    block: s.block,
  }));
  await writePrivate(join(directory(network), "sessions.json"), json);
}

export async function loadRequest(network: string): Promise<PendingRequest | undefined> {
  return readJson<PendingRequest>(join(directory(network), "request.json"));
}

export async function saveRequest(network: string, request: PendingRequest): Promise<void> {
  await writePrivate(join(directory(network), "request.json"), request);
}

/** Once its session is found, a request is done: the next `connect` asks for a new session. */
export async function clearRequest(network: string): Promise<void> {
  await rm(join(directory(network), "request.json"), { force: true });
}

/** The newest session that hasn't expired, or undefined. */
export function currentSession(sessions: StoredSession[], now: bigint): StoredSession | undefined {
  return sessions.filter((s) => s.session.expiresAt >= now).sort((a, b) => b.block - a.block)[0];
}
