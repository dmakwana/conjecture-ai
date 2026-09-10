import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestConnection, type TestConn } from "./helpers/duckdb";
import { profileTable } from "@/lib/profile/profile";
import { classify } from "@/lib/profile/queries";
import type { TableProfile } from "@/lib/profile/types";
import type { LoadedTable } from "@/lib/duckdb/load";
import { CSV_FIXTURE, PII_LITERALS } from "./fixtures";

let conn: TestConn;
let profile: TableProfile;
let fixtureCsv: string;

/** profileTable always reads the fixed table name, so any test that replaces
 *  the table must put the fixture back for whatever runs next. */
const restoreFixture = () =>
  conn.query(`CREATE OR REPLACE TABLE data AS SELECT * FROM read_csv_auto('${fixtureCsv}')`);

const column = (name: string) => profile.columns.find((c) => c.name === name)!;

beforeAll(async () => {
  conn = await createTestConnection();

  const dir = mkdtempSync(path.join(tmpdir(), "duck-invariant-"));
  fixtureCsv = path.join(dir, "fixture.csv");
  writeFileSync(fixtureCsv, CSV_FIXTURE);

  await restoreFixture();

  const described = (await conn.query(`DESCRIBE data`)).toArray().map((r) => {
    const o = r.toJSON() as { column_name: string; column_type: string };
    return { name: o.column_name, sqlType: o.column_type };
  });

  const loaded: LoadedTable = {
    table: "data",
    label: "fixture.csv",
    format: "csv",
    rowCount: 6,
    columns: described,
    bytes: CSV_FIXTURE.length,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  profile = await profileTable(conn as any, loaded);
}, 180_000);

afterAll(() => conn?.close());

describe("classify", () => {
  it("maps DuckDB types onto stat classes", () => {
    expect(classify("BIGINT")).toBe("numeric");
    expect(classify("DECIMAL(10,2)")).toBe("numeric");
    expect(classify("DOUBLE")).toBe("numeric");
    expect(classify("DATE")).toBe("temporal");
    expect(classify("TIMESTAMP WITH TIME ZONE")).toBe("temporal");
    expect(classify("BOOLEAN")).toBe("boolean");
    expect(classify("VARCHAR")).toBe("string");
    expect(classify("INTEGER[]")).toBe("nested");
    expect(classify("STRUCT(a INTEGER)")).toBe("nested");
    // TIME has no date, so "in the future" is meaningless for it.
    expect(classify("TIME")).toBe("other");
  });
});

describe("profileTable", () => {
  it("counts rows and columns", () => {
    expect(profile.rowCount).toBe(6);
    expect(profile.columnCount).toBe(8);
  });

  it("computes numeric statistics including sentinels", () => {
    const amount = column("amount");
    expect(amount.class).toBe("numeric");
    expect(amount.numeric).not.toBeNull();
    expect(amount.numeric!.min).toBeCloseTo(-3.25, 2);
    expect(amount.numeric!.max).toBeCloseTo(42.0, 2);
    expect(amount.numeric!.negativeCount).toBe(1);
    expect(amount.numeric!.zeroCount).toBe(1);
  });

  it("flags epoch-zero and future dates", () => {
    const created = column("created_at");
    expect(created.class).toBe("temporal");
    expect(created.temporal!.epochZeroCount).toBe(1);
    expect(created.temporal!.futureCount).toBe(1);
    expect(created.temporal!.minISO).toContain("1970-01-01");
  });

  it("counts booleans", () => {
    const active = column("active");
    expect(active.class).toBe("boolean");
    expect(active.boolean).toEqual({ trueCount: 4, falseCount: 2 });
  });

  it("measures null and empty separately", () => {
    // ssn has one true NULL; notes has one empty string and one whitespace-only.
    expect(column("ssn").nullCount).toBe(1);
    const notes = column("notes");
    expect(notes.string!.whitespaceOnlyCount).toBeGreaterThanOrEqual(1);
    expect(notes.string!.untrimmedCount).toBeGreaterThanOrEqual(1);
  });

  it("detects case inconsistency without revealing values", () => {
    const name = column("full_name");
    // "Sam Fox" and "sam fox" collapse under lower(), so the case-insensitive
    // distinct count must be strictly lower than the raw one.
    expect(name.string!.distinctCaseInsensitive).toBeLessThan(name.approxDistinct);
  });

  it("produces masked shapes, not values", () => {
    const email = column("email");
    expect(email.string!.shapes.length).toBeGreaterThan(0);
    for (const { shape } of email.string!.shapes) {
      // Strip run-length counts (`a{5}`), whose digits are structural, then
      // assert the residue holds no letter but a/A and no digit but 9.
      const residue = shape.replace(/\{\d+\}/g, "");
      expect(residue, shape).not.toMatch(/[b-zB-Z0-8]/);
      // The email format survives masking, which is the point of a shape.
      expect(shape).toContain("@");
    }
    // e.g. "aaron.blake@acme.io" -> "a{5}.a{5}@a{4}.aa"
    expect(email.string!.shapes[0].shape).toMatch(/^a\{\d+\}.*@.*\..*$/);
  });

  it("computes character-class percentages that actually add up", () => {
    // Regression: sum(length(...)) returns HUGEINT, which Arrow delivers as a
    // Decimal128 word array. Read naively every one of these was silently 0.
    const email = column("email");
    const cc = email.string!.charClassPct;
    expect(cc.alpha).toBeGreaterThan(0);
    expect(cc.punct).toBeGreaterThan(0);
    expect(cc.alpha + cc.digit + cc.space + cc.punct + cc.other).toBeCloseTo(100, 1);
  });

  it("handles DECIMAL columns without losing the value to Arrow decoding", async () => {
    // Regression: DECIMAL min/max arrive as Decimal128 like the sums above.
    await conn.query(
      `CREATE OR REPLACE TABLE data AS SELECT * FROM (VALUES
         (CAST(10.50 AS DECIMAL(10,2))), (CAST(-3.25 AS DECIMAL(10,2))), (CAST(42.00 AS DECIMAL(10,2)))
       ) AS t(price)`,
    );
    const decimalProfile = await profileTable(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      conn as any,
      {
        table: "data", label: "decimals", format: "parquet", rowCount: 3,
        columns: [{ name: "price", sqlType: "DECIMAL(10,2)" }],
        bytes: 0,
      },
    );
    const price = decimalProfile.columns[0];
    expect(price.class).toBe("numeric");
    expect(price.numeric!.min).toBeCloseTo(-3.25, 2);
    expect(price.numeric!.max).toBeCloseTo(42.0, 2);
    expect(price.numeric!.negativeCount).toBe(1);

    await restoreFixture();
  });

  it("identifies a candidate key", () => {
    expect(column("id").isCandidateKey).toBe(true);
    expect(column("active").isCandidateKey).toBe(false);
  });
});

describe("the metadata-only guarantee", () => {
  it("leaks no PII into the profile that gets sent", () => {
    const serialized = JSON.stringify(profile);
    for (const literal of PII_LITERALS) {
      expect(serialized, `leaked ${literal}`).not.toContain(literal);
    }
  });

  it("leaks no fragment of an email local part or domain", () => {
    const serialized = JSON.stringify(profile).toLowerCase();
    for (const fragment of ["aaron", "blake", "acme", "northwind", "priya", "kaur"]) {
      expect(serialized, `leaked ${fragment}`).not.toContain(fragment);
    }
  });
});
