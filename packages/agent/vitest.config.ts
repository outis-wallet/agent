import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The typed-data module, loaded before any test: `pnpm build:wasm` at the root first.
    setupFiles: ["@outis-wallet/typed-data/node/load"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "json-summary"],
    },
  },
});
