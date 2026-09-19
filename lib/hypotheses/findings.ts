import { z } from "zod";
import type { Check, Hypothesis, HypothesisResult } from "./schema";

/**
 * What a completed round reports back to the model so it can propose follow-ups.
 *
 * Feeding results back is a NEW route out of the browser, so it gets the same
 * treatment as the profile: numbers, names the model already knows, and nothing
 * else. Violation counts and percentages are aggregates of exactly the kind the
 * profile already carries (nullCount, distinctPct), so they add no new class of
 * exposure.
 *
 * The one genuine hazard is error text. DuckDB embeds the offending value in
 * its messages — "Could not convert string 'aaron.blake@acme.io' to DOUBLE" —
 * so a raw reason would hand over a cell value. sanitizeNote() exists for that
 * and is the reason this module is not three lines long.
 */

export const OUTCOMES = ["holds", "falsified", "not_run"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const FindingSchema = z.object({
  title: z.string(),
  check: z.unknown(),
  outcome: z.enum(OUTCOMES),
  violations: z.number().nullable(),
  pct: z.number().nullable(),
  rowCount: z.number().nullable(),
  note: z.string().nullable(),
});

export const PriorRoundSchema = z.object({
  round: z.number(),
  findings: z.array(FindingSchema),
});

export type PriorRound = z.infer<typeof PriorRoundSchema>;

export interface Finding {
  title: string;
  check: Check;
  outcome: Outcome;
  violations: number | null;
  pct: number | null;
  rowCount: number | null;
  note: string | null;
}

/** Longest a sanitised note may be. Anything longer is a sign of leakage. */
const MAX_NOTE_LENGTH = 120;

/**
 * Reduce an error message to a category plus identifiers the model already has.
 *
 * Deliberately destructive. The model needs to know *why* a check did not run
 * so it can avoid repeating the mistake; it does not need the engine's prose,
 * and the prose is where values hide. Anything that is not a recognised
 * category or a known table/column name is dropped.
 */
export function sanitizeNote(reason: string, knownIdentifiers: Set<string>): string {
  const lower = reason.toLowerCase();

  // Our own guard messages are generated from fixed templates over the model's
  // own expression, so their category is known precisely.
  let category: string;
  // Most specific first: the guard's generic "... is not allowed." tail would
  // otherwise swallow the separator and comment cases.
  if (/statement separator|comment or dollar-quote/.test(lower)) {
    category = "rejected by guard: separator or comment";
  } else if (/can read external data/.test(lower)) {
    category = "rejected by guard: file or URL access";
  } else if (/is not allowed in a row predicate|not allowed\.$/.test(lower)) {
    category = "rejected by guard: forbidden keyword or function";
  } else if (/unbalanced parentheses/.test(lower)) {
    category = "rejected by guard: unbalanced parentheses";
  } else if (/unknown table/.test(lower)) {
    category = "unknown table";
  } else if (/unknown column/.test(lower)) {
    category = "unknown column";
  } else if (/column count|column counts differ/.test(lower)) {
    category = "column counts differ";
  } else if (/referenced column|not found in from clause|binder/.test(lower)) {
    category = "unknown column";
  } else if (/does not exist|catalog error/.test(lower)) {
    category = "unknown table or function";
  } else if (/convert|cast|conversion|mismatch|type/.test(lower)) {
    category = "type mismatch";
  } else if (/syntax|parser/.test(lower)) {
    category = "syntax error";
  } else if (/no function matches|function with name/.test(lower)) {
    category = "unknown function";
  } else {
    category = "could not be evaluated";
  }

  // Echo only identifiers already exposed in the profile. Everything else —
  // including every quoted literal — is discarded.
  const mentioned = [
    ...new Set(
      (reason.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).filter((t) =>
        knownIdentifiers.has(t),
      ),
    ),
  ].slice(0, 4);

  const note = mentioned.length > 0 ? `${category} (${mentioned.join(", ")})` : category;
  return note.slice(0, MAX_NOTE_LENGTH);
}

/** Every table and column name, which the model already has from the profile. */
export function knownIdentifiers(
  tables: { table: string; columns: { name: string }[] }[],
): Set<string> {
  const out = new Set<string>();
  for (const t of tables) {
    out.add(t.table);
    for (const c of t.columns) out.add(c.name);
  }
  return out;
}

export function toFinding(
  hypothesis: Hypothesis,
  result: HypothesisResult,
  known: Set<string>,
): Finding {
  if (result.status === "skipped") {
    return {
      title: hypothesis.title,
      check: hypothesis.check,
      outcome: "not_run",
      violations: null,
      pct: null,
      rowCount: null,
      note: sanitizeNote(result.reason, known),
    };
  }
  return {
    title: hypothesis.title,
    check: hypothesis.check,
    outcome: result.status === "holds" ? "holds" : "falsified",
    violations: result.violations,
    pct: result.status === "falsified" ? result.pct : 0,
    rowCount: result.rowCount,
    note: null,
  };
}

export class FindingsLeakError extends Error {}

/**
 * The counterpart to assertNoValues() for the profile: nothing leaves without
 * passing this. Titles and checks are the model's own words echoed back, so the
 * only free text that could carry data is the note, and it must look sanitised.
 */
export function assertFindingsSafe(findings: Finding[]): Finding[] {
  for (const f of findings) {
    if (f.note === null) continue;
    if (f.note.length > MAX_NOTE_LENGTH) {
      throw new FindingsLeakError(`Note too long for "${f.title}".`);
    }
    // A sanitised note never contains a quote; DuckDB wraps offending values in
    // them, so their presence means raw engine text got through.
    if (/['"`]/.test(f.note)) {
      throw new FindingsLeakError(
        `Note for "${f.title}" contains quoted text: ${JSON.stringify(f.note)}`,
      );
    }
  }
  return findings;
}
