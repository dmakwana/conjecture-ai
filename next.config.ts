import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pure static export: the whole app ships as assets on Cloudflare Workers.
  // The only server-side code is worker/index.ts.
  output: "export",
  images: { unoptimized: true },
  // duckdb-wasm ships browser ESM that Turbopack occasionally needs help with.
  transpilePackages: ["@duckdb/duckdb-wasm"],
};

export default nextConfig;
