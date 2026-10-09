import { describe, it, expect } from "vitest";
import { requestHypotheses, scrub } from "@/lib/api";
import { MODEL } from "@/lib/hypotheses/generate";
import type { DatabaseProfile } from "@/lib/profile/types";

/**
 * The browser now talks to Anthropic directly with the user's own key. These
 * pin down where that key may go (one header, to one host) and where it must
 * never appear (the body, the transcript, error text).
 */
const KEY = "sk-ant-api03-TEST-KEY-abcdefghijklmnop";

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

interface Recorded { url: string; headers: Headers; body: string }

function fakeAnthropic(respond: () => Response = ok) {
  const requests: Recorded[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: String(init?.body ?? ""),
    });
    return respond();
  }) as typeof fetch;
  return { fetchImpl, requests };
}

function ok(): Response {
  return new Response(JSON.stringify({
    id: "msg_1", type: "message", role: "assistant", model: MODEL,
    content: [{ type: "text", text: JSON.stringify(MODEL_OUTPUT) }],
    stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function apiError(status: number, type: string, message: string) {
  return () => new Response(
    JSON.stringify({ type: "error", error: { type, message } }),
    { status, headers: { "content-type": "application/json" } },
  );
}

describe("requestHypotheses with the user's key", () => {
  it("sends the key only in x-api-key, straight to Anthropic", async () => {
    const { fetchImpl, requests } = fakeAnthropic();
    await requestHypotheses(KEY, profile, [], { fetchImpl });

    expect(requests).toHaveLength(1);
    expect(new URL(requests[0].url).host).toBe("api.anthropic.com");
    expect(requests[0].headers.get("x-api-key")).toBe(KEY);
    // The SDK's opt-in header for browser use; without it CORS fails.
    expect(requests[0].headers.get("anthropic-dangerous-direct-browser-access")).toBe("true");
    expect(requests[0].body).not.toContain(KEY);
  });

  it("keeps the key out of everything shown to the user", async () => {
    const { fetchImpl } = fakeAnthropic();
    const response = await requestHypotheses(KEY, profile, [], { fetchImpl });
    expect(JSON.stringify(response)).not.toContain(KEY);
    expect(response.exchange.httpAttempts).toBe(1);
  });

  it("strips fields the profile schema does not declare before sending", async () => {
    const { fetchImpl, requests } = fakeAnthropic();
    const smuggled = {
      ...profile,
      sampleRows: [{ email: "aaron.blake@acme.io" }],
      tables: profile.tables.map((t) => ({ ...t, topValues: ["aaron.blake@acme.io"] })),
    } as unknown as DatabaseProfile;

    await requestHypotheses(KEY, smuggled, [], { fetchImpl });
    expect(requests[0].body).not.toContain("aaron.blake");
    expect(requests[0].body).toContain("amount");
  });

  it("refuses to send without a key", async () => {
    const { fetchImpl, requests } = fakeAnthropic();
    await expect(requestHypotheses("", profile, [], { fetchImpl })).rejects.toThrow(/API key/);
    expect(requests).toHaveLength(0);
  });

  it("passes Anthropic's own error message back to the user", async () => {
    const { fetchImpl } = fakeAnthropic(
      apiError(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API."),
    );
    await expect(requestHypotheses(KEY, profile, [], { fetchImpl })).rejects.toThrow(
      "Anthropic returned an error (400): Your credit balance is too low to access the Anthropic API.",
    );
  });

  it("never echoes the key in an error, even if Anthropic's message contains it", async () => {
    const { fetchImpl } = fakeAnthropic(
      apiError(401, "authentication_error", `invalid x-api-key: ${KEY}`),
    );
    const err = await requestHypotheses(KEY, profile, [], { fetchImpl }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/\(401\)/);
    expect((err as Error).message).not.toContain(KEY);
  });
});

describe("scrub", () => {
  it("replaces every occurrence of the key", () => {
    expect(scrub(`${KEY} and ${KEY}`, KEY)).toBe("[your API key] and [your API key]");
  });

  it("leaves a message alone when there is no key", () => {
    expect(scrub("nothing here", "")).toBe("nothing here");
  });
});
