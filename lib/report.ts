import type { DatabaseProfile } from "@/lib/profile/types";
import type { LoadedDatabase } from "@/lib/duckdb/load";
import type { Hypothesis, HypothesisResult } from "@/lib/hypotheses/schema";
import { isCrossTable, tablesInCheck } from "@/lib/hypotheses/schema";
import { formatBytes } from "@/lib/sources/validate";

export interface ReportRow {
  round: number;
  hypothesis: Hypothesis;
  result: HypothesisResult | null;
}

export interface ReportInput {
  profile: DatabaseProfile;
  loaded: LoadedDatabase;
  rows: ReportRow[];
  generatedAt?: Date;
  /** Credit for a bundled dataset. A report is the thing most likely to be
   *  passed around, so the attribution has to travel with it. */
  attribution?: { text: string; href: string } | null;
}

const VERDICT: Record<string, string> = {
  holds: "✓ HOLDS",
  falsified: "✗ FALSIFIED",
  skipped: "○ NOT RUN",
};

function checkText(h: Hypothesis): string {
  const c = h.check;
  if (c.kind === "unique") return `UNIQUE (${c.columns.join(", ")}) in ${c.table}`;
  if (c.kind === "references") {
    return `${c.table}(${c.columns.join(", ")}) → ${c.referencesTable}(${c.referencesColumns.join(", ")})`;
  }
  return c.expression;
}

function stamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Safe, sortable filename for the downloaded report. */
export function reportFilename(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `duck-invariant-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.md`;
}

/**
 * Render everything on the page as a standalone Markdown report.
 *
 * Deliberately self-contained: a downloaded file outlives the tab, which is the
 * only durable record of a run, since nothing here is persisted anywhere else.
 * It carries the local results in full, with violating-row previews excluded, since
 * those are the one thing that was never meant to travel.
 */
export function buildMarkdownReport(input: ReportInput): string {
  const { profile, loaded, rows, attribution } = input;
  const generatedAt = input.generatedAt ?? new Date();

  const done = rows.filter((r) => r.result !== null);
  const falsified = done.filter((r) => r.result?.status === "falsified");
  const held = done.filter((r) => r.result?.status === "holds");
  const notRun = done.filter((r) => r.result?.status === "skipped");
  const sqlMs = done.reduce(
    (n, r) => n + (r.result && "ms" in r.result ? r.result.ms : 0),
    0,
  );
  const roundNumbers = [...new Set(rows.map((r) => r.round))].sort((a, b) => a - b);

  const out: string[] = [];

  out.push(`# duck-invariant report`);
  out.push("");
  out.push(
    `Generated ${stamp(generatedAt)}. Every check ran locally in the browser.`,
  );
  out.push("");

  /* ---------------------------------------------------------------- data */
  out.push(`## Data`);
  out.push("");
  out.push(`| table | source | rows | columns | size |`);
  out.push(`| --- | --- | ---: | ---: | ---: |`);
  for (const t of loaded.tables) {
    out.push(
      `| \`${t.table}\` | ${t.label} | ${t.rowCount.toLocaleString()} | ${t.columns.length} | ${formatBytes(t.bytes)} |`,
    );
  }
  out.push("");

  if (attribution) {
    out.push(`Source: ${attribution.text} <${attribution.href}>`);
    out.push("");
  }

  /* ------------------------------------------------------------- summary */
  out.push(`## Summary`);
  out.push("");
  out.push(
    `- ${roundNumbers.length} round${roundNumbers.length === 1 ? "" : "s"}, ${rows.length} hypotheses`,
  );
  out.push(
    `- **${falsified.length} falsified**, ${held.length} held${notRun.length > 0 ? `, ${notRun.length} not run` : ""}`,
  );
  out.push(`- ${sqlMs.toLocaleString()} ms of SQL across ${done.length} checks`);
  out.push("");

  if (falsified.length > 0) {
    out.push(`### What was falsified`);
    out.push("");
    out.push(`| round | hypothesis | violations | of | share |`);
    out.push(`| ---: | --- | ---: | ---: | ---: |`);
    for (const r of falsified) {
      const res = r.result!;
      if (res.status !== "falsified") continue;
      out.push(
        `| ${r.round} | ${r.hypothesis.title} | ${res.violations.toLocaleString()} | ${res.rowCount.toLocaleString()} | ${res.pct.toFixed(2)}% |`,
      );
    }
    out.push("");
  }

  /* -------------------------------------------------------------- rounds */
  for (const round of roundNumbers) {
    const inRound = rows.filter((r) => r.round === round);
    out.push(
      `## Round ${round}: ${round === 1 ? "from the profile" : "informed by earlier results"}`,
    );
    out.push("");

    for (const { hypothesis, result } of inRound) {
      const verdict = result === null ? "· not tested" : VERDICT[result.status];
      out.push(`### ${verdict}: ${hypothesis.title}`);
      out.push("");

      const tags = [
        `severity **${hypothesis.severity}**`,
        isCrossTable(hypothesis.check) ? "cross-table" : null,
        tablesInCheck(hypothesis.check).map((t) => `\`${t}\``).join(" · "),
      ].filter(Boolean);
      out.push(`${tags.join(" · ")}`);
      out.push("");

      if (result?.status === "falsified") {
        out.push(
          `**${result.violations.toLocaleString()} of ${result.rowCount.toLocaleString()} rows (${result.pct.toFixed(2)}%)** · ${result.ms} ms`,
        );
      } else if (result?.status === "holds") {
        out.push(`No violations in ${result.rowCount.toLocaleString()} rows · ${result.ms} ms`);
      } else if (result?.status === "skipped") {
        out.push(`Could not be evaluated: ${result.reason}`);
      }
      out.push("");

      out.push(`${hypothesis.rationale}`);
      out.push("");
      out.push(`\`\`\``);
      out.push(checkText(hypothesis));
      out.push(`\`\`\``);
      out.push("");

      if (result?.sql) {
        out.push(`<details><summary>SQL</summary>`);
        out.push("");
        out.push("```sql");
        out.push(result.sql);
        out.push("```");
        out.push("");
        out.push(`</details>`);
        out.push("");
      }
    }
  }

  /* ------------------------------------------------------------- privacy */
  out.push(`## What left the browser`);
  out.push("");
  out.push(
    `Only a statistical profile of ${profile.tables.length} table${profile.tables.length === 1 ? "" : "s"}: ` +
      `column names and types, counts, percentages, numeric and date ranges, string length and ` +
      `character-class distributions, and masked format shapes in which every letter is \`a\`/\`A\` ` +
      `and every digit \`9\`. On later rounds, the pass/fail counts above were included as well.`,
  );
  out.push("");
  out.push(
    `No cell values, no rows, and no generated SQL were transmitted. Every query in this report ` +
      `ran against a local in-browser DuckDB.`,
  );
  out.push("");

  return out.join("\n");
}
