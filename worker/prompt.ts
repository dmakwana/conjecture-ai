import type { DatabaseProfile } from "@/lib/profile/types";
import type { PriorRound } from "@/lib/hypotheses/findings";

/** Round 1 plus at most two follow-ups. */
export const MAX_ROUNDS = 3;

export const SYSTEM_PROMPT = `You are a data quality analyst. You are given statistical profiles of one or more tables and you propose falsifiable hypotheses about them.

You never see the data. You see only structural statistics: row and null counts, distinct-value estimates, numeric ranges and quantiles, date ranges, string length and character-class distributions, and masked format shapes in which every letter is written as "a" or "A" and every digit as "9" (so "ana@acme.io" appears as "aaa@aaaa.aa", and "a{7}9{4}" means seven letters followed by four digits). Reason from those statistics. Never ask for values.

A good hypothesis is:

1. FALSIFIABLE — a precise claim that a single SQL check can prove false.
2. NOT ALREADY ANSWERED BY THE PROFILE. This matters most. The profile already tells you every column's null count, distinct count, and numeric range, so claiming "customer_id is never null" when the profile shows zero nulls is worthless. Spend your hypotheses on what the profile CANNOT see:
   - relationships between columns (ship_date >= order_date; total = quantity * price; discount only non-zero when promo_code is set)
   - conditional rules (when status = 'settled' then amount > 0)
   - which rows carry a minority format shape, when the shape histogram shows more than one shape
   - uniqueness of column COMBINATIONS, which per-column distinct counts cannot reveal
   - sentinel and placeholder values hiding inside a valid range (0, -1, 9999, 1970-01-01, an empty string standing in for NULL)
   - business-plausible bounds the profile's min/max sit suspiciously close to
3. SPECIFIC — named columns, concrete thresholds, no vague "data should be clean" statements.
4. WORTH BEING WRONG ABOUT — prefer claims where a violation would matter, and set severity accordingly.

Ground every rationale in a statistic you were actually given, and name it.

WHEN THERE IS MORE THAN ONE TABLE

Relationships BETWEEN tables are the highest-value hypotheses available to you, because nothing in a single-table profile can reveal them. Look for them first:

  - Columns sharing a name, or a name-and-type, across tables are candidate keys and foreign keys. Similar distinct counts and overlapping ranges support the guess.
  - A column whose distinct count in one table is close to the row count of another is very likely a reference to it.
  - Check BOTH directions, and say which you mean: every order line pointing at a real order is a different claim from every order having at least one line, and both are worth testing.

Use kind = "references" for these. It asserts that every non-NULL value of \`table\`.\`columns\` also appears in \`referencesTable\`.\`referencesColumns\`. Rows where the value is NULL are skipped, as with a normal foreign key. Reverse the two tables to test the other direction.

Do not invent a table or column name. Use only the names listed for you.

WRITING THE CHECK

Every check names the \`table\` it runs against, exactly as given in the profile.

For kind = "row_predicate", write a DuckDB boolean expression that must be TRUE for every row of that one table. It is inserted into a query we build, so write only the expression:

  - Refer to columns by bare name. Quote a name with double quotes when it is not a plain lowercase identifier: "Order Date".
  - A row predicate covers ONE table. It cannot reference another table; use "references" for that.
  - NULL is treated as passing, so you do not need to guard for it. Add an explicit IS NOT NULL test only when absence itself is the violation.
  - Allowed: comparisons, AND/OR/NOT, arithmetic, CASE, IN, BETWEEN, LIKE, regexp_matches, and scalar functions such as length, trim, lower, upper, abs, round, coalesce, date_diff, date_part, strftime, try_cast.
  - FORBIDDEN, and rejected before execution: SELECT, subqueries, FROM, JOIN, semicolons, comments, and any function that reads a file or URL (read_csv, read_parquet, glob, and similar). A row predicate never needs any of these.
  - Set expression to "" for other kinds.

For kind = "unique", list the columns that together should have no duplicates in \`columns\`. Use it for combinations; a single-column uniqueness claim is only worth making when the profile's distinct count is close to, but not equal to, the non-null count.

For kind = "references", set \`columns\` and \`referencesColumns\` to the same number of columns, in matching order.

Propose between 8 and 16 hypotheses, ordered with the most valuable first. Fewer good ones beat many obvious ones. When several tables are loaded, spend a real share of them on cross-table relationships.

THIS IS ROUND 1 OF UP TO ${MAX_ROUNDS}

Every hypothesis you propose will be run against the data, and you may then be given the verdicts — holds, falsified with a violation count, or not run — and asked what follows. Nothing else comes back: no rows, no values, only counts and percentages.

Write round 1 knowing that. Concretely:

  - Include a few DIAGNOSTIC hypotheses chosen because either answer teaches you something, not because you expect them to fail. If a column might be a key, or two tables might be related, testing it cheaply now tells you where to dig later.
  - Do not try to cram every variation into round 1. One clean claim per idea beats five near-duplicates; if it fails you can narrow it next round.
  - Prefer a broad claim over a narrow one when both are plausible. A broad claim that fails localises the problem for you; a narrow one that passes tells you almost nothing.`;

/**
 * The profile is already metadata-only (see lib/profile/redaction.ts). This just
 * frames it, and states the table and column names explicitly so the model
 * cannot invent one.
 */
export function buildUserMessage(profile: DatabaseProfile): string {
  const inventory = profile.tables
    .map((t) => {
      const cols = t.columns.map((c) => `${c.name} (${c.sqlType})`).join(", ");
      return `- ${t.table} — ${t.rowCount.toLocaleString()} rows, ${t.columnCount} columns\n    ${cols}`;
    })
    .join("\n");

  const plural = profile.tables.length === 1 ? "table" : "tables";

  return [
    `${profile.tables.length} ${plural} loaded.`,
    ``,
    `The only table and column names that exist, and the only ones you may reference:`,
    inventory,
    ``,
    `Full profile:`,
    "```json",
    JSON.stringify(profile, null, 1),
    "```",
    ``,
    profile.tables.length > 1
      ? `Propose falsifiable hypotheses. Include cross-table relationships.`
      : `Propose falsifiable hypotheses about this table.`,
  ].join("\n");
}

/**
 * The follow-up message for round 2 and beyond.
 *
 * Carries the verdicts and nothing else — see lib/hypotheses/findings.ts, which
 * strips the engine's error prose because DuckDB embeds offending cell values
 * in it. Counts and percentages are the same class of aggregate the profile
 * already reports.
 */
export function buildFollowUpMessage(
  profile: DatabaseProfile,
  priorRounds: PriorRound[],
): string {
  const round = priorRounds.length + 1;

  const describe = (f: PriorRound["findings"][number]): string => {
    const check = f.check as { kind: string };
    if (f.outcome === "holds") return `HELD        ${f.title}  [${check.kind}]`;
    if (f.outcome === "not_run") return `NOT RUN     ${f.title}  — ${f.note ?? "unknown"}`;
    const pct = f.pct === null ? "" : ` (${f.pct.toFixed(2)}%)`;
    return `FALSIFIED   ${f.title}  — ${f.violations?.toLocaleString() ?? "?"} rows${pct}`;
  };

  const history = priorRounds
    .map((r) => `Round ${r.round}:\n${r.findings.map((f) => "  " + describe(f)).join("\n")}`)
    .join("\n\n");

  const falsified = priorRounds.flatMap((r) =>
    r.findings.filter((f) => f.outcome === "falsified"),
  );
  const notRun = priorRounds.flatMap((r) =>
    r.findings.filter((f) => f.outcome === "not_run"),
  );

  return [
    `This is round ${round} of up to ${MAX_ROUNDS}. Here is what happened to your earlier hypotheses.`,
    ``,
    history,
    ``,
    `The tables and columns are unchanged; the profile is repeated below for reference.`,
    ``,
    `Propose the hypotheses that NOW follow. What to do with each kind of result:`,
    ``,
    `  FALSIFIED — the interesting case. You know something is wrong but not what.`,
    `    Narrow it: is the breakage confined to one status, one country, one`,
    `    channel, one time window, one seller? Propose checks that would separate`,
    `    those explanations. A violation rate near 100% usually means the rule was`,
    `    wrong, not the data; a small rate usually means genuinely bad rows.`,
    ``,
    `  HELD — that avenue is clean, so do not re-test it. Ask what it implies. If`,
    `    a key held, combinations built on it are now worth testing. If a total`,
    `    reconciled, the inputs to that total are probably trustworthy and the`,
    `    problem is elsewhere.`,
    ``,
    `  NOT RUN — the check never executed. Fix it or drop it; do not resubmit it`,
    `    unchanged. The note says what went wrong.`,
    ``,
    falsified.length === 0
      ? `Nothing was falsified, so go deeper rather than wider: the easy invariants hold, and the remaining defects are in the relationships the first round did not reach.`
      : `Concentrate on explaining the ${falsified.length} falsified result${falsified.length === 1 ? "" : "s"}.`,
    notRun.length > 0
      ? `${notRun.length} check${notRun.length === 1 ? "" : "s"} did not run; repair only the ones still worth asking.`
      : ``,
    ``,
    `Do not repeat a hypothesis that already ran. Propose between 6 and 12.`,
    ``,
    `Profile:`,
    "```json",
    JSON.stringify(profile, null, 1),
    "```",
  ]
    .filter((line) => line !== "")
    .join("\n");
}
