import { describe, it, expect } from "vitest";
import app from "@/worker/index";
import { normalizeHypotheses } from "@/lib/hypotheses/schema";
import type { TableProfile } from "@/lib/profile/types";

const ENV = { ANTHROPIC_API_KEY: "", ENVIRONMENT: "production" };

const profile: TableProfile = {
  table: "t", format: "parquet", rowCount: 1, columnCount: 1, profileMs: 1,
  columns: [{
    name: "a", ordinal: 0, sqlType: "BIGINT", class: "numeric",
    rowCount: 1, nullCount: 0, nullPct: 0, approxDistinct: 1, distinctPct: 100,
    isCandidateKey: true, numeric: null, temporal: null, boolean: null, string: null,
  }],
};

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
    expect(body).toEqual({ ok: true, model: "claude-sonnet-5", hasKey: true });
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
        { title: "a", rationale: "r", columns: ["x"], severity: "high",
          kind: "row_predicate", expression: "x > 0", unique_columns: [] },
        { title: "b", rationale: "r", columns: ["y"], severity: "low",
          kind: "unique", expression: "", unique_columns: ["y"] },
      ],
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: "h1", check: { kind: "row_predicate", expression: "x > 0" } });
    expect(out[1]).toMatchObject({ id: "h2", check: { kind: "unique", columns: ["y"] } });
  });

  it("drops entries whose payload does not match their kind", () => {
    const out = normalizeHypotheses({
      hypotheses: [
        { title: "empty predicate", rationale: "r", columns: [], severity: "low",
          kind: "row_predicate", expression: "   ", unique_columns: [] },
        { title: "unique with no columns", rationale: "r", columns: [], severity: "low",
          kind: "unique", expression: "", unique_columns: [] },
      ],
    });
    expect(out).toHaveLength(0);
  });
});
