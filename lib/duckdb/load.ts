import type * as duckdb from "@duckdb/duckdb-wasm";
import type { SourceFormat } from "@/lib/sources/validate";
import { asNumber, firstRow, toRows } from "@/lib/arrow";

/** The single table every query runs against. Fixed, so it is never user- or
 *  model-controlled and never needs quoting in generated SQL. */
export const TABLE = "data";

export interface LoadedTable {
  /** Human-readable source name, for display only. */
  label: string;
  format: SourceFormat;
  rowCount: number;
  columns: { name: string; sqlType: string }[];
  /** Whether DuckDB accepted the lockdown described in lockDown(). */
  externalAccessDisabled: boolean;
  bytes: number;
}

export interface FetchProgress {
  loaded: number;
  total: number | null;
}

/**
 * Download the whole file with progress.
 *
 * We materialise rather than letting DuckDB range-read the URL lazily. That
 * costs memory on very large files, but it means DuckDB never touches the
 * network, which in turn lets us switch external access off entirely before any
 * model-authored SQL runs. For an in-browser tool that is the right trade.
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
 * Defence in depth behind lib/hypotheses/guard.ts. Once the data is in a table
 * DuckDB has no further need to reach a file or a URL, so we take the
 * capability away. DuckDB does not allow this to be switched back on.
 */
async function lockDown(conn: duckdb.AsyncDuckDBConnection): Promise<boolean> {
  try {
    await conn.query("SET enable_external_access=false");
    return true;
  } catch {
    // Older builds only accept this at startup. The expression guard is the
    // primary defence; report the weaker posture rather than pretending.
    return false;
  }
}

export async function loadIntoDuckDB(
  db: duckdb.AsyncDuckDB,
  opts: { bytes: Uint8Array; format: SourceFormat; label: string },
): Promise<LoadedTable> {
  const file = "source_input";
  await db.dropFiles();
  await db.registerFileBuffer(file, opts.bytes);

  const conn = await db.connect();
  try {
    await conn.query(
      `CREATE OR REPLACE TABLE ${TABLE} AS SELECT * FROM ${readerFor(opts.format, file)}`,
    );

    const described = toRows<{ column_name: string; column_type: string }>(
      await conn.query(`DESCRIBE ${TABLE}`),
    );
    const counted = firstRow<{ n: unknown }>(
      await conn.query(`SELECT count(*) AS n FROM ${TABLE}`),
    );

    // The registered buffer is a second copy of the file; the table owns the
    // data now, so release it before we start profiling.
    await db.dropFile(file);
    const externalAccessDisabled = await lockDown(conn);

    return {
      label: opts.label,
      format: opts.format,
      rowCount: asNumber(counted?.n) ?? 0,
      columns: described.map((d) => ({ name: d.column_name, sqlType: d.column_type })),
      externalAccessDisabled,
      bytes: opts.bytes.byteLength,
    };
  } finally {
    await conn.close();
  }
}
