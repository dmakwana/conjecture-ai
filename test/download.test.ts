import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { verifyDownload } from "@/lib/sources/validate";
import { createTestDb } from "./helpers/duckdb";
import { rebuildDatabase } from "@/lib/duckdb/load";

const real = new Uint8Array(readFileSync("public/data/commerce/sellers.parquet"));

describe("verifyDownload", () => {
  it("accepts a complete Parquet file", () => {
    expect(verifyDownload(real, "parquet")).toBeNull();
  });

  it("catches the truncation that a cached 206 produces", () => {
    // The reported bug: a ranged probe leaves a 1 KB partial in the HTTP cache,
    // the full GET is served from it, and DuckDB reports a missing footer in a
    // buffer the user never named. Here it reads as what it is.
    const truncated = real.subarray(0, 1024);
    const problem = verifyDownload(truncated, "parquet");
    expect(problem).toMatch(/incomplete/i);
    expect(problem).toMatch(/cut short/i);
    // It still has a valid header, which is why sniffing called it Parquet.
    expect(problem).not.toMatch(/no PAR1 header/);
  });

  it("distinguishes 'not Parquet at all' from 'Parquet but truncated'", () => {
    const notParquet = new TextEncoder().encode("id,name\n1,a\n");
    expect(verifyDownload(notParquet, "parquet")).toMatch(/no PAR1 header/);
  });

  it("rejects an empty download for any format", () => {
    for (const f of ["parquet", "csv", "json"] as const) {
      expect(verifyDownload(new Uint8Array(0), f)).toMatch(/empty/i);
    }
  });

  it("holds a download to the size the server advertised", () => {
    expect(verifyDownload(real, "parquet", real.byteLength)).toBeNull();
    expect(verifyDownload(real, "parquet", real.byteLength * 2)).toMatch(/stopped early/i);
  });

  it("does not second-guess CSV or JSON, which have no footer to check", () => {
    const csv = new TextEncoder().encode("id,name\n1,a\n");
    expect(verifyDownload(csv, "csv")).toBeNull();
    expect(verifyDownload(csv, "json")).toBeNull();
  });
});

describe("rebuildDatabase", () => {
  it("names the source and the problem instead of surfacing DuckDB's buffer error", async () => {
    const testDb = await createTestDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = testDb.db as any;

    await expect(
      rebuildDatabase(db, [
        { table: "lineitem", label: "lineitem.parquet", format: "parquet",
          bytes: real.subarray(0, 1024) },
      ]),
    ).rejects.toThrow(/lineitem\.parquet: .*incomplete/i);
  }, 180_000);

  it("still loads a complete file", async () => {
    const testDb = await createTestDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loaded = await rebuildDatabase(testDb.db as any, [
      { table: "sellers", label: "sellers.parquet", format: "parquet", bytes: real },
    ]);
    expect(loaded.tables[0].rowCount).toBe(900);
  }, 180_000);
});
