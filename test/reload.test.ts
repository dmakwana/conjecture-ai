import { describe, it, expect } from "vitest";
import { createTestDb } from "./helpers/duckdb";
import { rebuildDatabase } from "@/lib/duckdb/load";
import { encode } from "./helpers/load";
import { CSV_FIXTURE } from "./fixtures";

const SECOND_DATASET = `sku,price,in_stock
A-1,9.99,true
A-2,19.50,false
A-3,4.25,true
`;

const first = { table: "a", label: "a.csv", format: "csv" as const, bytes: encode(CSV_FIXTURE) };
const second = { table: "b", label: "b.csv", format: "csv" as const, bytes: encode(SECOND_DATASET) };

describe("rebuilding across loads", () => {
  it("loads again after the first rebuild locked the database down", async () => {
    // Regression: enable_external_access=false is global and irreversible, so
    // reusing the database made every load after the first fail with
    // "file system operations are disabled by configuration".
    const testDb = await createTestDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = testDb.db as any;

    const one = await rebuildDatabase(db, [first]);
    expect(one.tables[0].rowCount).toBe(6);
    expect(one.externalAccessDisabled).toBe(true);

    const two = await rebuildDatabase(db, [first, second]);
    expect(two.tables.map((t) => t.table)).toEqual(["a", "b"]);
    expect(two.tables[1].rowCount).toBe(3);

    const three = await rebuildDatabase(db, [second]);
    expect(three.tables.map((t) => t.table)).toEqual(["b"]);
  }, 180_000);

  it("re-locks the database on every rebuild, not just the first", async () => {
    const testDb = await createTestDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = testDb.db as any;

    await rebuildDatabase(db, [first]);
    const again = await rebuildDatabase(db, [first, second]);
    expect(again.externalAccessDisabled).toBe(true);

    const conn = await testDb.connect();
    await expect(
      conn.query(`SELECT count(*) FROM read_csv_auto('https://example.com/x.csv')`),
    ).rejects.toThrow();
    conn.close();
  }, 180_000);

  it("leaves no table behind when a source is removed", async () => {
    const testDb = await createTestDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = testDb.db as any;

    await rebuildDatabase(db, [first, second]);
    await rebuildDatabase(db, [second]);

    const conn = await testDb.connect();
    const names = (await conn.query(`SELECT table_name FROM information_schema.tables`))
      .toArray()
      .map((r) => (r.toJSON() as { table_name: string }).table_name);
    expect(names).toContain("b");
    expect(names).not.toContain("a");
    conn.close();
  }, 180_000);
});
