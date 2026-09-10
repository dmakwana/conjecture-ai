import { describe, it, expect } from "vitest";
import { baseNameFor, uniqueTableName, isSafeTableName } from "@/lib/duckdb/tables";

describe("baseNameFor", () => {
  it("derives an identifier from a filename", () => {
    expect(baseNameFor("orders.csv")).toBe("orders");
    expect(baseNameFor("line items 2024.parquet")).toBe("line_items_2024");
    expect(baseNameFor("Customers-EU.json")).toBe("customers_eu");
    expect(baseNameFor("data.csv.gz")).toBe("data");
  });

  it("derives one from a URL, ignoring the query string", () => {
    expect(baseNameFor("https://example.com/a/b/lineitem.parquet")).toBe("lineitem");
    expect(baseNameFor("https://example.com/orders.csv?token=abc")).toBe("orders");
    expect(baseNameFor("https://example.com/my%20table.csv")).toBe("my_table");
  });

  it("never produces something unsafe to interpolate into SQL", () => {
    // Filenames are user-controlled and end up in SQL, so this is the boundary.
    const nasty = [
      'orders"; DROP TABLE users; --.csv',
      "../../etc/passwd",
      "'; SELECT 1; --",
      "123.csv",
      "....csv",
      "",
      "table.csv",
      "SELECT.parquet",
      "a".repeat(300) + ".csv",
    ];
    for (const label of nasty) {
      const name = baseNameFor(label);
      expect(isSafeTableName(name.slice(0, 64)), `${label} -> ${name}`).toBe(true);
    }
  });

  it("avoids names that would collide with SQL keywords", () => {
    expect(baseNameFor("table.csv")).toBe("table_tbl");
    expect(baseNameFor("select.csv")).toBe("select_tbl");
  });

  it("prefixes names that would start with a digit", () => {
    expect(baseNameFor("2024.csv")).toBe("t_2024");
    expect(isSafeTableName(baseNameFor("2024.csv"))).toBe(true);
  });
});

describe("uniqueTableName", () => {
  it("suffixes a counter when the base is taken", () => {
    expect(uniqueTableName("orders.csv", [])).toBe("orders");
    expect(uniqueTableName("orders.csv", ["orders"])).toBe("orders_2");
    expect(uniqueTableName("orders.csv", ["orders", "orders_2"])).toBe("orders_3");
  });

  it("keeps every generated name safe", () => {
    const taken: string[] = [];
    for (let i = 0; i < 5; i++) {
      const name = uniqueTableName("my report!.csv", taken);
      expect(isSafeTableName(name)).toBe(true);
      taken.push(name);
    }
    expect(new Set(taken).size).toBe(5);
  });
});

describe("isSafeTableName", () => {
  it("accepts plain identifiers and rejects everything else", () => {
    expect(isSafeTableName("orders")).toBe(true);
    expect(isSafeTableName("orders_2")).toBe(true);
    expect(isSafeTableName("Orders")).toBe(false);
    expect(isSafeTableName("2024")).toBe(false);
    expect(isSafeTableName("or ders")).toBe(false);
    expect(isSafeTableName('or"ders')).toBe(false);
    expect(isSafeTableName("orders;")).toBe(false);
    expect(isSafeTableName("a".repeat(65))).toBe(false);
  });
});
