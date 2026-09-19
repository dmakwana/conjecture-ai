import type { DatabaseProfile } from "@/lib/profile/types";
import type { Exchange, Hypothesis } from "@/lib/hypotheses/schema";
import { assertFindingsSafe, type PriorRound } from "@/lib/hypotheses/findings";

/**
 * In development the static site (:3000) and the Worker (:8787) are separate
 * origins; in production they are the same origin, so this is empty.
 */
const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";

export interface HypothesesResponse {
  hypotheses: Hypothesis[];
  /** Verbatim record of the single exchange, for the user to inspect. */
  exchange: Exchange;
}

export async function requestHypotheses(
  profile: DatabaseProfile,
  priorRounds: PriorRound[] = [],
  signal?: AbortSignal,
): Promise<HypothesesResponse> {
  // Nothing leaves without passing the leak check, exactly as the profile does.
  for (const round of priorRounds) assertFindingsSafe(round.findings as never);

  const res = await fetch(`${API_BASE}/api/hypotheses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile, priorRounds }),
    signal,
  });

  if (!res.ok) {
    const detail = await res
      .json()
      .then((b: { error?: string }) => b.error)
      .catch(() => null);
    throw new Error(detail ?? `Request failed with ${res.status}.`);
  }

  return res.json();
}
