import { z } from "zod";
import { DatabaseProfileSchema, type DatabaseProfile } from "@/lib/profile/types";
import type { Exchange, Hypothesis } from "@/lib/hypotheses/schema";
import { assertFindingsSafe, PriorRoundSchema, type PriorRound } from "@/lib/hypotheses/findings";
import { MAX_ROUNDS } from "@/lib/hypotheses/prompt";

export interface HypothesesResponse {
  hypotheses: Hypothesis[];
  /** Verbatim record of the single exchange, for the user to inspect. */
  exchange: Exchange;
}

/**
 * Ask Claude for hypotheses, directly from the browser with the user's own key.
 *
 * There is no server in between. The key goes to api.anthropic.com in the
 * x-api-key header and nowhere else: it is not stored by this function, not
 * part of the Exchange shown to the user, and scrubbed from any error message.
 *
 * `fetchImpl` exists for tests, which substitute a recording fake.
 */
export async function requestHypotheses(
  apiKey: string,
  profile: DatabaseProfile,
  priorRounds: PriorRound[] = [],
  { signal, fetchImpl = fetch }: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<HypothesesResponse> {
  if (!apiKey) throw new Error("Add your Anthropic API key to run this.");

  // Nothing leaves without passing the leak check, exactly as the profile does.
  for (const round of priorRounds) assertFindingsSafe(round.findings as never);

  // Parsing strips any key the schema does not declare, so nothing beyond the
  // declared profile shape can ride along to the model. This used to happen on
  // the server; with no server it happens here, just before the request.
  const parsedProfile = DatabaseProfileSchema.safeParse(profile);
  if (!parsedProfile.success) throw new Error("The profile failed validation, so it was not sent.");
  const parsedRounds = z.array(PriorRoundSchema).safeParse(priorRounds);
  if (!parsedRounds.success) throw new Error("Prior findings failed validation, so they were not sent.");
  if (parsedRounds.data.length >= MAX_ROUNDS) {
    throw new Error(`Already at the maximum of ${MAX_ROUNDS} rounds.`);
  }

  // Loaded on demand: the SDK is only needed once someone asks for hypotheses.
  const [{ default: Anthropic }, { generateHypotheses, RefusalError, UnusableResponseError }] =
    await Promise.all([import("@anthropic-ai/sdk"), import("@/lib/hypotheses/generate")]);

  // Count the HTTP requests actually made, so the transcript reports a measured
  // number rather than a promise. More than one means the SDK retried.
  let httpAttempts = 0;
  const countingFetch: typeof fetch = (input, init) => {
    httpAttempts++;
    return fetchImpl(input, init);
  };

  const client = new Anthropic({
    apiKey,
    fetch: countingFetch,
    // The SDK refuses to run in a browser by default, to stop a site shipping
    // its own key to visitors. Here the key is the visitor's, typed into their
    // own browser, which is exactly the case this flag is for.
    dangerouslyAllowBrowser: true,
  });

  try {
    const { hypotheses, exchange } = await generateHypotheses(
      client,
      parsedProfile.data,
      parsedRounds.data,
      signal,
    );
    return { hypotheses, exchange: { ...exchange, httpAttempts } };
  } catch (err) {
    if (err instanceof RefusalError || err instanceof UnusableResponseError) throw err;
    if (err instanceof Anthropic.APIUserAbortError) throw new Error("Cancelled.");
    if (err instanceof Anthropic.APIConnectionError) {
      throw new Error(`Could not reach Anthropic: ${scrub(err.message, apiKey)}`);
    }
    if (err instanceof Anthropic.APIError) {
      throw new Error(anthropicErrorMessage(err, apiKey));
    }
    throw err;
  }
}

/**
 * Anthropic's own explanation, passed through: it is the most useful thing to
 * show (a bad key, no access to the model, an exhausted credit balance, a rate
 * limit), and nobody else is better placed to word it.
 */
function anthropicErrorMessage(
  err: { status?: number | undefined; error?: unknown; message: string },
  apiKey: string,
): string {
  const body = err.error as { error?: { message?: unknown } } | undefined;
  const detail = typeof body?.error?.message === "string" ? body.error.message : err.message;
  const status = err.status ? ` (${err.status})` : "";
  return `Anthropic returned an error${status}: ${scrub(detail, apiKey)}`;
}

/** Belt and braces: an error message must never echo the key back onto the page. */
export function scrub(message: string, apiKey: string): string {
  return apiKey ? message.split(apiKey).join("[your API key]") : message;
}
