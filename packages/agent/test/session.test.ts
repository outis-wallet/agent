import { selector, toHex } from "../src/core/index.ts";
import { ec, hash, shortString, typedData, type TypedData } from "starknet";
import { describe, expect, it } from "vitest";
import {
  MessageNotAllowedError,
  SessionKey,
  allowedMessagesRoot,
  allowedMethodsRoot,
  messageLeaf,
  registerSessionCall,
  serializeSession,
  sessionHash,
  sessionMessageSignature,
  type Session,
} from "../src/index.ts";

// The fixture in agent-account/scripts/session-fixture.mjs, also checked by the Cairo tests.
const CHAIN_ID = BigInt(shortString.encodeShortString("SN_SEPOLIA"));
const ACCOUNT = 0x1724987234973219347210837402n;
const STRK = 0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938dn;
const METHODS_ROOT = 0x66d68acada7ff08cd8c0d8527a6c3998b2661c648e1b27f1a8733765a8c44d1n;
const MESSAGE_LEAF = 0x58ec4473f55cb382d8a589c2c95d9348efcb59c1f67673d49b81a0d74ddf25dn;
const GAME_DOMAIN = 0x3d8923680917209cbe8fec7b6fe524259e1fdb0162d1b377490d34580c6d92bn;
const GAME_TYPE = 0xd88a9d4412b386c3c7cbac82410db786655dee114866b6dc5db898c6fabbe7n;
const METADATA_HASH = 0x2c0d8a7273b9dd3b667bae46e8e24b44684be35c3fca44e69eb1477958efef3n;

const game: TypedData = {
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
  primaryType: "Game",
  domain: { name: "arbiter", version: "1", chainId: "SN_SEPOLIA", revision: "1" },
  message: { game: "go", game_id: "0x1234", context: "0x5678" },
};

const session: Session = {
  expiresAt: 1900000000n,
  allowedMethods: [
    { contract: STRK, selector: selector("transfer") },
    { contract: 0x123n, selector: selector("set_number") },
  ],
  allowedMessages: [{ domainHash: GAME_DOMAIN, typeHash: GAME_TYPE }],
  spendingLimits: [
    { token: STRK, amount: 100000000000000000000n, period: 86400n },
    { token: 0x456n, amount: (1n << 128n) + 5n, period: 0n },
  ],
  feeLimit: { amount: 2000000000000000000n, period: 86400n },
  metadata: '{"agent":"Claude Code"}',
  sessionKey: 0xabcn,
};

// Cairo Session's field order, including u256 low/high limbs and a single u128 fee amount.
const serialized = [
  1900000000n,
  METHODS_ROOT,
  MESSAGE_LEAF,
  2n,
  STRK, 100000000000000000000n, 0n, 86400n,
  0x456n, 5n, 1n, 0n,
  2000000000000000000n, 86400n,
  METADATA_HASH,
  0xabcn,
];

describe("session fixture", () => {
  it("matches the methods root, message leaf and session hash checked in Cairo", () => {
    expect(allowedMethodsRoot(session.allowedMethods)).toBe(METHODS_ROOT);
    expect(messageLeaf(session.allowedMessages[0]!)).toBe(MESSAGE_LEAF);
    expect(sessionHash(session, CHAIN_ID, ACCOUNT)).toBe(
      // OutisAccount 0.6.0's session domain: outis-wallet/contracts, tests/test_offchain_hashing.cairo, session_hash_matches_starknet_js.
      0x1769006341e3001be7f2963d7ee9c6ac986bf41053f975a7d23e7b6f86bf991n,
    );
  });

  it("serializes the complete session in Cairo field order", () => {
    expect(serializeSession(session)).toEqual(serialized);
  });

  it("builds the registration call with counted method and message lists", () => {
    expect(registerSessionCall(ACCOUNT, session)).toEqual({
      to: ACCOUNT,
      selector: selector("register_session"),
      calldata: [
        ...serialized,
        2n,
        STRK, selector("transfer"),
        0x123n, selector("set_number"),
        1n,
        GAME_DOMAIN, GAME_TYPE,
      ],
    });
  });

  it("encodes empty allowlists and spending limits as zero counts and roots", () => {
    const empty = { ...session, allowedMethods: [], allowedMessages: [], spendingLimits: [] };
    const encoded = [1900000000n, 0n, 0n, 0n, 2000000000000000000n, 86400n, METADATA_HASH, 0xabcn];
    expect(serializeSession(empty)).toEqual(encoded);
    expect(registerSessionCall(ACCOUNT, empty).calldata).toEqual([...encoded, 0n, 0n]);
  });
});

describe("session message signatures", () => {
  // A made-up key for these tests only.
  const privateKey = "0x12345";
  const key = SessionKey.fromPrivateKey(privateKey);
  const registered = { ...session, sessionKey: key.guid };
  const args = { session: registered, chainId: CHAIN_ID, account: ACCOUNT, message: game, key };

  it("encodes the message token and signs the hash the contract verifies", () => {
    const signature = sessionMessageSignature(args);
    expect(signature[0]).toBe(BigInt(shortString.encodeShortString("session-message")));
    expect(signature.slice(1, 17)).toEqual([...serialized.slice(0, -1), key.guid]);
    const [variant, pubkey, r, s] = signature.slice(17, 21);
    expect(variant).toBe(0n);
    expect(pubkey).toBe(key.signer.pubkey);
    expect(signature.slice(21)).toEqual([GAME_DOMAIN, GAME_TYPE, 3n, 0x676fn, 0x1234n, 0x5678n, 0n]);

    // Rebuild the hashes from the token, as Cairo does, and verify the actual ECDSA signature.
    const structHash = hash.computePoseidonHashOnElements([signature[22]!, ...signature.slice(24, 27)]);
    const messageHash = hash.computePoseidonHashOnElements([
      shortString.encodeShortString("StarkNet Message"), signature[21]!, ACCOUNT, structHash,
    ]);
    expect(messageHash).toBe(typedData.getMessageHash(game, toHex(ACCOUNT)));
    const identity = sessionHash(registered, CHAIN_ID, ACCOUNT);
    const signed = hash.computePoseidonHashOnElements([messageHash, identity]);
    const publicKey = ec.starkCurve.getPublicKey(privateKey);
    const starkSignature = new ec.starkCurve.Signature(r!, s!);
    expect(ec.starkCurve.verify(starkSignature, signed, publicKey)).toBe(true);
    expect(ec.starkCurve.verify(starkSignature, hash.computePoseidonHash(messageHash, identity), publicKey)).toBe(false);
    expect(ec.starkCurve.verify(starkSignature, hash.computePoseidonHashOnElements([messageHash, identity + 1n]), publicKey)).toBe(false);
  });

  it("includes a counted Merkle proof when more than one message kind is allowed", () => {
    const other = { domainHash: 0x111n, typeHash: 0x222n };
    const multiple = { ...registered, allowedMessages: [...registered.allowedMessages, other] };
    const signature = sessionMessageSignature({ ...args, session: multiple });
    const sibling = messageLeaf(other);
    expect(signature.slice(27)).toEqual([1n, sibling]);
    const [left, right] = MESSAGE_LEAF < sibling ? [MESSAGE_LEAF, sibling] : [sibling, MESSAGE_LEAF];
    expect(BigInt(hash.computePoseidonHash(left, right))).toBe(signature[3]);
    expect(signature[3]).toBe(allowedMessagesRoot(multiple.allowedMessages));
  });

  it.each([
    { ...game, domain: { ...game.domain, name: "another protocol" } },
    { ...game, primaryType: "Other", types: { ...game.types, Other: game.types.Game! } },
  ])("refuses a message outside the allowed domain and type", (message) => {
    expect(() => sessionMessageSignature({ ...args, message })).toThrow(MessageNotAllowedError);
  });

  it("refuses a key that does not belong to the session", () => {
    expect(() => sessionMessageSignature({ ...args, key: SessionKey.fromPrivateKey("0x54321") })).toThrow(
      "The session key doesn't match the session",
    );
  });

  it.each(["0", undefined])("refuses legacy typed data (revision %s)", (revision) => {
    const message = { ...game, domain: { ...game.domain, revision } };
    expect(() => sessionMessageSignature({ ...args, message })).toThrow("SNIP-12 revision 1");
  });
});
