import { Rpc, selector, toHex } from "../src/core/index.ts";
import { describe, expect, it, vi } from "vitest";
import { AGENT_ACCOUNT_CLASS_HASH, AGENT_ACCOUNT_SALT, agentAccountAddress, agentConstructorCalldata, decodeRegistrationData, findRegisteredSessions, registerSessionCall, serializeSession, sessionHash, type Session } from "../src/index.ts";

const chainId = 0x534e5f5345504f4c4941n;
const account = 0x123n;
const session: Session = {
  expiresAt: 1900000000n,
  allowedMethods: [{ contract: 0x456n, selector: selector("transfer") }],
  allowedMessages: [{ domainHash: 1n, typeHash: 2n }],
  spendingLimits: [{ token: 0x456n, amount: (1n << 128n) + 5n, period: 86400n }],
  feeLimit: { amount: 1000n, period: 86400n },
  metadata: '{"agent":"registry test"}',
  sessionKey: 0xabcn,
};
const args = { chainId, metadata: session.metadata, sessionKeyGuid: session.sessionKey };
const identity = sessionHash(session, chainId, account);
const encodedLength = serializeSession(session).length;

function fixture() {
  const rpc = new Rpc("http://unused.invalid");
  const event = {
    from_address: toHex(account),
    keys: [toHex(selector("SessionRegistered")), toHex(session.sessionKey)],
    data: [identity, ...registerSessionCall(account, session).calldata].map(toHex),
    transaction_hash: "0x789",
    block_number: 7,
  };
  vi.spyOn(rpc, "blockNumber").mockResolvedValue(10);
  const request = vi.spyOn(rpc, "request").mockResolvedValue({ events: [event] });
  const classHash = vi.spyOn(rpc, "classHashAt").mockResolvedValue(AGENT_ACCOUNT_CLASS_HASH);
  return { rpc, event, request, classHash };
}

describe("registration discovery", () => {
  it("pages through all accounts, verifies the class, and restores the metadata and u256 amount", async () => {
    const { rpc, event, request, classHash } = fixture();
    request.mockResolvedValueOnce({ events: [], continuation_token: "next" }).mockResolvedValueOnce({ events: [event] });
    expect(await findRegisteredSessions(rpc, args)).toEqual([{
      account, session, hash: identity, transactionHash: 0x789n, blockNumber: 7,
    }]);
    const filter = {
      from_block: { block_number: 0 }, to_block: { block_number: 10 },
      keys: [[toHex(selector("SessionRegistered"))], [toHex(session.sessionKey)]], chunk_size: 100,
    };
    expect(request).toHaveBeenNthCalledWith(1, "starknet_getEvents", { filter });
    expect(request).toHaveBeenNthCalledWith(2, "starknet_getEvents", { filter: { ...filter, continuation_token: "next" } });
    expect(classHash).toHaveBeenCalledWith(account);
  });

  it("ignores a convincing registration from the wrong account class", async () => {
    const { rpc, classHash } = fixture();
    classHash.mockResolvedValue(0xdeadn);
    expect(await findRegisteredSessions(rpc, args)).toEqual([]);
  });

  it.each([
    { ...args, metadata: "different metadata" },
    { ...args, chainId: chainId + 1n },
    { ...args, sessionKeyGuid: session.sessionKey + 1n },
  ])("ignores registrations that do not match the CLI's context", async (context) => {
    const { rpc } = fixture();
    expect(await findRegisteredSessions(rpc, context)).toEqual([]);
  });

  it.each([
    ["session hash", 0],
    ["methods root", 2],
    ["messages root", 3],
    ["metadata hash", encodedLength - 1],
    ["session key", encodedLength],
    ["method address", encodedLength + 2],
    ["message type", encodedLength + 6],
  ] as const)("rejects a tampered %s", async (_, index) => {
    const { rpc, event } = fixture();
    event.data[index] = toHex(BigInt(event.data[index]!) + 1n);
    expect(await findRegisteredSessions(rpc, args)).toEqual([]);
  });

  it.each(["truncated", "trailing", "huge count", "u256 overflow", "emitter"])("ignores malformed or inconsistent event data: %s", async (kind) => {
    const { rpc, event } = fixture();
    if (kind === "truncated") event.data.pop();
    if (kind === "trailing") event.data.push("0x0");
    if (kind === "huge count") event.data[4] = toHex(1n << 200n);
    if (kind === "u256 overflow") event.data[6] = toHex(1n << 128n);
    if (kind === "emitter") event.from_address = "0x999";
    expect(await findRegisteredSessions(rpc, args)).toEqual([]);
  });

  it("propagates class lookup failures so a temporary RPC error is not mistaken for no registration", async () => {
    const { rpc, classHash } = fixture();
    classHash.mockRejectedValue(new Error("RPC offline"));
    await expect(findRegisteredSessions(rpc, args)).rejects.toThrow("RPC offline");
  });
});

describe("agent account addresses", () => {
  const owner = { pubkey: 0x1234n };
  it("take the agents' own salt, never a main account's 0, and take no guardian", () => {
    expect(agentAccountAddress(owner)).toBe(agentAccountAddress(owner, AGENT_ACCOUNT_SALT));
    expect(agentAccountAddress(owner)).not.toBe(agentAccountAddress(owner, 0n));
    expect(agentConstructorCalldata(owner).at(-1)).toBe(1n);
  });
});

describe("a registration's data, as the indexer serves it", () => {
  const data = [identity, ...registerSessionCall(account, session).calldata];
  it("reads back the session but its metadata's text, and the lists it allows", () => {
    expect(decodeRegistrationData(data)).toEqual({
      hash: identity,
      expiresAt: session.expiresAt,
      spendingLimits: session.spendingLimits,
      feeLimit: session.feeLimit,
      metadataHash: serializeSession(session)[encodedLength - 2],
      sessionKey: session.sessionKey,
      allowedMethods: session.allowedMethods,
      allowedMessages: session.allowedMessages,
    });
  });
  it("refuses lists that aren't the ones the session's roots were made from, and data cut short or with more after it", () => {
    const methodAt = encodedLength + 2;
    const otherMethod = data.map((value, i) => (i === methodAt ? value + 1n : value));
    expect(decodeRegistrationData(otherMethod)).toBeUndefined();
    expect(decodeRegistrationData(data.slice(0, -1))).toBeUndefined();
    expect(decodeRegistrationData([...data, 0n])).toBeUndefined();
  });
});

