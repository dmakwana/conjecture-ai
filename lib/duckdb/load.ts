import type * as duckdb from "@duckdb/duckdb-wasm";
import type { SourceFormat } from "@/lib/sources/validate";
import { asNumber, firstRow, toRows } from "@/lib/arrow";
import { isSafeTableName } from "./tables";

export interface SourceInput {
  /** SQL identifier for this source's table. */
  table: string;
  /** Original filename or URL, for display. */
  label: string;
  format: SourceFormat;
  bytes: Uint8Array;
}

export interface LoadedTable {
  table: string;
  label: string;
  format: SourceFormat;
  rowCount: number;
  columns: { name: string; sqlType: string }[];
  bytes: number;
}

export interface LoadedDatabase {
  tables: LoadedTable[];
  /** Whether DuckDB accepted the lockdown described in lockDown(). */
  externalAccessDisabled: boolean;
  loadMs: number;
}

export interface FetchProgress {
  loaded: number;
  total: number | null;
}

/**
 * Download the whole file with progress.
 *
 * We materialise rather than letting DuckDB range-read the URL lazily. That
 * costs memory on large files, but it means DuckDB never touches the network,
 * which in turn lets us switch external access off entirely before any
 * model-authored SQL runs.
 */
export async function fetchWithProgress(
  url: string,
  onProgress?: (p: FetchProgress) => void,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Server responded ${res.status} ${res.statusText}`);

  const lengthHeader = res.headers.get("content-length");
  const total = lengthHeader ? Number(lengthHeader) : null;

  if (!res.body) return new Uint8Array(await res.arrayBuffer());

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.({ loaded, total: Number.isFinite(total) ? total : null });
  }

  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function readerFor(format: SourceFormat, file: string): string {
  switch (format) {
    case "parquet":
      return `read_parquet('${file}')`;
    case "csv":
      return `read_csv_auto('${file}')`;
    case "json":
      return `read_json_auto('${file}')`;
  }
}

/**
 * Defence in depth behind lib/hypotheses/guard.ts. Once every source is in a
 * table DuckDB has no further need to reach a file or a URL, so we take the
 * capability away. DuckDB does not allow this to be switched back on, which is
 * exactly why rebuildDatabase re-opens rather than reusing.
 */
async function lockDown(conn: duckdb.AsyncDuckDBConnection): Promise<boolean> {
  try {
    await conn.query("SET enable_external_access=false");
    return true;
  } catch {
    return false;
  }
}

/**
 * Rebuild the whole database from the given sources.
 *
 * This is deliberately all-or-nothing rather than incremental. `enable_external_access=false`
 * is global to the database and cannot be undone, so a database that has loaded
 * one dataset can never read another file; re-opening is the only way back, and
 * re-opening drops every table. Rebuilding from retained bytes keeps one code
 * path and leaves the database in the same state — every source present, access
 * locked down — no matter what order sources were added or removed in.
 *
 * The cost is that each source's bytes are retained in memory for as long as it
 * is loaded. Callers must close any connection before calling, and reconnect
 * afterwards.
 */
export async function rebuildDatabase(
  db: duckdb.AsyncDuckDB,
  sources: SourceInput[],
  onProgress?: (done: number, total: number, label: string) => void,
): Promise<LoadedDatabase> {
  const started = performance.now();

  await db.open({});
  await db.dropFiles();

  const conn = await db.connect();
  try {
    const tables: LoadedTable[] = [];

    for (const [index, source] of sources.entries()) {
      if (!isSafeTableName(source.table)) {
        throw new Error(`Unsafe table name: ${source.table}`);
      }
      onProgress?.(index, sources.length, source.label);

      const file = `source_${index}`;
      await db.registerFileBuffer(file, source.bytes);
      await conn.query(
        `CREATE OR REPLACE TABLE ${source.table} AS SELECT * FROM ${readerFor(source.format, file)}`,
      );
      // The registered buffer is a second copy; the table owns the data now.
      await db.dropFile(file);

      const described = toRows<{ column_name: string; column_type: string }>(
        await conn.query(`DESCRIBE ${source.table}`),
      );
      const counted = firstRow<{ n: unknown }>(
        await conn.query(`SELECT count(*) AS n FROM ${source.table}`),
      );

      tables.push({
        table: source.table,
        label: source.label,
        format: source.format,
        rowCount: asNumber(counted?.n) ?? 0,
        columns: described.map((d) => ({ name: d.column_name, sqlType: d.column_type })),
        bytes: source.bytes.byteLength,
      });
    }

    onProgress?.(sources.length, sources.length, "");
    const externalAccessDisabled = sources.length > 0 ? await lockDown(conn) : false;

    return {
      tables,
      externalAccessDisabled,
      loadMs: Math.round(performance.now() - started),
    };
  } finally {
    await conn.close();
  }
}
