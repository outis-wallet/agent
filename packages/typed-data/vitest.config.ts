import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The module from the build, loaded before any test: `pnpm build:wasm` first.
    setupFiles: ["./node/load.ts"],
  },
});
