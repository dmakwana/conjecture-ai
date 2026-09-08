import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // duckdb-wasm boots a real wasm module in the node tests; give it room.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
