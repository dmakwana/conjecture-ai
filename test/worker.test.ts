import { describe, it, expect } from "vitest";
import app from "@/worker/index";
import { normalizeHypotheses } from "@/lib/hypotheses/schema";
import type { DatabaseProfile, TableProfile } from "@/lib/profile/types";

const ENV = { ANTHROPIC_API_KEY: "", ENVIRONMENT: "production" };

const table: TableProfile = {
  table: "t", label: "t.parquet", format: "parquet",
  rowCount: 1, columnCount: 1, profileMs: 1,
  columns: [{
    name: "a", ordinal: 0, sqlType: "BIGINT", class: "numeric",
    rowCount: 1, nullCount: 0, nullPct: 0, approxDistinct: 1, distinctPct: 100,
    isCandidateKey: true, numeric: null, temporal: null, boolean: null, string: null,
  }],
};

const profile: DatabaseProfile = { tables: [table], profileMs: 1 };

const post = (body: unknown, env = ENV) =>
  app.request("/api/hypotheses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, env);

describe("worker routes", () => {
  it("reports health without leaking the key", async () => {
    const res = await app.request("/api/health", {}, { ...ENV, ANTHROPIC_API_KEY: "sk-secret" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, model: "claude-opus-5", hasKey: true, maxRounds: 3 });
    expect(JSON.stringify(body)).not.toContain("sk-secret");
  });

  it("fails cleanly when no key is configured", async () => {
    const res = await post({ profile });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/ANTHROPIC_API_KEY/);
  });

  it("rejects a malformed profile before calling Anthropic", async () => {
    const res = await post({ profile: { table: "t" } }, { ...ENV, ANTHROPIC_API_KEY: "sk-test" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Invalid profile/);
  });

  it("rejects a non-JSON body", async () => {
    const res = await app.request("/api/hypotheses", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "not json",
    }, { ...ENV, ANTHROPIC_API_KEY: "sk-test" });
    expect(res.status).toBe(400);
  });

  it("marks API responses noindex, since _headers does not cover them", async () => {
    const res = await app.request("/api/health", {}, ENV);
    expect(res.headers.get("x-robots-tag")).toMatch(/noindex/);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("404s unknown routes", async () => {
    expect((await app.request("/api/nope", {}, ENV)).status).toBe(404);
  });

  it("does not send CORS headers in production", async () => {
    const res = await app.request("/api/health", { headers: { Origin: "http://localhost:3000" } }, ENV);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("allows the dev origin outside production", async () => {
    const res = await app.request(
      "/api/health",
      { headers: { Origin: "http://localhost:3000" } },
      { ...ENV, ENVIRONMENT: "development" },
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
  });
});

describe("normalizeHypotheses", () => {
  it("assigns ids and builds a discriminated union from the flat wire form", () => {
    const out = normalizeHypotheses({
      hypotheses: [
        { title: "a", rationale: "r", severity: "high", kind: "row_predicate",
          table: "t", columns: [], expression: "x > 0",
          referencesTable: "", referencesColumns: [] },
        { title: "b", rationale: "r", severity: "low", kind: "unique",
          table: "t", columns: ["y"], expression: "",
          referencesTable: "", referencesColumns: [] },
        { title: "c", rationale: "r", severity: "medium", kind: "references",
          table: "t", columns: ["fk"], expression: "",
          referencesTable: "other", referencesColumns: ["pk"] },
      ],
    });
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({
      id: "h1", check: { kind: "row_predicate", table: "t", expression: "x > 0" },
    });
    expect(out[1]).toMatchObject({
      id: "h2", check: { kind: "unique", table: "t", columns: ["y"] },
    });
    expect(out[2]).toMatchObject({
      id: "h3",
      check: {
        kind: "references", table: "t", columns: ["fk"],
        referencesTable: "other", referencesColumns: ["pk"],
      },
    });
  });

  it("drops entries whose payload does not match their kind", () => {
    const out = normalizeHypotheses({
      hypotheses: [
        { title: "empty predicate", rationale: "r", severity: "low",
          kind: "row_predicate", table: "t", columns: [], expression: "   ",
          referencesTable: "", referencesColumns: [] },
        { title: "unique with no columns", rationale: "r", severity: "low",
          kind: "unique", table: "t", columns: [], expression: "",
          referencesTable: "", referencesColumns: [] },
        { title: "references with mismatched column counts", rationale: "r", severity: "low",
          kind: "references", table: "t", columns: ["a"], expression: "",
          referencesTable: "other", referencesColumns: ["a", "b"] },
        { title: "no table named", rationale: "r", severity: "low",
          kind: "row_predicate", table: "  ", columns: [], expression: "x > 0",
          referencesTable: "", referencesColumns: [] },
      ],
    });
    expect(out).toHaveLength(0);
  });
});
