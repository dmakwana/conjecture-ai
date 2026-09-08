import * as duckdb from "@duckdb/duckdb-wasm";
import { resolveBundle } from "./bundles";

export interface BootProgress {
  bytesLoaded: number;
  bytesTotal: number;
}

let dbPromise: Promise<duckdb.AsyncDuckDB> | null = null;

/**
 * Boot DuckDB once per page. The engine runs in its own Web Worker, so queries
 * never block the UI thread.
 *
 * The worker script is loaded through a Blob URL because `new Worker(crossOriginUrl)`
 * is forbidden; importScripts inside a same-origin blob is the standard
 * duckdb-wasm workaround for CDN-hosted bundles.
 */
export function getDuckDB(
  onProgress?: (p: BootProgress) => void,
): Promise<duckdb.AsyncDuckDB> {
  if (dbPromise) return dbPromise;

  dbPromise = (async () => {
    const bundle = await resolveBundle();

    const workerUrl = URL.createObjectURL(
      new Blob([`importScripts("${bundle.mainWorker!}");`], {
        type: "text/javascript",
      }),
    );

    try {
      const worker = new Worker(workerUrl);
      const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
      await db.instantiate(bundle.mainModule, bundle.pthreadWorker, (p) =>
        onProgress?.({ bytesLoaded: p.bytesLoaded, bytesTotal: p.bytesTotal }),
      );
      return db;
    } catch (err) {
      dbPromise = null; // let the next attempt retry from scratch
      throw err;
    } finally {
      URL.revokeObjectURL(workerUrl);
    }
  })();

  return dbPromise;
}
