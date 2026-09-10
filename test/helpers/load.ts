import { rebuildDatabase, type SourceInput, type LoadedDatabase } from "@/lib/duckdb/load";
import { schemaFrom, type Schema } from "@/lib/hypotheses/evaluate";

export const encode = (s: string) => new TextEncoder().encode(s);

/** Load one or more in-memory CSV/Parquet sources for a test. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadSources(db: any, sources: SourceInput[]): Promise<{
  loaded: LoadedDatabase;
  schema: Schema;
  rowCounts: Map<string, number>;
}> {
  const loaded = await rebuildDatabase(db, sources);
  return {
    loaded,
    schema: schemaFrom(loaded.tables),
    rowCounts: new Map(loaded.tables.map((t) => [t.table, t.rowCount])),
  };
}
