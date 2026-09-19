import { describe, it, expect } from "vitest";
import { buildMarkdownReport, reportFilename, type ReportRow } from "@/lib/report";
import type { DatabaseProfile } from "@/lib/profile/types";
import type { LoadedDatabase } from "@/lib/duckdb/load";

const loaded: LoadedDatabase = {
  tables: [
    { table: "orders", label: "orders.parquet", format: "parquet", rowCount: 40079,
      columns: [{ name: "order_id", sqlType: "VARCHAR" }, { name: "total", sqlType: "DOUBLE" }],
      bytes: 2_406_009 },
    { table: "customers", label: "customers.parquet", format: "parquet", rowCount: 22000,
      columns: [{ name: "customer_id", sqlType: "VARCHAR" }], bytes: 99_669 },
  ],
  externalAccessDisabled: true,
  loadMs: 529,
};

const profile: DatabaseProfile = {
  tables: loaded.tables.map((t) => ({
    table: t.table, label: t.label, format: "parquet" as const,
    rowCount: t.rowCount, columnCount: t.columns.length, profileMs: 10, columns: [],
  })),
  profileMs: 20,
};

const rows: ReportRow[] = [
  {
    round: 1,
    hypothesis: {
      id: "r1h1", title: "Every orders.customer_id exists in customers",
      rationale: "orders has 22,001 distinct customer_id but customers has 22,000.",
      severity: "high",
      check: { kind: "references", table: "orders", columns: ["customer_id"],
               referencesTable: "customers", referencesColumns: ["customer_id"] },
    },
    result: { status: "falsified", violations: 100, rowCount: 40079, pct: 0.2495, ms: 68,
              sql: "SELECT count(*) AS violations FROM orders AS child ..." },
  },
  {
    round: 1,
    hypothesis: {
      id: "r1h2", title: "total is never negative", rationale: "min is -3.25.",
      severity: "medium",
      check: { kind: "row_predicate", table: "orders", expression: "total >= 0" },
    },
    result: { status: "holds", violations: 0, rowCount: 40079, ms: 8, sql: "SELECT ..." },
  },
  {
    round: 2,
    hypothesis: {
      id: "r2h1", title: "customer_id always matches the shape A{3}-9{7}",
      rationale: "The 100 orphans may be malformed ids.", severity: "high",
      check: { kind: "row_predicate", table: "orders",
               expression: "regexp_matches(customer_id, '^[A-Z]{3}-[0-9]{7}$')" },
    },
    result: { status: "skipped", reason: "type mismatch (customer_id)" },
  },
];

const report = buildMarkdownReport({
  profile, loaded, rows, generatedAt: new Date("2026-09-19T14:30:00"),
});

describe("markdown report", () => {
  it("lists every loaded table with its shape", () => {
    expect(report).toContain("| `orders` | orders.parquet | 40,079 | 2 |");
    expect(report).toContain("| `customers` | customers.parquet | 22,000 | 1 |");
  });

  it("summarises the run the way the page does", () => {
    expect(report).toMatch(/2 rounds, 3 hypotheses/);
    expect(report).toMatch(/\*\*1 falsified\*\*, 1 held, 1 not run/);
    expect(report).toMatch(/76 ms of SQL across 3 checks/);
  });

  it("carries each verdict with its counts, share and duration", () => {
    expect(report).toContain("✗ FALSIFIED: Every orders.customer_id exists in customers");
    expect(report).toContain("**100 of 40,079 rows (0.25%)** · 68 ms");
    expect(report).toContain("✓ HOLDS: total is never negative");
    expect(report).toContain("No violations in 40,079 rows · 8 ms");
    expect(report).toContain("○ NOT RUN: customer_id always matches");
    expect(report).toContain("Could not be evaluated: type mismatch (customer_id)");
  });

  it("keeps rounds separate and labelled", () => {
    expect(report).toContain("## Round 1: from the profile");
    expect(report).toContain("## Round 2: informed by earlier results");
    expect(report.indexOf("## Round 1")).toBeLessThan(report.indexOf("## Round 2"));
  });

  it("shows the rationale, the check and the SQL behind it", () => {
    expect(report).toContain("orders has 22,001 distinct customer_id");
    expect(report).toContain("orders(customer_id) → customers(customer_id)");
    expect(report).toContain("<details><summary>SQL</summary>");
    expect(report).toContain("```sql");
  });

  it("marks cross-table checks and severities", () => {
    expect(report).toMatch(/severity \*\*high\*\* · cross-table · `orders` · `customers`/);
    expect(report).toMatch(/severity \*\*medium\*\* · `orders`/);
  });

  it("does not name the model", () => {
    expect(report.toLowerCase()).not.toContain("claude");
    expect(report.toLowerCase()).not.toContain("opus");
    expect(report.toLowerCase()).not.toContain("sonnet");
    expect(report.toLowerCase()).not.toContain("anthropic");
  });

  it("carries attribution when the data is one of ours", () => {
    // A report is the artifact most likely to be forwarded, so credit has to
    // travel with it rather than living only in the picker.
    const credited = buildMarkdownReport({
      profile, loaded, rows, generatedAt: new Date(),
      attribution: { text: "U.S. DOT, Bureau of Transportation Statistics.", href: "https://example.gov/x" },
    });
    expect(credited).toContain("Source: U.S. DOT, Bureau of Transportation Statistics.");
    expect(credited).toContain("<https://example.gov/x>");
  });

  it("omits attribution for data the user supplied", () => {
    // Their file, their call; guessing at a source would be worse than silence.
    expect(report).not.toContain("Source:");
  });

  it("states what actually left the browser", () => {
    expect(report).toContain("## What left the browser");
    expect(report).toMatch(/No cell values, no rows, and no generated SQL were transmitted/);
  });

  it("handles a run with no results yet", () => {
    const empty = buildMarkdownReport({ profile, loaded, rows: [], generatedAt: new Date() });
    expect(empty).toContain("duck-invariant report");
    expect(empty).toContain("0 rounds, 0 hypotheses");
    expect(empty).not.toContain("### What was falsified");
  });
});

describe("reportFilename", () => {
  it("is sortable and safe", () => {
    expect(reportFilename(new Date("2026-09-19T14:30:00"))).toBe(
      "duck-invariant-20260919-1430.md",
    );
    expect(reportFilename()).toMatch(/^duck-invariant-\d{8}-\d{4}\.md$/);
  });
});
