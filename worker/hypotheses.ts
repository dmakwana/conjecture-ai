import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { TableProfile } from "@/lib/profile/types";
import {
  WireHypothesesSchema,
  normalizeHypotheses,
  type Exchange,
  type Hypothesis,
} from "@/lib/hypotheses/schema";
import { SYSTEM_PROMPT, buildUserMessage } from "./prompt";

export const MODEL = "claude-sonnet-5";
export const MAX_TOKENS = 16_000;

export class RefusalError extends Error {}
export class UnusableResponseError extends Error {}

/**
 * One request, one response. There is no agent loop and no tool use here: the
 * model is asked once for structured output and that is the whole exchange.
 * Extracted from the route so a test can drive it with a request-counting
 * client and assert that.
 */
export async function generateHypotheses(
  client: Anthropic,
  profile: TableProfile,
): Promise<{ hypotheses: Hypothesis[]; exchange: Omit<Exchange, "httpAttempts"> }> {
  const system = SYSTEM_PROMPT;
  const userMessage = buildUserMessage(profile);
  const started = Date.now();

  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system,
    messages: [{ role: "user", content: userMessage }],
    output_config: { format: zodOutputFormat(WireHypothesesSchema) },
  });

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
    },
  };
}
