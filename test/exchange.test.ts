import { describe, it, expect } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { generateHypotheses, MODEL } from "@/worker/hypotheses";
import type { TableProfile } from "@/lib/profile/types";

const profile: TableProfile = {
  table: "orders", format: "parquet", rowCount: 100, columnCount: 1, profileMs: 5,
  columns: [{
    name: "amount", ordinal: 0, sqlType: "DOUBLE", class: "numeric",
    rowCount: 100, nullCount: 0, nullPct: 0, approxDistinct: 90, distinctPct: 90,
    isCandidateKey: false,
    numeric: {
      min: -5, max: 100, avg: 40, stddev: 10, p01: 0, p25: 20, p50: 40, p75: 60, p99: 99,
      zeroCount: 3, negativeCount: 1, nonFiniteCount: 0,
    },
    temporal: null, boolean: null, string: null,
  }],
};

const MODEL_OUTPUT = {
  hypotheses: [
    { title: "amount is never negative", rationale: "min is -5", columns: ["amount"],
      severity: "high", kind: "row_predicate", expression: "amount >= 0", unique_columns: [] },
  ],
};

/** A fake Anthropic endpoint that records every HTTP request made to it. */
function recordingClient() {
  const requests: { url: string; body: unknown }[] = [];

  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response(
      JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: MODEL,
        content: [{ type: "text", text: JSON.stringify(MODEL_OUTPUT) }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1234, output_tokens: 567 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  const client = new Anthropic({ apiKey: "sk-test", fetch: fakeFetch });
  return { client, requests };
}

describe("one query, one response", () => {
  it("makes exactly one HTTP request to Anthropic", async () => {
    const { client, requests } = recordingClient();
    await generateHypotheses(client, profile);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toContain("/v1/messages");
  });

  it("sends exactly one user message and no tools", async () => {
    const { client, requests } = recordingClient();
    await generateHypotheses(client, profile);

    const body = requests[0].body as {
      messages: { role: string }[]; tools?: unknown; system: string; model: string;
    };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");
    // No tools means no agent loop is even possible: the model cannot ask for
    // another turn, so one request is structurally the whole exchange.
    expect(body.tools).toBeUndefined();
    expect(body.model).toBe(MODEL);
  });

  it("returns one response, recorded verbatim for the user to read", async () => {
    const { client, requests } = recordingClient();
    const { exchange, hypotheses } = await generateHypotheses(client, profile);

    const body = requests[0].body as { system: string; messages: { content: string }[] };
    // The transcript must be what was actually sent, not a reconstruction.
    expect(exchange.system).toBe(body.system);
    expect(exchange.userMessage).toBe(body.messages[0].content);
    expect(JSON.parse(exchange.responseJson)).toEqual(MODEL_OUTPUT);

    expect(exchange.stopReason).toBe("end_turn");
    expect(exchange.inputTokens).toBe(1234);
    expect(exchange.outputTokens).toBe(567);
    expect(exchange.hypothesesReturned).toBe(1);
    expect(hypotheses).toHaveLength(1);
  });

  it("carries the profile and nothing else into the request body", async () => {
    const { client, requests } = recordingClient();
    await generateHypotheses(client, profile);
    const serialized = JSON.stringify(requests[0].body);
    expect(serialized).toContain("amount");
    // Still metadata-only at the point it actually leaves the process.
    expect(serialized).not.toMatch(/\brow\s*values\b/i);
    expect(exchangeIsMetadataOnly(serialized)).toBe(true);
  });
});

/** The request body should contain the profile JSON and the prompt, nothing else. */
function exchangeIsMetadataOnly(serialized: string): boolean {
  const parsed = JSON.parse(serialized) as { messages: { content: string }[] };
  const content = parsed.messages[0].content;
  const jsonBlock = content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1);
  const sent = JSON.parse(jsonBlock) as TableProfile;
  return sent.columns.every(
    (c) => c.string === null || c.string.shapes.every((s) => !/[b-zB-Z0-8]/.test(s.shape.replace(/\{\d+\}/g, ""))),
  );
}
