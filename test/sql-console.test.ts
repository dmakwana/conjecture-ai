import { describe, it, expect } from "vitest";
import {
  splitStatements, statementAt, stripSqlComments, isBlank,
} from "@/lib/sql/statements";
import { buildInitialSql } from "@/components/SqlConsole";
import type { LoadedDatabase } from "@/lib/duckdb/load";

const loaded: LoadedDatabase = {
  tables: [
    { table: "orders", label: "orders.parquet", format: "parquet", rowCount: 40079,
      columns: [{ name: "order_id", sqlType: "VARCHAR" }, { name: "total", sqlType: "DOUBLE" }],
      bytes: 1 },
    { table: "customers", label: "customers.parquet", format: "parquet", rowCount: 22000,
      columns: [{ name: "customer_id", sqlType: "VARCHAR" }], bytes: 1 },
  ],
  externalAccessDisabled: true,
  loadMs: 1,
};

describe("splitStatements", () => {
  it("splits on semicolons", () => {
    expect(splitStatements("SELECT 1; SELECT 2;").map((s) => s.sql))
      .toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("ignores semicolons inside string literals", () => {
    // Splitting naively here would produce two broken fragments.
    const out = splitStatements("SELECT 'a;b' AS x; SELECT 2");
    expect(out.map((s) => s.sql)).toEqual(["SELECT 'a;b' AS x", "SELECT 2"]);
  });

  it("handles doubled quotes inside literals and identifiers", () => {
    expect(splitStatements(`SELECT 'it''s; fine' AS x`).map((s) => s.sql))
      .toEqual([`SELECT 'it''s; fine' AS x`]);
    expect(splitStatements(`SELECT "we;ird" FROM t`).map((s) => s.sql))
      .toEqual([`SELECT "we;ird" FROM t`]);
  });

  it("ignores semicolons inside comments", () => {
    expect(splitStatements("-- a; b\nSELECT 1").map((s) => s.sql))
      .toEqual(["-- a; b\nSELECT 1"]);
    expect(splitStatements("/* a; b */ SELECT 1").map((s) => s.sql))
      .toEqual(["/* a; b */ SELECT 1"]);
  });

  it("ignores semicolons inside dollar-quoted blocks", () => {
    expect(splitStatements("SELECT $$a;b$$ AS x; SELECT 2").map((s) => s.sql))
      .toEqual(["SELECT $$a;b$$ AS x", "SELECT 2"]);
  });

  it("drops chunks that are only commentary", () => {
    // The console pre-fills the editor with commented-out queries, so this is
    // the difference between running something and running nothing.
    expect(splitStatements("-- just a note\n-- and another")).toEqual([]);
    expect(splitStatements("-- note\nSELECT 1;\n-- trailing").map((s) => s.sql))
      .toEqual(["-- note\nSELECT 1"]);
  });
});

describe("statementAt", () => {
  const doc = "SELECT 1;\nSELECT 2;\nSELECT 3";

  it("returns the statement under the cursor, not the whole buffer", () => {
    expect(statementAt(doc, 2)).toBe("SELECT 1");
    expect(statementAt(doc, 12)).toBe("SELECT 2");
    expect(statementAt(doc, doc.length)).toBe("SELECT 3");
  });

  it("falls back to the last statement when the cursor sits in trailing comments", () => {
    const withTail = "SELECT 1;\n-- nothing here";
    expect(statementAt(withTail, withTail.length)).toBe("SELECT 1");
  });

  it("returns null when there is nothing executable", () => {
    expect(statementAt("-- only a comment", 3)).toBeNull();
  });
});

describe("stripSqlComments", () => {
  it("keeps comment markers that live inside string literals", () => {
    expect(stripSqlComments("SELECT '-- not a comment'").trim())
      .toBe("SELECT '-- not a comment'");
    expect(isBlank("SELECT '-- x'")).toBe(false);
  });
});

describe("buildInitialSql", () => {
  const seeded = buildInitialSql(loaded, [
    { title: "total is never negative", sql: "SELECT count(*) AS violations FROM orders WHERE NOT coalesce((total >= 0), true)" },
  ]);

  it("lists the loaded tables and their columns", () => {
    expect(seeded).toContain("orders(order_id, total)");
    expect(seeded).toContain("customers(customer_id)");
  });

  it("includes the checks already run, commented out", () => {
    expect(seeded).toContain("-- total is never negative");
    expect(seeded).toContain("-- SELECT count(*) AS violations FROM orders");
  });

  it("leaves exactly one statement live, so Run does something predictable", () => {
    const live = splitStatements(seeded);
    expect(live).toHaveLength(1);
    expect(live[0].sql).toContain("SELECT * FROM orders LIMIT 100");
  });

  it("works before any checks have run", () => {
    const empty = buildInitialSql(loaded, []);
    expect(splitStatements(empty)).toHaveLength(1);
    expect(empty).not.toContain("Checks already run");
  });
});

describe("the seeded query against a real DuckDB", () => {
  it("runs, so Run works the moment the console opens", async () => {
    const { createTestDb } = await import("./helpers/duckdb");
    const { rebuildDatabase } = await import("@/lib/duckdb/load");
    const { readFileSync } = await import("node:fs");

    const testDb = await createTestDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const real = await rebuildDatabase(testDb.db as any, [
      { table: "cars", label: "cars.json", format: "json",
        bytes: new Uint8Array(readFileSync("public/data/cars/cars.json")) },
    ]);

    const statements = splitStatements(buildInitialSql(real, []));
    expect(statements).toHaveLength(1);

    const conn = await testDb.connect();
    const result = await conn.query(statements[0].sql);
    expect(result.numRows).toBe(100);
    conn.close();
  }, 180_000);
});

describe("result paging", () => {
  it("shows a page at a time rather than the whole result", async () => {
    // The old code called table.toArray(), converting every row to JS just to
    // display the first screenful, and the modal grew with the result.
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync("components/SqlConsole.tsx", "utf8"),
    );
    expect(source).toMatch(/const PAGE_SIZE = \d+/);
    expect(source).not.toMatch(/\.toArray\(\)/);
    // Rows come off the Arrow table by index, so only the page is materialised.
    expect(source).toMatch(/outcome\.table\.get\(i\)/);
  });

  it("holds the dialog at a fixed size", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync("components/SqlConsole.tsx", "utf8"),
    );
    expect(source).toMatch(/<Modal\s*\n?\s*fill/);
  });
});
