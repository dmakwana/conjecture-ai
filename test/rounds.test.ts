import { describe, it, expect } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { generateHypotheses, MAX_ROUNDS, MODEL } from "@/worker/hypotheses";
import app from "@/worker/index";
import type { DatabaseProfile } from "@/lib/profile/types";
import type { PriorRound } from "@/lib/hypotheses/findings";
import { PII_LITERALS } from "./fixtures";

const profile: DatabaseProfile = {
  tables: [{
    table: "orders", label: "orders.parquet", format: "parquet",
    rowCount: 100, columnCount: 1, profileMs: 5,
    columns: [{
      name: "amount", ordinal: 0, sqlType: "DOUBLE", class: "numeric",
      rowCount: 100, nullCount: 0, nullPct: 0, approxDistinct: 90, distinctPct: 90,
      isCandidateKey: false, numeric: null, temporal: null, boolean: null, string: null,
    }],
  }],
  profileMs: 5,
};

const MODEL_OUTPUT = {
  hypotheses: [{
    title: "amount is never negative", rationale: "min is -5", severity: "high",
    kind: "row_predicate", table: "orders", columns: [], expression: "amount >= 0",
    referencesTable: "", referencesColumns: [],
  }],
};

function recordingClient() {
  const requests: { body: Record<string, unknown> }[] = [];
  const fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({
      id: "msg_1", type: "message", role: "assistant", model: MODEL,
      content: [{ type: "text", text: JSON.stringify(MODEL_OUTPUT) }],
      stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { client: new Anthropic({ apiKey: "sk-test", fetch: fakeFetch }), requests };
}

const priorRound = (over: Partial<PriorRound["findings"][number]> = {}): PriorRound => ({
  round: 1,
  findings: [{
    title: "amount is never negative",
    check: { kind: "row_predicate", table: "orders", expression: "amount >= 0" },
    outcome: "falsified", violations: 143, pct: 0.36, rowCount: 40079, note: null,
    ...over,
  }],
});

describe("iterative rounds", () => {
  it("still makes exactly one request per round", async () => {
    const { client, requests } = recordingClient();
    await generateHypotheses(client, profile, [priorRound()]);
    expect(requests).toHaveLength(1);
  });

  it("tells the model in round 1 that follow-ups are coming", async () => {
    const { client, requests } = recordingClient();
    await generateHypotheses(client, profile, []);
    const system = String(requests[0].body.system);
    // This is what should make round 1 choose diagnostic hypotheses.
    expect(system).toMatch(/ROUND 1 OF UP TO/);
    expect(system).toMatch(/DIAGNOSTIC/);
  });

  it("sends prior verdicts on a follow-up, and says which round it is", async () => {
    const { client, requests } = recordingClient();
    const { exchange } = await generateHypotheses(client, profile, [priorRound()]);
    const message = String(
      (requests[0].body.messages as { content: string }[])[0].content,
    );
    expect(message).toMatch(/round 2 of up to 3/i);
    expect(message).toContain("FALSIFIED");
    expect(message).toContain("143");
    expect(exchange.round).toBe(2);
  });

  it("sends counts and percentages but never rows or SQL", async () => {
    const { client, requests } = recordingClient();
    await generateHypotheses(client, profile, [priorRound()]);
    const body = JSON.stringify(requests[0].body);
    expect(body).toContain("143");
    // The generated SQL and any violating rows stay in the browser.
    expect(body).not.toContain("SELECT count(*)");
    for (const literal of PII_LITERALS) {
      expect(body, `leaked ${literal}`).not.toContain(literal);
    }
  });

  it("passes a sanitised note through for a check that did not run", async () => {
    const { client, requests } = recordingClient();
    await generateHypotheses(client, profile, [
      priorRound({ outcome: "not_run", violations: null, pct: null, rowCount: null,
                   note: "type mismatch (amount)" }),
    ]);
    const message = String(
      (requests[0].body.messages as { content: string }[])[0].content,
    );
    expect(message).toContain("NOT RUN");
    expect(message).toContain("type mismatch");
  });

  it("uses opus 5 with server-side refusal fallbacks", async () => {
    const { client, requests } = recordingClient();
    await generateHypotheses(client, profile, []);
    expect(requests[0].body.model).toBe("claude-opus-5");
    // Anthropic recommends enabling these by default for Opus 5.
    expect(requests[0].body.fallbacks).toBe("default");
  });
});

describe("round limit", () => {
  it("is three", () => {
    expect(MAX_ROUNDS).toBe(3);
  });

  it("refuses a request that would exceed it", async () => {
    const rounds = [priorRound(), { ...priorRound(), round: 2 }, { ...priorRound(), round: 3 }];
    const res = await app.request("/api/hypotheses", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile, priorRounds: rounds }),
    }, { ANTHROPIC_API_KEY: "sk-test", ENVIRONMENT: "production" });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/maximum of 3 rounds/);
  });

  it("accepts a malformed priorRounds as a clean 400, not a crash", async () => {
    const res = await app.request("/api/hypotheses", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile, priorRounds: [{ nope: true }] }),
    }, { ANTHROPIC_API_KEY: "sk-test", ENVIRONMENT: "production" });
    expect(res.status).toBe(400);
  });
});
