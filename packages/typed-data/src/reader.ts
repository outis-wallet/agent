// SNIP-12 typed data by the outis-typed-data crate, over any WebAssembly build that exports its
// functions: this package's own (index.ts), or a larger module with the crate inside that exports the
// same ones (Outis's wallet core binds its own module here, so that a page loads one module and
// hashes one way). JSON text crosses into the module; a refusal comes back as a thrown error.

/** The crate's exports (crates/typed-data/src/wasm.rs), as wasm-bindgen writes them. */
export type TypedDataModule = {
  typed_data_hash(json: string, account: string): string;
  typed_data_revision(json: string): string;
  scalar(json: string, kind: string, revision: string): string;
  struct_hash(types: string, name: string, data: string, revision: string): string;
  type_hash(types: string, name: string, revision: string): string;
  struct_values(types: string, name: string, data: string, revision: string): string;
  encode_value(types: string, kind: string, json: string, revision: string): string;
};

/** A SNIP-12 revision, as starknet.js names it. */
export type Revision = "0" | "1";

/** Types as a message gives them: each a list of fields. */
export type Types = Record<string, { name: string; type: string; contains?: string }[]>;

const hex = (value: bigint) => `0x${value.toString(16)}`;

/**
 * Typed data as JSON for the crate. A site's typed data is JSON already; one built in code may hold
 * bigints, which JSON has no form for: written as decimal text, which starknet.js and the crate read
 * as the same number wherever a number goes.
 */
const json = (data: unknown) => JSON.stringify(data, (_, value: unknown) => (typeof value === "bigint" ? value.toString() : value));

/** The functions over `module`, which `ready` checks is loaded before each call (it throws if not). */
export function typedDataReader(module: () => TypedDataModule) {
  return {
    /**
     * The hash `account` signs for the typed data `data` (SNIP-12, revisions 0 and 1, as starknet.js
     * hashes it). Throws for what starknet.js couldn't hash, and for what it would hash though it can
     * be read two ways: a type or field name with a separator in it.
     */
    typedDataHash(account: bigint, data: unknown): bigint {
      return BigInt(module().typed_data_hash(json(data), hex(account)));
    },

    /**
     * The revision `data` is hashed under, as starknet.js decides it: "1" where the types have a
     * StarknetDomain and the domain's revision reads "1" (as text or as a number), "0" where they have
     * a StarkNetDomain and the domain no revision or the text "0", and none otherwise: starknet.js
     * won't hash such a message at all.
     */
    typedDataRevision(data: unknown): Revision | undefined {
      const core = module();
      try {
        return core.typed_data_revision(json(data)) as Revision;
      } catch {
        return undefined;
      }
    },

    /**
     * The felt `value` is hashed as where a scalar `kind` goes (felt, shortstring, u128, i128,
     * ContractAddress, ClassHash, timestamp, bool, selector) under `revision`: what a message's field
     * is shown as, by the hash's own reading of it (a string that reads as a number is that number,
     * other text a short string where the kind takes one). Throws where starknet.js wouldn't hash it.
     */
    scalarFelt(value: unknown, kind: string, revision: Revision): bigint {
      return BigInt(module().scalar(json(value), kind, revision));
    },

    /**
     * starknet.js's getStructHash: `data` hashed as the struct `type` among `types` under `revision`.
     * The types are read as a message's are, so a name with a separator in it throws, as a message of
     * those types would.
     */
    structHash(types: Types, type: string, data: unknown, revision: Revision): bigint {
      return BigInt(module().struct_hash(json(types), type, json(data), revision));
    },

    /** starknet.js's getTypeHash: the hash of `type`'s encoding among `types` under `revision`; the types read as structHash reads them. */
    typeHash(types: Types, type: string, revision: Revision): bigint {
      return BigInt(module().type_hash(json(types), type, revision));
    },

    /** starknet.js's encodeData's values: the type hash of `type`, then each of its fields of `data` encoded, under `revision`. */
    structValues(types: Types, type: string, data: unknown, revision: Revision): bigint[] {
      return (JSON.parse(module().struct_values(json(types), type, json(data), revision)) as string[]).map(BigInt);
    },

    /** starknet.js's encodeValue, outside any struct: `value` encoded as `kind` among `types` (a struct of theirs, a list, a string, a scalar) under `revision`. */
    encodeValue(types: Types, kind: string, value: unknown, revision: Revision): bigint {
      return BigInt(module().encode_value(json(types), kind, json(value), revision));
    },
  };
}
