import type * as duckdb from "@duckdb/duckdb-wasm";
import { asNumber, columnNames, firstRow } from "@/lib/arrow";
import { TABLE } from "@/lib/duckdb/load";
import { guardColumns, guardExpression, quoteIdent } from "./guard";
import type { Hypothesis, HypothesisResult } from "./schema";

/** Rows shown when inspecting a falsified hypothesis. Never leaves the browser. */
export const VIOLATION_PREVIEW_LIMIT = 200;

function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // DuckDB errors carry a long "LINE 1: ..." tail that is noise in the UI.
  return raw.split("\n")[0].replace(/^(Binder|Catalog|Parser|Conversion) Error:\s*/, "").trim();
}

/**
 * Build the counting query for a hypothesis.
 *
 * The FROM clause is always ours and the result is always a single count, so a
 * generated check cannot reshape the query into something that returns data.
 * A NULL predicate counts as passing: absence of a value is not evidence that
 * the claim is false, and hypotheses that care about nulls say so explicitly.
 */
export function violationCountQuery(h: Hypothesis, knownColumns: string[]): string {
  if (h.check.kind === "row_predicate") {
    const guarded = guardExpression(h.check.expression);
    if (!guarded.ok) throw new Error(guarded.reason);
    return `SELECT count(*) AS violations FROM ${TABLE} WHERE NOT coalesce((${guarded.expression}), true)`;
  }

  const guarded = guardColumns(h.check.columns, knownColumns);
  if (!guarded.ok) throw new Error(guarded.reason);
  const cols = guarded.columns.map(quoteIdent).join(", ");
  return (
    `SELECT CAST(coalesce(sum(n), 0) AS BIGINT) AS violations FROM (` +
    `SELECT count(*) AS n FROM ${TABLE} GROUP BY ${cols} HAVING count(*) > 1)`
  );
}

export function violationRowsQuery(h: Hypothesis, knownColumns: string[]): string {
  if (h.check.kind === "row_predicate") {
    const guarded = guardExpression(h.check.expression);
    if (!guarded.ok) throw new Error(guarded.reason);
    return `SELECT * FROM ${TABLE} WHERE NOT coalesce((${guarded.expression}), true) LIMIT ${VIOLATION_PREVIEW_LIMIT}`;
  }

  const guarded = guardColumns(h.check.columns, knownColumns);
  if (!guarded.ok) throw new Error(guarded.reason);
  const cols = guarded.columns.map(quoteIdent).join(", ");
  return `SELECT * FROM ${TABLE} QUALIFY count(*) OVER (PARTITION BY ${cols}) > 1 LIMIT ${VIOLATION_PREVIEW_LIMIT}`;
}

export async function evaluateHypothesis(
  conn: duckdb.AsyncDuckDBConnection,
  h: Hypothesis,
  knownColumns: string[],
  rowCount: number,
): Promise<HypothesisResult> {
  let sql: string;
  try {
    sql = violationCountQuery(h, knownColumns);
  } catch (err) {
    return { status: "skipped", reason: errorMessage(err) };
  }

  const started = performance.now();
  try {
    const row = firstRow<{ violations: unknown }>(await conn.query(sql));
    const violations = asNumber(row?.violations) ?? 0;
    const ms = Math.round(performance.now() - started);

    if (violations === 0) return { status: "holds", violations: 0, rowCount, ms };
    return {
      status: "falsified",
      violations,
      rowCount,
      pct: rowCount === 0 ? 0 : (violations / rowCount) * 100,
      ms,
    };
  } catch (err) {
    // An invalid expression (unknown column, type mismatch) lands here. That is
    // information, not a failure: show it rather than dropping the hypothesis.
    return { status: "skipped", reason: errorMessage(err) };
  }
}

export interface ViolationPreview {
  columns: string[];
  rows: unknown[][];
}

export async function fetchViolationRows(
  conn: duckdb.AsyncDuckDBConnection,
  h: Hypothesis,
  knownColumns: string[],
): Promise<ViolationPreview> {
  const table = await conn.query(violationRowsQuery(h, knownColumns));
  const cols = columnNames(table);
  const { toJs } = await import("@/lib/arrow");
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
 * true CPU parallelism — DuckDB still executes one query at a time. What it does
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

/**
 * Evaluate every hypothesis, reporting each verdict as it lands so the UI can
 * fill in incrementally instead of waiting for the slowest check.
 */
export async function evaluateAllHypotheses(
  db: duckdb.AsyncDuckDB,
  hypotheses: Hypothesis[],
  knownColumns: string[],
  rowCount: number,
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
          const result = await evaluateHypothesis(conn, h, knownColumns, rowCount);
          handlers.onResult?.(h.id, result);
        }
      } finally {
        await conn.close();
      }
    }),
  );
}
