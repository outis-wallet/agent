import { readFileSync } from "node:fs";
import { typedData as starknetTypedData } from "starknet";
import { describe, expect, it } from "vitest";
import { encodeValue, structHash, structValues, typeHash, typedDataHash, typedDataRevision, type Revision } from "../src/index.ts";

// The module against starknet.js: the crate's own vectors (crates/typed-data/tests/vectors.json,
// starknet.js's hashes and parts of each message), through the wasm build and this package's JSON,
// and starknet.js itself on the ones it hashes. `refused`: starknet.js hashes it and the crate
// refuses it (a name with a separator in it, which reads two ways).

type Vector = { name: string; account: string; data: { types: Record<string, never[]>; primaryType: string; domain: unknown; message: unknown }; hash: string | null; refused?: boolean; revision?: Revision; domain_hash?: string; type_hash?: string; fields?: string[] };
const vectors = (JSON.parse(readFileSync(new URL("../../../crates/typed-data/tests/vectors.json", import.meta.url), "utf8")) as { typed_data: Vector[] }).typed_data;

describe("typed data by the crate's module", () => {
  it.each(vectors.map((vector) => [vector.name, vector] as const))("%s", (_, vector) => {
    const expected = vector.hash !== null && vector.refused !== true ? BigInt(vector.hash) : undefined;
    if (expected === undefined) {
      expect(() => typedDataHash(BigInt(vector.account), vector.data)).toThrow();
      return;
    }
    expect(typedDataHash(BigInt(vector.account), vector.data)).toBe(expected);
    expect(BigInt(starknetTypedData.getMessageHash(vector.data as never, vector.account))).toBe(expected);
    const revision = typedDataRevision(vector.data)!;
    expect(revision).toBe(vector.revision);
    const domainType = revision === "1" ? "StarknetDomain" : "StarkNetDomain";
    expect(structHash(vector.data.types, domainType, vector.data.domain, revision)).toBe(BigInt(vector.domain_hash!));
    expect(typeHash(vector.data.types, vector.data.primaryType, revision)).toBe(BigInt(vector.type_hash!));
    expect(structValues(vector.data.types, vector.data.primaryType, vector.data.message, revision)).toEqual(vector.fields!.map(BigInt));
  });

  it("writes a bigint as the number it is", () => {
    const types = { StarknetDomain: [{ name: "name", type: "shortstring" }] };
    expect(encodeValue(types, "felt", 2n ** 200n, "1")).toBe(encodeValue(types, "felt", `0x${(2n ** 200n).toString(16)}`, "1"));
  });
});
