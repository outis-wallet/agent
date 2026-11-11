import { loadTypedDataFromFile } from "./index.ts";

// Loads the module from the build before anything else runs: a vitest setup file, or a script's first import.
await loadTypedDataFromFile();
