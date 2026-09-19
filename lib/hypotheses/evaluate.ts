import type * as duckdb from "@duckdb/duckdb-wasm";
import { asNumber, columnNames, firstRow, toJs } from "@/lib/arrow";
import { isSafeTableName } from "@/lib/duckdb/tables";
import { guardColumns, guardExpression, quoteIdent } from "./guard";
import type { Check, Hypothesis, HypothesisResult } from "./schema";

/** Rows shown when inspecting a falsified hypothesis. Never leaves the browser. */
export const VIOLATION_PREVIEW_LIMIT = 200;

/** The schema every check is validated against before any SQL is built. */
export interface Schema {
  /** table name -> column name -> DuckDB type */
  tables: Map<string, Map<string, string>>;
}

export function schemaFrom(
  tables: { table: string; columns: { name: string; sqlType: string }[] }[],
): Schema {
  return {
    tables: new Map(
      tables.map((t) => [t.table, new Map(t.columns.map((c) => [c.name, c.sqlType]))]),
    ),
  };
}

/**
 * Comparison families. Two columns can only be compared meaningfully if they
 * land in the same one.
 *
 * This exists because DuckDB will happily coerce across families instead of
 * complaining: joining a BIGINT key to a zero-padded VARCHAR key silently
 * matches '0001' to 1, so a reference check reports far fewer violations than
 * are really there. A quiet wrong answer is worse than a refusal, and a key
 * whose type differs between two tables is itself a defect worth surfacing.
 */
export type TypeFamily = "numeric" | "text" | "temporal" | "boolean" | "other";

export function typeFamily(sqlType: string): TypeFamily {
  const t = sqlType.toUpperCase().trim();
  if (/^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UHUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|FLOAT|DOUBLE|REAL|DECIMAL|NUMERIC)/.test(t)) {
    return "numeric";
  }
  if (/^(VARCHAR|CHAR|TEXT|STRING|UUID)/.test(t)) return "text";
  if (/^(DATE|TIMESTAMP|TIME)/.test(t)) return "temporal";
  if (t === "BOOLEAN") return "boolean";
  return "other";
}

function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.split("\n")[0].replace(/^(Binder|Catalog|Parser|Conversion) Error:\s*/, "").trim();
}

/**
 * Resolve a model-supplied table name against the real schema.
 *
 * Table names come from filenames, so they are already sanitised to a plain
 * identifier; this checks the model named one that actually exists rather than
 * inventing one, and re-checks the shape before it reaches SQL.
 */
function resolveTable(schema: Schema, name: string): string {
  if (!schema.tables.has(name)) {
    throw new Error(`Unknown table "${name}".`);
  }
  if (!isSafeTableName(name)) {
    throw new Error(`Unsafe table name "${name}".`);
  }
  return name;
}

function columnsOf(schema: Schema, table: string): string[] {
  return [...(schema.tables.get(table)?.keys() ?? [])];
}

function typeOf(schema: Schema, table: string, column: string): string {
  return schema.tables.get(table)?.get(column) ?? "UNKNOWN";
}

/**
 * Refuse a reference whose two sides are not comparable, naming both types.
 *
 * Returning a clear refusal rather than a number is the point: the alternative
 * is either DuckDB's conversion error (which embeds a cell value) or, worse, a
 * silently coerced count that is simply wrong. The refusal also reaches the
 * model as a finding, so a later round can propose a corrected check.
 */
function assertComparable(
  schema: Schema,
  table: string,
  columns: string[],
  refTable: string,
  refColumns: string[],
): void {
  for (const [i, column] of columns.entries()) {
    const left = typeOf(schema, table, column);
    const right = typeOf(schema, refTable, refColumns[i]);
    if (typeFamily(left) !== typeFamily(right)) {
      throw new Error(
        `Cannot compare ${table}.${column} (${left}) with ${refTable}.${refColumns[i]} (${right}): types differ.`,
      );
    }
  }
}

/**
 * Build the counting query for a check.
 *
 * Every FROM clause here is ours and every result is a single count, so a
 * generated check cannot reshape the query into something that returns data.
 * A NULL predicate counts as passing: absence of a value is not evidence the
 * claim is false, and hypotheses that care about nulls say so explicitly.
 */
export function violationCountQuery(check: Check, schema: Schema): string {
  const table = resolveTable(schema, check.table);

  if (check.kind === "row_predicate") {
    const guarded = guardExpression(check.expression);
    if (!guarded.ok) throw new Error(guarded.reason);
    return `SELECT count(*) AS violations FROM ${table} WHERE NOT coalesce((${guarded.expression}), true)`;
  }

  if (check.kind === "unique") {
    const guarded = guardColumns(check.columns, columnsOf(schema, table));
    if (!guarded.ok) throw new Error(guarded.reason);
    const cols = guarded.columns.map(quoteIdent).join(", ");
    return (
      `SELECT CAST(coalesce(sum(n), 0) AS BIGINT) AS violations FROM (` +
      `SELECT count(*) AS n FROM ${table} GROUP BY ${cols} HAVING count(*) > 1)`
    );
  }

  // references: every value of table.columns must appear in referencesTable.
  const refTable = resolveTable(schema, check.referencesTable);
  const left = guardColumns(check.columns, columnsOf(schema, table));
  if (!left.ok) throw new Error(left.reason);
  const right = guardColumns(check.referencesColumns, columnsOf(schema, refTable));
  if (!right.ok) throw new Error(right.reason);
  if (left.columns.length !== right.columns.length) {
    throw new Error("Referencing and referenced column counts differ.");
  }
  assertComparable(schema, table, left.columns, refTable, right.columns);

  // Rows with a NULL key are skipped, matching normal foreign-key semantics:
  // an absent value is not a broken reference.
  const notNull = left.columns.map((c) => `child.${quoteIdent(c)} IS NOT NULL`).join(" AND ");
  const join = left.columns
    .map((c, i) => `parent.${quoteIdent(right.columns[i])} = child.${quoteIdent(c)}`)
    .join(" AND ");

  return (
    `SELECT count(*) AS violations FROM ${table} AS child ` +
    `WHERE ${notNull} AND NOT EXISTS (` +
    `SELECT 1 FROM ${refTable} AS parent WHERE ${join})`
  );
}

export function violationRowsQuery(check: Check, schema: Schema): string {
  const table = resolveTable(schema, check.table);

  if (check.kind === "row_predicate") {
    const guarded = guardExpression(check.expression);
    if (!guarded.ok) throw new Error(guarded.reason);
    return `SELECT * FROM ${table} WHERE NOT coalesce((${guarded.expression}), true) LIMIT ${VIOLATION_PREVIEW_LIMIT}`;
  }

  if (check.kind === "unique") {
    const guarded = guardColumns(check.columns, columnsOf(schema, table));
    if (!guarded.ok) throw new Error(guarded.reason);
    const cols = guarded.columns.map(quoteIdent).join(", ");
    return `SELECT * FROM ${table} QUALIFY count(*) OVER (PARTITION BY ${cols}) > 1 LIMIT ${VIOLATION_PREVIEW_LIMIT}`;
  }

  const refTable = resolveTable(schema, check.referencesTable);
  const left = guardColumns(check.columns, columnsOf(schema, table));
  if (!left.ok) throw new Error(left.reason);
  const right = guardColumns(check.referencesColumns, columnsOf(schema, refTable));
  if (!right.ok) throw new Error(right.reason);
  assertComparable(schema, table, left.columns, refTable, right.columns);

  const notNull = left.columns.map((c) => `child.${quoteIdent(c)} IS NOT NULL`).join(" AND ");
  const join = left.columns
    .map((c, i) => `parent.${quoteIdent(right.columns[i])} = child.${quoteIdent(c)}`)
    .join(" AND ");

  return (
    `SELECT child.* FROM ${table} AS child ` +
    `WHERE ${notNull} AND NOT EXISTS (` +
    `SELECT 1 FROM ${refTable} AS parent WHERE ${join}) ` +
    `LIMIT ${VIOLATION_PREVIEW_LIMIT}`
  );
}

/** Rows the check runs against, used to turn a violation count into a share. */
function denominatorFor(check: Check, rowCounts: Map<string, number>): number {
  return rowCounts.get(check.table) ?? 0;
}

export async function evaluateHypothesis(
  conn: duckdb.AsyncDuckDBConnection,
  h: Hypothesis,
  schema: Schema,
  rowCounts: Map<string, number>,
): Promise<HypothesisResult> {
  let sql: string;
  try {
    sql = violationCountQuery(h.check, schema);
  } catch (err) {
    return { status: "skipped", reason: errorMessage(err) };
  }

  const rowCount = denominatorFor(h.check, rowCounts);
  const started = performance.now();
  try {
    const row = firstRow<{ violations: unknown }>(await conn.query(sql));
    const violations = asNumber(row?.violations) ?? 0;
    const ms = Math.round(performance.now() - started);

    if (violations === 0) return { status: "holds", violations: 0, rowCount, ms, sql };
    return {
      status: "falsified",
      violations,
      rowCount,
      pct: rowCount === 0 ? 0 : (violations / rowCount) * 100,
      ms,
      sql,
    };
  } catch (err) {
    // An invalid expression (unknown column, type mismatch) lands here. That is
    // information, not a failure: show it rather than dropping the hypothesis.
    return { status: "skipped", reason: errorMessage(err), sql };
  }
}

export interface ViolationPreview {
  columns: string[];
  rows: unknown[][];
}

export async function fetchViolationRows(
  conn: duckdb.AsyncDuckDBConnection,
  h: Hypothesis,
  schema: Schema,
): Promise<ViolationPreview> {
  const table = await conn.query(violationRowsQuery(h.check, schema));
  const cols = columnNames(table);
  const rows = table.toArray().map((row) => {
    const obj = toJs(row) as Record<string, unknown>;
    return cols.map((c) => obj[c] ?? null);
  });
  return { columns: cols, rows };
}

/**
 * How many DuckDB connections evaluate checks at once.
 *
 * Honest caveat: the `eh` WebAssembly build is single-threaded, so this is not
 * true CPU parallelism. DuckDB still executes one query at a time. What it does
 * buy is that queries are queued inside the worker instead of each waiting for a
 * JS round trip, and results surface the moment each finishes rather than after
 * the whole batch. If the threaded build is ever enabled this becomes real
 * parallelism with no code change.
 */
export const EVAL_CONCURRENCY = 4;

export interface EvaluationHandlers {
  onStart?: (id: string) => void;
  onResult?: (id: string, result: HypothesisResult) => void;
}

export async function evaluateAllHypotheses(
  db: duckdb.AsyncDuckDB,
  hypotheses: Hypothesis[],
  schema: Schema,
  rowCounts: Map<string, number>,
  handlers: EvaluationHandlers = {},
  concurrency: number = EVAL_CONCURRENCY,
  signal?: AbortSignal,
): Promise<void> {
  let cursor = 0;
  const lanes = Math.max(1, Math.min(concurrency, hypotheses.length));

  await Promise.all(
    Array.from({ length: lanes }, async () => {
      const conn = await db.connect();
      try {
        for (;;) {
          const index = cursor++;
          if (index >= hypotheses.length || signal?.aborted) break;

          const h = hypotheses[index];
          handlers.onStart?.(h.id);
          // evaluateHypothesis never throws; a bad check becomes a "skipped"
          // verdict, so one failure cannot stall a lane or lose the rest.
          const result = await evaluateHypothesis(conn, h, schema, rowCounts);
          handlers.onResult?.(h.id, result);
        }
      } finally {
        await conn.close();
      }
    }),
  );
}
