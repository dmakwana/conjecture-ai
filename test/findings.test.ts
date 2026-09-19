import { describe, it, expect } from "vitest";
import {
  sanitizeNote, knownIdentifiers, toFinding, assertFindingsSafe, FindingsLeakError,
} from "@/lib/hypotheses/findings";
import type { Hypothesis, HypothesisResult } from "@/lib/hypotheses/schema";
import { PII_LITERALS } from "./fixtures";

const known = knownIdentifiers([
  { table: "orders", columns: [{ name: "order_id" }, { name: "customer_email" }, { name: "amount" }] },
  { table: "customers", columns: [{ name: "customer_id" }] },
]);

const hypothesis = (title: string): Hypothesis => ({
  id: "h1", title, rationale: "r", severity: "high",
  check: { kind: "row_predicate", table: "orders", expression: "amount >= 0" },
});

describe("sanitizeNote", () => {
  it("strips the cell values DuckDB embeds in its errors", () => {
    // This is the whole reason the sanitiser exists: feeding raw engine errors
    // back to the model would hand it data the profile deliberately withheld.
    const leaky = [
      "Conversion Error: Could not convert string 'aaron.blake@acme.io' to DOUBLE",
      "Invalid Input Error: Could not cast value '123-45-6789' to INTEGER",
      `Binder Error: No function matches given name and argument types 'foo("Aaron Blake")'`,
      "Conversion Error: Unimplemented type for cast (VARCHAR -> DATE) value 'ACCT-99381'",
    ];
    for (const raw of leaky) {
      const note = sanitizeNote(raw, known);
      for (const literal of PII_LITERALS) {
        expect(note, `leaked ${literal} from: ${raw}`).not.toContain(literal);
      }
      // No quoted fragment survives at all.
      expect(note).not.toMatch(/['"`]/);
    }
  });

  it("keeps the category so the model can avoid repeating the mistake", () => {
    expect(sanitizeNote("Binder Error: Referenced column \"nope\" not found", known))
      .toMatch(/unknown column/);
    expect(sanitizeNote("Conversion Error: Could not convert string 'x' to DOUBLE", known))
      .toMatch(/type mismatch/);
    expect(sanitizeNote("Parser Error: syntax error at or near \"FROM\"", known))
      .toMatch(/syntax error/);
    expect(sanitizeNote('Unknown table "ghost".', known)).toMatch(/unknown table/);
  });

  it("classifies our own guard rejections precisely", () => {
    expect(sanitizeNote('Keyword "select" is not allowed in a row predicate.', known))
      .toMatch(/guard/);
    expect(sanitizeNote('Identifier "read_csv" can read external data.', known))
      .toMatch(/file or URL access/);
    expect(sanitizeNote("Statement separator (;) is not allowed.", known))
      .toMatch(/separator/);
  });

  it("echoes identifiers the model already has, and only those", () => {
    const note = sanitizeNote(
      "Binder Error: Referenced column secret_column not found in orders",
      known,
    );
    expect(note).toContain("orders");
    expect(note).not.toContain("secret_column");
  });

  it("stays short no matter how long the engine message is", () => {
    const note = sanitizeNote("Conversion Error: " + "x".repeat(5000), known);
    expect(note.length).toBeLessThanOrEqual(120);
  });
});

describe("toFinding", () => {
  it("carries counts and percentages, which the profile already exposes", () => {
    const result: HypothesisResult = {
      status: "falsified", violations: 143, rowCount: 40079, pct: 0.357, ms: 8,
      sql: "SELECT ...",
    };
    const f = toFinding(hypothesis("amounts are non-negative"), result, known);
    expect(f).toMatchObject({ outcome: "falsified", violations: 143, rowCount: 40079 });
    expect(f.note).toBeNull();
    // The SQL is local detail; it never goes back.
    expect(JSON.stringify(f)).not.toContain("SELECT");
  });

  it("sanitises the reason on a skipped check", () => {
    const result: HypothesisResult = {
      status: "skipped",
      reason: "Conversion Error: Could not convert string 'zoe.k@example.org' to DOUBLE",
    };
    const f = toFinding(hypothesis("t"), result, known);
    expect(f.outcome).toBe("not_run");
    expect(f.note).not.toContain("zoe.k@example.org");
    expect(f.note).toMatch(/type mismatch/);
  });
});

describe("assertFindingsSafe", () => {
  it("passes sanitised findings", () => {
    const f = toFinding(hypothesis("t"), { status: "holds", violations: 0, rowCount: 5, ms: 1, sql: "x" }, known);
    expect(() => assertFindingsSafe([f])).not.toThrow();
  });

  it("refuses a note that still carries quoted engine text", () => {
    // The backstop for a future change that forgets to sanitise.
    expect(() =>
      assertFindingsSafe([{
        title: "t", check: { kind: "unique", table: "orders", columns: ["order_id"] },
        outcome: "not_run", violations: null, pct: null, rowCount: null,
        note: `Could not convert 'aaron.blake@acme.io'`,
      }]),
    ).toThrow(FindingsLeakError);
  });
});
