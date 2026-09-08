import { createRequire } from "node:module";
import path from "node:path";
import type * as arrow from "apache-arrow";

const require_ = createRequire(import.meta.url);

/**
 * A real DuckDB for tests, using duckdb-wasm's Node build so the profiling and
 * evaluation SQL is exercised by the same engine the browser runs.
 *
 * The blocking connection returns Arrow tables synchronously; the app code
 * expects a promise-returning `query`, so it is adapted here.
 */
export interface TestConn {
  query(sql: string): Promise<arrow.Table<never>>;
  close(): void;
}

/**
 * An adapter presenting the blocking Node bindings through the async surface
 * that lib/duckdb/load.ts expects, so the real loader — including the
 * enable_external_access lockdown — can be exercised in tests.
 */
export interface TestDb {
  db: unknown;
  conn: TestConn;
}

export async function createTestDb(): Promise<TestDb> {
  const { bindings, conn } = await createBindings();
  const asyncLike = {
    dropFiles: async () => bindings.dropFiles(),
    dropFile: async (name: string) => bindings.dropFile(name),
    registerFileBuffer: async (name: string, buffer: Uint8Array) =>
      bindings.registerFileBuffer(name, buffer),
    connect: async () => ({
      query: async (sql: string) => conn.query(sql),
      close: async () => {},
    }),
  };
  return { db: asyncLike, conn: { query: async (sql: string) => conn.query(sql), close: () => conn.close() } };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function createBindings(): Promise<{ bindings: any; conn: any }> {
  const duckdb = require_("@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs");
  const dist = path.dirname(require_.resolve("@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs"));

  const bundles = {
    mvp: {
      mainModule: path.join(dist, "duckdb-mvp.wasm"),
      mainWorker: path.join(dist, "duckdb-node-mvp.worker.cjs"),
    },
    eh: {
      mainModule: path.join(dist, "duckdb-eh.wasm"),
      mainWorker: path.join(dist, "duckdb-node-eh.worker.cjs"),
    },
  };

  const bindings = await duckdb.createDuckDB(bundles, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
  await bindings.instantiate(() => {});
  return { bindings, conn: bindings.connect() };
}

export async function createTestConnection(): Promise<TestConn> {
  const { conn } = await createBindings();
  return {
    query: async (sql: string) => conn.query(sql),
    close: () => conn.close(),
  };
}
