import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, type TestConn } from "./helpers/duckdb";
import { loadIntoDuckDB } from "@/lib/duckdb/load";
import { evaluateAllHypotheses } from "@/lib/hypotheses/evaluate";
import type { Hypothesis, HypothesisResult } from "@/lib/hypotheses/schema";
import { CSV_FIXTURE } from "./fixtures";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;
let conn: TestConn;
const COLUMNS = ["id", "email", "full_name", "ssn", "amount", "created_at", "active", "notes"];

const make = (id: string, expression: string): Hypothesis => ({
  id, title: id, rationale: "r", columns: [], severity: "medium",
  check: { kind: "row_predicate", expression },
});

beforeAll(async () => {
  const testDb = await createTestDb();
  db = testDb.db;
  await loadIntoDuckDB(db, {
    bytes: new TextEncoder().encode(CSV_FIXTURE), format: "csv", label: "fixture.csv",
  });
  conn = await testDb.connect();
}, 180_000);

afterAll(() => conn?.close());

describe("evaluateAllHypotheses", () => {
  it("reports every verdict exactly once, streaming as each lands", async () => {
    const hypotheses = [
      make("h1", "id > 0"),
      make("h2", "amount >= 0"),
      make("h3", "id < 1000"),
      make("h4", "amount < 1000"),
      make("h5", "length(email) > 3"),
      make("h6", "no_such_column > 0"),
    ];

    const started: string[] = [];
    const results = new Map<string, HypothesisResult>();

    await evaluateAllHypotheses(db, hypotheses, COLUMNS, 6, {
      onStart: (id) => started.push(id),
      onResult: (id, r) => {
        expect(results.has(id), `${id} reported twice`).toBe(false);
        results.set(id, r);
      },
    });

    expect(started.sort()).toEqual(["h1", "h2", "h3", "h4", "h5", "h6"]);
    expect(results.size).toBe(6);
    expect(results.get("h1")?.status).toBe("holds");
    expect(results.get("h2")?.status).toBe("falsified");
    // A broken check must not take the batch down with it.
    expect(results.get("h6")?.status).toBe("skipped");
  }, 120_000);

  it("starts more than one check before the first finishes", async () => {
    // The point of the pool: work is in flight concurrently rather than each
    // check waiting for the previous verdict.
    const hypotheses = Array.from({ length: 8 }, (_, i) => make(`c${i}`, "id > 0"));

    let inFlight = 0;
    let peak = 0;
    await evaluateAllHypotheses(db, hypotheses, COLUMNS, 6, {
      onStart: () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
      },
      onResult: () => {
        inFlight--;
      },
    });

    expect(peak).toBeGreaterThan(1);
  }, 120_000);

  it("handles fewer hypotheses than lanes, and none at all", async () => {
    const one = new Map<string, HypothesisResult>();
    await evaluateAllHypotheses(db, [make("only", "id > 0")], COLUMNS, 6, {
      onResult: (id, r) => one.set(id, r),
    });
    expect(one.size).toBe(1);

    await expect(
      evaluateAllHypotheses(db, [], COLUMNS, 6, {}),
    ).resolves.toBeUndefined();
  }, 120_000);

  it("stops early when aborted", async () => {
    const hypotheses = Array.from({ length: 20 }, (_, i) => make(`a${i}`, "id > 0"));
    const controller = new AbortController();
    let done = 0;

    await evaluateAllHypotheses(
      db, hypotheses, COLUMNS, 6,
      { onResult: () => { if (++done === 4) controller.abort(); } },
      2,
      controller.signal,
    );

    expect(done).toBeLessThan(hypotheses.length);
  }, 120_000);
});
