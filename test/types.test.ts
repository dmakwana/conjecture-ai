import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, type TestConn } from "./helpers/duckdb";
import { evaluateHypothesis, typeFamily, type Schema } from "@/lib/hypotheses/evaluate";
import type { Check, Hypothesis } from "@/lib/hypotheses/schema";
import { sanitizeNote, knownIdentifiers } from "@/lib/hypotheses/findings";
import { loadSources, encode } from "./helpers/load";

// The same logical key typed differently in two files, which is what CSV
// auto-detection does the moment one side is zero-padded or has a non-numeric id.
const PARENT = `order_id,total\n1,10\n2,20\n3,30\n`;
const CHILD = `line_id,order_id\n1,0001\n2,0002\n3,0009\n`;

let conn: TestConn;
let schema: Schema;
let rowCounts: Map<string, number>;

const evaluate = (check: Check) =>
  evaluateHypothesis(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    conn as any,
    { id: "h", title: "t", rationale: "r", severity: "high", check } as Hypothesis,
    schema, rowCounts,
  );

beforeAll(async () => {
  const testDb = await createTestDb();
  const r = await loadSources(testDb.db, [
    { table: "orders", label: "o.csv", format: "csv", bytes: encode(PARENT) },
    { table: "lines", label: "l.csv", format: "csv", bytes: encode(CHILD) },
  ]);
  schema = r.schema;
  rowCounts = r.rowCounts;
  conn = await testDb.connect();
}, 180_000);

afterAll(() => conn?.close());

describe("typeFamily", () => {
  it("groups types that can be compared meaningfully", () => {
    expect(typeFamily("BIGINT")).toBe("numeric");
    expect(typeFamily("DECIMAL(10,2)")).toBe("numeric");
    expect(typeFamily("VARCHAR")).toBe("text");
    expect(typeFamily("TIMESTAMP_NS")).toBe("temporal");
    expect(typeFamily("DATE")).toBe("temporal");
    expect(typeFamily("BOOLEAN")).toBe("boolean");
    expect(typeFamily("BIGINT")).not.toBe(typeFamily("VARCHAR"));
  });
});

describe("cross-type references", () => {
  it("refuses rather than returning a silently coerced count", async () => {
    // Regression: DuckDB coerces '0001' to 1 and matches it, so this reported
    // ONE violation when the literal truth is three. A quiet wrong answer is
    // worse than no answer, especially from a tool whose job is finding these.
    const r = await evaluate({
      kind: "references", table: "lines", columns: ["order_id"],
      referencesTable: "orders", referencesColumns: ["order_id"],
    });
    expect(r.status).toBe("skipped");
    if (r.status !== "skipped") throw new Error("unreachable");
    expect(r.reason).toMatch(/types differ/i);
    // Both types are named so the user can act on it; type names are already
    // exposed in the profile, so this adds no new disclosure.
    expect(r.reason).toMatch(/BIGINT/);
    expect(r.reason).toMatch(/VARCHAR/);
  });

  it("never lets DuckDB's value-embedding conversion error escape", async () => {
    // The unguarded query produced:
    //   Could not convert string 'X-9' to INT64 ...
    // which would have carried a cell value into the next round's prompt.
    const r = await evaluate({
      kind: "references", table: "lines", columns: ["order_id"],
      referencesTable: "orders", referencesColumns: ["order_id"],
    });
    if (r.status !== "skipped") throw new Error("expected skip");
    expect(r.reason).not.toMatch(/could not convert/i);
    expect(r.reason).not.toMatch(/['"]/);
  });

  it("still allows a reference whose types match", async () => {
    const r = await evaluate({
      kind: "references", table: "lines", columns: ["line_id"],
      referencesTable: "orders", referencesColumns: ["order_id"],
    });
    expect(r.status).not.toBe("skipped");
  });

  it("classifies the refusal usefully for the next round", () => {
    const known = knownIdentifiers([
      { table: "lines", columns: [{ name: "order_id" }] },
      { table: "orders", columns: [{ name: "order_id" }] },
    ]);
    const note = sanitizeNote(
      "Cannot compare lines.order_id (VARCHAR) with orders.order_id (BIGINT): types differ.",
      known,
    );
    expect(note).toMatch(/types differ/);
    expect(note).not.toMatch(/['"]/);
  });
});

describe("row predicates across types", () => {
  it("fails with a binder error that carries no cell value", async () => {
    // The model's own doing rather than ours, and DuckDB refuses it cleanly:
    // it names the two types, not an offending value.
    const r = await evaluate({
      kind: "row_predicate", table: "lines", expression: "order_id > 0",
    });
    expect(r.status).toBe("skipped");
    if (r.status !== "skipped") throw new Error("unreachable");
    expect(r.reason).toMatch(/cannot compare/i);
    expect(r.reason).not.toMatch(/0001|0009/);
  });

  it("works when the model uses try_cast, as the prompt instructs", async () => {
    const r = await evaluate({
      kind: "row_predicate", table: "lines",
      expression: "try_cast(order_id AS BIGINT) > 0",
    });
    expect(r.status).toBe("holds");
  });
});
