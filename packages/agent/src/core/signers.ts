// A copy of what the agent needs from Outis's wallet core (its `@outis/core`, not published): the same
// declarations word for word, so that what is hashed and sent reads one way in the wallet and in the
// agent. Change it only as the wallet's changes.

import { hash, shortString } from "starknet";

// Serialization and GUIDs follow the Cairo definitions in the Argent Account v0.5.0 source
// (src/signer/signer_signature.cairo in github.com/outis-wallet/account). Outis only uses Stark-curve owners.

/** Variant index of `Signer::Starknet` and `SignerSignature::Starknet`. */
const STARKNET_VARIANT = 0n;
const STARKNET_SIGNER_TYPE = BigInt(shortString.encodeShortString("Starknet Signer"));

/**
 * An account owner: a Stark-curve public key. `bare`: it signs for an account that takes its
 * signature as `[r, s]` alone, with neither type nor key, as Braavos's do (see imported.ts).
 */
export type Signer = {
  pubkey: bigint;
  bare?: true;
};

export type SignerSignature = {
  signer: Signer;
  r: bigint;
  s: bigint;
};

function assertValidSigner(signer: Signer): void {
  if (signer.pubkey === 0n) throw new Error("Signer public key cannot be zero");
}

/** Cairo `Serde` encoding of `enum Signer`. */
export function serializeSigner(signer: Signer): bigint[] {
  assertValidSigner(signer);
  return [STARKNET_VARIANT, signer.pubkey];
}

/** The identifier the account stores and emits for a signer (`SignerTrait::into_guid`). */
export function signerGuid(signer: Signer): bigint {
  assertValidSigner(signer);
  return BigInt(hash.computePoseidonHash(STARKNET_SIGNER_TYPE, signer.pubkey));
}

/**
 * The signature array of a transaction or `is_valid_signature` call: one owner signature, in the
 * format that stays valid when the account has several owners; for a `bare` signer's account,
 * `[r, s]`. With `guardian` (Outis's 2FA), the owner's and then the guardian's, in the same
 * full format: the account's 4-felt short form needs exactly one Stark guardian, and the full one
 * stays valid with two.
 */
export function serializeAccountSignature(signature: SignerSignature, guardian?: SignerSignature): bigint[] {
  assertValidSigner(signature.signer);
  if (!guardian) {
    if (signature.signer.bare) return [signature.r, signature.s];
    return [1n, ...serializeSignerSignature(signature)];
  }
  assertValidSigner(guardian.signer);
  // A bare owner's account (Braavos) has no guardian of ours, and 4 felts would read as the short form.
  if (signature.signer.bare || guardian.signer.bare) throw new Error("A guardian signs only beside an Outis account's owner");
  return [2n, ...serializeSignerSignature(signature), ...serializeSignerSignature(guardian)];
}

/** Cairo `Serde` encoding of `enum SignerSignature`'s Starknet variant. */
function serializeSignerSignature({ signer, r, s }: SignerSignature): bigint[] {
  return [STARKNET_VARIANT, signer.pubkey, r, s];
}
