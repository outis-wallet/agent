import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadTypedData } from "../src/index.ts";

// The module in Node, which can't fetch it by URL as a page does: its bytes read from the build.

/** The module's build beside this package, where `pnpm build` puts it. */
export const TYPED_DATA_MODULE = new URL("../pkg/typed_data_bg.wasm", import.meta.url);

/** Loads the module from `module` (a file URL or a path; the build's by default) once: loading it again is the same promise. */
export function loadTypedDataFromFile(module: URL | string = TYPED_DATA_MODULE): Promise<void> {
  const path = module instanceof URL ? fileURLToPath(module) : module;
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    throw new Error(`No typed-data module at ${path}: run \`pnpm --filter @outis-wallet/typed-data build:wasm\` first`);
  }
  return loadTypedData(bytes);
}
