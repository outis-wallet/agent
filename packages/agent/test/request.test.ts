import { base64UrlEncode, selector, toHex, utf8 } from "../src/core/index.ts";
import { typedData } from "starknet";
import { describe, expect, it } from "vitest";
import { SessionKey, agentRequestLink, fingerprint, readAgentRequest, type AgentRequest } from "../src/index.ts";

const key = SessionKey.generate();
const game = {
  types: {
    StarknetDomain: [
      { name: "name", type: "shortstring" },
      { name: "version", type: "shortstring" },
      { name: "chainId", type: "shortstring" },
      { name: "revision", type: "shortstring" },
    ],
    Game: [
      { name: "game", type: "shortstring" },
      { name: "game_id", type: "felt" },
      { name: "context", type: "felt" },
    ],
  },
  domain: { name: "arbiter", version: "1", chainId: "SN_SEPOLIA", revision: "1" },
};

function request(): AgentRequest {
  const { StarknetDomain: _, ...types } = game.types;
  return {
    v: 1,
    chainId: "0x534e5f5345504f4c4941",
    pubkey: toHex(key.signer.pubkey),
    guid: toHex(key.guid),
    metadata: JSON.stringify({ agent: "test", at: 1 }),
    name: "Claude Code",
    asks: ["send"],
    methods: [{ contract: "0x4a1", entrypoint: "play", selector: toHex(selector("play")), why: "to play Foo" }],
    messages: [
      {
        domain: game.domain,
        primaryType: "Game",
        types,
        domainHash: typedData.getStructHash(game.types, "StarknetDomain", game.domain, "1"),
        typeHash: typedData.getTypeHash(game.types, "Game", "1"),
      },
    ],
  };
}

const fragmentOf = (value: unknown) => `#agent=${base64UrlEncode(utf8(JSON.stringify(value)))}`;

describe("agent request", () => {
  it("reads back what the link carries", () => {
    const link = new URL(agentRequestLink("https://key.outis.xyz/", request()));
    expect(link.pathname).toBe("/");
    expect(readAgentRequest(link.hash)).toEqual(request());
  });

  it("isn't one when the fragment is something else", () => {
    expect(readAgentRequest("#setup")).toBeUndefined();
    expect(readAgentRequest("")).toBeUndefined();
  });

  it("refuses a GUID that isn't the key's", () => {
    expect(() => readAgentRequest(fragmentOf({ ...request(), guid: toHex(key.guid + 1n) }))).toThrow(/GUID/);
  });

  it("refuses a selector that isn't its entry point's", () => {
    const tampered = { ...request(), methods: [{ contract: "0x4a1", entrypoint: "play", selector: toHex(selector("transfer")) }] };
    expect(() => readAgentRequest(fragmentOf(tampered))).toThrow(/selector/);
  });

  it("refuses a kind of message whose hashes aren't its own", () => {
    const [message] = request().messages;
    const wrongType = { ...request(), messages: [{ ...message, typeHash: toHex(1n) }] };
    expect(() => readAgentRequest(fragmentOf(wrongType))).toThrow(/type/);
    const wrongDomain = { ...request(), messages: [{ ...message, domain: { ...game.domain, name: "other" } }] };
    expect(() => readAgentRequest(fragmentOf(wrongDomain))).toThrow(/domain/);
  });

  it("refuses what it can't read", () => {
    expect(() => readAgentRequest("#agent=not-base64-json")).toThrow();
    expect(() => readAgentRequest(fragmentOf({ ...request(), v: 2 }))).toThrow(/version/);
  });

  // starknet.js doesn't escape the separators in a type's names, so a field named for the rest of a
  // type hashes as that type: the keychain would show one layout (the fields as the request lists
  // them) for a type hash that is another's (Bramble's finding). The typed-data crate
  // refuses the names; since 2026-10-24 a request's hashes are checked by it, so such a kind is no
  // kind, though its hashes are what starknet.js computes for it.
  it("refuses a kind of message whose types carry a separator, though starknet.js hashes it", () => {
    const types = { ...game.types, Game: [{ name: 'game":"shortstring","game_id":"felt","context', type: "felt" }] };
    const claimed = { domainHash: typedData.getStructHash(types, "StarknetDomain", game.domain, "1"), typeHash: typedData.getTypeHash(types, "Game", "1") };
    // The decoy's type hash is the honest type's: a session allowing it allows honest Game messages.
    expect(BigInt(claimed.typeHash)).toBe(BigInt(typedData.getTypeHash(game.types, "Game", "1")));
    const { StarknetDomain: _, ...own } = types;
    const decoy = { ...request(), messages: [{ domain: game.domain, primaryType: "Game", types: own, ...claimed }] };
    expect(() => readAgentRequest(fragmentOf(decoy))).toThrow(/can't hash/);
  });

  it("shows the key as eight hex digits", () => {
    expect(fingerprint(0x1234abcdefn)).toBe("0000-0012-34AB-CDEF");
    expect(fingerprint(0xffff_1111_2222_3333_4444n)).toBe("1111-2222-3333-4444");
  });
});
