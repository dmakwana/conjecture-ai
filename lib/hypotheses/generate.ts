import type Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { DatabaseProfile } from "@/lib/profile/types";
import {
  WireHypothesesSchema,
  normalizeHypotheses,
  type Exchange,
  type Hypothesis,
} from "@/lib/hypotheses/schema";
import type { PriorRound } from "@/lib/hypotheses/findings";
import { systemPromptFor, buildFollowUpMessage, buildUserMessage, MAX_ROUNDS } from "./prompt";

export const MODEL = "claude-opus-5";
export const MAX_TOKENS = 16_000;

/**
 * Server-side refusal fallbacks, which Anthropic recommends enabling by default
 * for Opus 5. If a safety classifier declines the request, the API retries on a
 * fallback model by refusal category instead of handing us an empty result.
 */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export { MAX_ROUNDS };

export class RefusalError extends Error {}
export class UnusableResponseError extends Error {}

/**
 * One request, one response. There is no agent loop and no tool use here: the
 * model is asked once for structured output and that is the whole exchange.
 * Takes the client as a parameter so a test can drive it with a
 * request-counting fake and assert that. lib/api.ts builds the real one.
 */
export async function generateHypotheses(
  client: Anthropic,
  profile: DatabaseProfile,
  priorRounds: PriorRound[] = [],
  signal?: AbortSignal,
): Promise<{ hypotheses: Hypothesis[]; exchange: Omit<Exchange, "httpAttempts"> }> {
  const round = priorRounds.length + 1;
  // Round 1 gets the extra guidance about diagnostic hypotheses; later rounds
  // must not, since it tells them they are round 1.
  const system = systemPromptFor(round);
  // Round 1 sees the profile; later rounds also see what their predecessors
  // found, which is the whole point of iterating.
  const userMessage =
    priorRounds.length === 0
      ? buildUserMessage(profile)
      : buildFollowUpMessage(profile, priorRounds);
  const started = Date.now();

  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system,
    messages: [{ role: "user", content: userMessage }],
    output_config: { format: betaZodOutputFormat(WireHypothesesSchema) },
    betas: [FALLBACK_BETA],
    fallbacks: "default",
  }, { signal });

  const latencyMs = Date.now() - started;

  if (response.stop_reason === "refusal") {
    throw new RefusalError("The model declined to answer this request.");
  }
  if (!response.parsed_output) {
    throw new UnusableResponseError("The model did not return a usable result.");
  }

  const hypotheses = normalizeHypotheses(response.parsed_output);

  return {
    hypotheses,
    exchange: {
      model: MODEL,
      system,
      userMessage,
      responseJson: JSON.stringify(response.parsed_output, null, 2),
      stopReason: response.stop_reason ?? null,
      latencyMs,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      hypothesesReturned: response.parsed_output.hypotheses.length,
      round,
    },
  };
}
