import type { TableProfile } from "@/lib/profile/types";
import type { Exchange, Hypothesis } from "@/lib/hypotheses/schema";

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
  profile: TableProfile,
  signal?: AbortSignal,
): Promise<HypothesesResponse> {
  const res = await fetch(`${API_BASE}/api/hypotheses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile }),
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
