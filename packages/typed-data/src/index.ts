import init, * as wasm from "../pkg/typed_data.js";
import { typedDataReader } from "./reader.ts";

// SNIP-12 typed data by the outis-typed-data crate in WebAssembly (crates/typed-data, built by
// scripts/build-wasm.sh). The module is loaded once, before anything hashes: in a browser from the
// module beside this package (a bundler serves it as an asset), in Node from its bytes
// (`@outis-wallet/typed-data/node`). Every function throws until it is loaded: a hash computed
// another way would be a second reading.

export type { Revision, Types, TypedDataModule } from "./reader.ts";
export { typedDataReader } from "./reader.ts";

let loading: Promise<void> | undefined;
let loaded = false;

/**
 * Loads the module once: from `source`, its bytes or a compiled module (Node, tests), or from the
 * module beside this package. Loading it again is the same promise.
 */
export function loadTypedData(source?: BufferSource | WebAssembly.Module): Promise<void> {
  loading ??= init({ module_or_path: source ?? new URL("../pkg/typed_data_bg.wasm", import.meta.url) }).then(() => {
    loaded = true;
  });
  return loading;
}

/** Whether the module is loaded: what the functions below need. */
export function typedDataLoaded(): boolean {
  return loaded;
}

export const { typedDataHash, typedDataRevision, scalarFelt, structHash, typeHash, structValues, encodeValue } = typedDataReader(() => {
  if (!loaded) throw new Error("The typed-data module isn't loaded: await loadTypedData() first");
  return wasm;
});
