import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, type TestConn } from "./helpers/duckdb";
import { loadIntoDuckDB, type LoadedTable } from "@/lib/duckdb/load";
import { profileTable } from "@/lib/profile/profile";
import { evaluateHypothesis } from "@/lib/hypotheses/evaluate";
import type { TableProfile } from "@/lib/profile/types";
import type { Hypothesis } from "@/lib/hypotheses/schema";

/**
 * End-to-end against a real remote Parquet file, using the same loader and
 * profiler the browser runs. Skips itself if the network is unavailable rather
 * than failing the suite offline.
 */
const PARQUET_URL = "https://shell.duckdb.org/data/tpch/0_01/parquet/lineitem.parquet";

let conn: TestConn;
let loaded: LoadedTable;
let profile: TableProfile;
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
  loaded = await loadIntoDuckDB(testDb.db as any, {
    bytes,
    format: "parquet",
    label: "lineitem.parquet",
  });
  // After the load, because loadIntoDuckDB re-opens the database.
  conn = await testDb.connect();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  profile = await profileTable(conn as any, loaded);
}, 300_000);

afterAll(() => conn?.close());

describe("real Parquet end to end", () => {
  it("loads the TPC-H lineitem table", () => {
    if (!available) return;
    expect(loaded.rowCount).toBeGreaterThan(50_000);
    expect(loaded.columns.map((c) => c.name)).toContain("l_orderkey");
    expect(loaded.format).toBe("parquet");
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
    expect(profile.columns).toHaveLength(loaded.columns.length);

    const quantity = profile.columns.find((c) => c.name === "l_quantity");
    expect(quantity?.class).toBe("numeric");
    expect(quantity?.numeric?.min).toBeGreaterThan(0);
    expect(quantity?.numeric?.max).toBeLessThanOrEqual(50);

    const shipdate = profile.columns.find((c) => c.name === "l_shipdate");
    expect(shipdate?.class).toBe("temporal");
    expect(shipdate?.temporal?.minISO).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(shipdate?.temporal?.spanDays).toBeGreaterThan(0);

    // Every percentage must be a real percentage, not a silently-zero Decimal128.
    for (const col of profile.columns) {
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
    const columns = loaded.columns.map((c) => c.name);
    const h = (check: Hypothesis["check"]): Hypothesis => ({
      id: "h", title: "t", rationale: "r", columns: [], severity: "medium", check,
    });

    // True of TPC-H by construction.
    const holds = await evaluateHypothesis(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      conn as any, h({ kind: "row_predicate", expression: "l_discount BETWEEN 0 AND 1" }),
      columns, loaded.rowCount,
    );
    expect(holds.status).toBe("holds");

    // False: l_orderkey repeats across line items.
    const falsified = await evaluateHypothesis(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      conn as any, h({ kind: "unique", columns: ["l_orderkey"] }), columns, loaded.rowCount,
    );
    expect(falsified.status).toBe("falsified");
    if (falsified.status !== "falsified") throw new Error("unreachable");
    expect(falsified.violations).toBeGreaterThan(0);
    expect(falsified.pct).toBeGreaterThan(0);
  }, 120_000);
});
