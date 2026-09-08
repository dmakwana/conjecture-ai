import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestDb } from "./helpers/duckdb";
import { loadIntoDuckDB } from "@/lib/duckdb/load";
import { CSV_FIXTURE } from "./fixtures";

const encode = (s: string) => new TextEncoder().encode(s);

const SECOND_DATASET = `sku,price,in_stock
A-1,9.99,true
A-2,19.50,false
A-3,4.25,true
`;

describe("loading more than one dataset in a session", () => {
  it("loads a second file after the first has locked the database down", async () => {
    // Regression: enable_external_access=false is global and irreversible, so
    // reusing the database made every load after the first fail with
    // "file system operations are disabled by configuration". Switching
    // datasets is the normal way to use this tool, so it has to keep working.
    const dir = mkdtempSync(path.join(tmpdir(), "reload-"));
    writeFileSync(path.join(dir, "a.csv"), CSV_FIXTURE);

    const testDb = await createTestDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = testDb.db as any;

    const first = await loadIntoDuckDB(db, {
      bytes: encode(CSV_FIXTURE), format: "csv", label: "a.csv",
    });
    expect(first.rowCount).toBe(6);
    expect(first.externalAccessDisabled).toBe(true);

    // The load that used to throw.
    const second = await loadIntoDuckDB(db, {
      bytes: encode(SECOND_DATASET), format: "csv", label: "b.csv",
    });
    expect(second.rowCount).toBe(3);
    expect(second.columns.map((c) => c.name)).toEqual(["sku", "price", "in_stock"]);

    // And a third, to be sure it is not a one-shot recovery.
    const third = await loadIntoDuckDB(db, {
      bytes: encode(CSV_FIXTURE), format: "csv", label: "c.csv",
    });
    expect(third.rowCount).toBe(6);
  }, 180_000);

  it("re-locks the database on every load, not just the first", async () => {
    // Re-opening restores external access, so the lockdown must be re-applied
    // each time or the second dataset would be evaluated unprotected.
    const testDb = await createTestDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = testDb.db as any;

    await loadIntoDuckDB(db, { bytes: encode(CSV_FIXTURE), format: "csv", label: "a" });
    const second = await loadIntoDuckDB(db, {
      bytes: encode(SECOND_DATASET), format: "csv", label: "b",
    });
    expect(second.externalAccessDisabled).toBe(true);

    const conn = await testDb.connect();
    await expect(
      conn.query(`SELECT count(*) FROM read_csv_auto('https://example.com/x.csv')`),
    ).rejects.toThrow();
    conn.close();
  }, 180_000);

  it("leaves no rows of the previous dataset behind", async () => {
    const testDb = await createTestDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = testDb.db as any;

    await loadIntoDuckDB(db, { bytes: encode(CSV_FIXTURE), format: "csv", label: "a" });
    await loadIntoDuckDB(db, { bytes: encode(SECOND_DATASET), format: "csv", label: "b" });

    const conn = await testDb.connect();
    const cols = (await conn.query(`DESCRIBE data`)).toArray().map(
      (r) => (r.toJSON() as { column_name: string }).column_name,
    );
    expect(cols).toEqual(["sku", "price", "in_stock"]);
    expect(cols).not.toContain("email");
    conn.close();
  }, 180_000);
});
