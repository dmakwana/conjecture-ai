import * as duckdb from "@duckdb/duckdb-wasm";

/**
 * The only file that knows where the DuckDB WebAssembly binary comes from.
 *
 * It cannot be served from Cloudflare Workers static assets: duckdb-eh.wasm is
 * 34 MiB and the per-file asset limit is 25 MiB. So it comes from jsDelivr
 * (~10 MB brotli-compressed over the wire, then cached by the browser).
 *
 * To self-host from R2 later, upload duckdb-eh.wasm, duckdb-mvp.wasm and their
 * matching worker scripts to a bucket and set NEXT_PUBLIC_DUCKDB_BASE_URL.
 * Nothing else in the codebase changes.
 */
function selfHostedBundles(base: string): duckdb.DuckDBBundles {
  return {
    mvp: {
      mainModule: `${base}/duckdb-mvp.wasm`,
      mainWorker: `${base}/duckdb-browser-mvp.worker.js`,
    },
    eh: {
      mainModule: `${base}/duckdb-eh.wasm`,
      mainWorker: `${base}/duckdb-browser-eh.worker.js`,
    },
    // `coi` is deliberately omitted. The threaded build requires site-wide
    // cross-origin isolation (COOP/COEP), which we do not enable.
  };
}

export async function resolveBundle(): Promise<duckdb.DuckDBBundle> {
  const base = process.env.NEXT_PUBLIC_DUCKDB_BASE_URL?.replace(/\/$/, "");
  const bundles = base ? selfHostedBundles(base) : duckdb.getJsDelivrBundles();
  return duckdb.selectBundle(bundles);
}
