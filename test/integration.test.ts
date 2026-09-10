import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, type TestConn } from "./helpers/duckdb";
import { rebuildDatabase, type LoadedDatabase } from "@/lib/duckdb/load";
import { profileDatabase } from "@/lib/profile/profile";
import { evaluateHypothesis, schemaFrom } from "@/lib/hypotheses/evaluate";
import type { DatabaseProfile } from "@/lib/profile/types";
import type { Check, Hypothesis } from "@/lib/hypotheses/schema";

/**
 * End-to-end against a real remote Parquet file, using the same loader and
 * profiler the browser runs. Skips itself if the network is unavailable rather
 * than failing the suite offline.
 */
const PARQUET_URL = "https://shell.duckdb.org/data/tpch/0_01/parquet/lineitem.parquet";

let conn: TestConn;
let loaded: LoadedDatabase;
let profile: DatabaseProfile;
let available = true;

beforeAll(async () => {
  let bytes: Uint8Array;
  try {
    const res = await fetch(PARQUET_URL);
    if (!res.ok) throw new Error(String(res.status));
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch {
    available = false;
    return;
  }

  const testDb = await createTestDb();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  loaded = await rebuildDatabase(testDb.db as any, [
    { table: "lineitem", label: "lineitem.parquet", format: "parquet", bytes },
  ]);
  // After the load, because rebuildDatabase re-opens the database.
  conn = await testDb.connect();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  profile = await profileDatabase(conn as any, loaded);
}, 300_000);

afterAll(() => conn?.close());

describe("real Parquet end to end", () => {
  it("loads the TPC-H lineitem table", () => {
    if (!available) return;
    expect(loaded.tables).toHaveLength(1);
    expect(loaded.tables[0].rowCount).toBeGreaterThan(50_000);
    expect(loaded.tables[0].columns.map((c) => c.name)).toContain("l_orderkey");
    expect(loaded.tables[0].format).toBe("parquet");
  });

  it("disables external access after loading", () => {
    if (!available) return;
    // Defence in depth behind the expression guard. If this ever stops working
    // the UI says so, but it should work.
    expect(loaded.externalAccessDisabled).toBe(true);
  });

  it("actually blocks a remote read once locked down", async () => {
    if (!available) return;
    // The proof that the lockdown is real, not just an accepted SET statement.
    await expect(
      conn.query(`SELECT count(*) FROM read_csv_auto('${PARQUET_URL}')`),
    ).rejects.toThrow();
  });

  it("profiles every column with sane statistics", () => {
    if (!available) return;
    const table = profile.tables[0];
    expect(table.columns).toHaveLength(loaded.tables[0].columns.length);

    const quantity = table.columns.find((c) => c.name === "l_quantity");
    expect(quantity?.class).toBe("numeric");
    expect(quantity?.numeric?.min).toBeGreaterThan(0);
    expect(quantity?.numeric?.max).toBeLessThanOrEqual(50);

    const shipdate = table.columns.find((c) => c.name === "l_shipdate");
    expect(shipdate?.class).toBe("temporal");
    expect(shipdate?.temporal?.minISO).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(shipdate?.temporal?.spanDays).toBeGreaterThan(0);

    // Every percentage must be a real percentage, not a silently-zero Decimal128.
    for (const col of table.columns) {
      if (!col.string) continue;
      const cc = col.string.charClassPct;
      expect(cc.alpha + cc.digit + cc.space + cc.punct + cc.other).toBeCloseTo(100, 0);
    }
  });

  it("keeps the outgoing payload free of cell values", () => {
    if (!available) return;
    const serialized = JSON.stringify(profile);
    // TPC-H ships known literal values in these columns; none may appear.
    for (const literal of ["DELIVER IN PERSON", "TRUCK", "MAIL", "Brand#", "AIR REG"]) {
      expect(serialized, `leaked ${literal}`).not.toContain(literal);
    }
  });

  it("evaluates hypotheses against the real table", async () => {
    if (!available) return;
    const schema = schemaFrom(loaded.tables);
    const rowCounts = new Map(loaded.tables.map((t) => [t.table, t.rowCount]));
    const h = (check: Check): Hypothesis => ({
      id: "h", title: "t", rationale: "r", severity: "medium", check,
    });

    // True of TPC-H by construction.
    const holds = await evaluateHypothesis(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      conn as any,
      h({ kind: "row_predicate", table: "lineitem", expression: "l_discount BETWEEN 0 AND 1" }),
      schema, rowCounts,
    );
    expect(holds.status).toBe("holds");

    // False: l_orderkey repeats across line items.
    const falsified = await evaluateHypothesis(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      conn as any, h({ kind: "unique", table: "lineitem", columns: ["l_orderkey"] }),
      schema, rowCounts,
    );
    expect(falsified.status).toBe("falsified");
    if (falsified.status !== "falsified") throw new Error("unreachable");
    expect(falsified.violations).toBeGreaterThan(0);
    expect(falsified.pct).toBeGreaterThan(0);
  }, 120_000);
});
