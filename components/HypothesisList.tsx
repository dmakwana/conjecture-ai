"use client";

import { useState } from "react";
import type { Hypothesis, HypothesisResult, Severity } from "@/lib/hypotheses/schema";
import type { ViolationPreview } from "@/lib/hypotheses/evaluate";
import { ViolationTable } from "./ViolationTable";

export interface HypothesisRow {
  hypothesis: Hypothesis;
  result: HypothesisResult | null;
}

const SEVERITY_TONE: Record<Severity, string> = {
  high: "text-red-600 dark:text-red-400",
  medium: "text-amber-600 dark:text-amber-400",
  low: "muted",
};

function checkText(h: Hypothesis): string {
  return h.check.kind === "unique"
    ? `UNIQUE (${h.check.columns.join(", ")})`
    : h.check.expression;
}

function Verdict({ result }: { result: HypothesisResult | null }) {
  if (result === null) {
    return <span className="muted text-xs font-mono">checking…</span>;
  }
  if (result.status === "holds") {
    return (
      <span className="text-emerald-600 dark:text-emerald-400 text-xs font-mono font-semibold">
        HOLDS
      </span>
    );
  }
  if (result.status === "skipped") {
    return <span className="muted text-xs font-mono font-semibold">NOT RUN</span>;
  }
  return (
    <span className="text-red-600 dark:text-red-400 text-xs font-mono font-semibold">
      FALSIFIED
    </span>
  );
}

export function HypothesisList({
  rows,
  onInspect,
}: {
  rows: HypothesisRow[];
  onInspect: (h: Hypothesis) => Promise<ViolationPreview>;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [preview, setPreview] = useState<ViolationPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  async function toggle(h: Hypothesis) {
    if (openId === h.id) {
      setOpenId(null);
      return;
    }
    setOpenId(h.id);
    setPreview(null);
    setPreviewError(null);
    try {
      setPreview(await onInspect(h));
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <ul className="panel rounded-md divide-y hairline">
      {rows.map(({ hypothesis, result }) => {
        const falsified = result?.status === "falsified";
        return (
          <li key={hypothesis.id} className="px-4 py-3">
            <div className="flex items-baseline gap-3">
              <span className="w-20 shrink-0">
                <Verdict result={result} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="font-medium">{hypothesis.title}</span>
                  <span className={`text-xs ${SEVERITY_TONE[hypothesis.severity]}`}>
                    {hypothesis.severity}
                  </span>
                </div>
                <p className="muted text-sm mt-0.5">{hypothesis.rationale}</p>
                <code className="block muted text-xs font-mono mt-1 break-all">
                  {checkText(hypothesis)}
                </code>

                {falsified && result.status === "falsified" && (
                  <div className="mt-2 text-sm">
                    <span className="text-red-600 dark:text-red-400">
                      {result.violations.toLocaleString()} of{" "}
                      {result.rowCount.toLocaleString()} rows ({result.pct.toFixed(2)}%)
                    </span>
                    <button
                      onClick={() => toggle(hypothesis)}
                      className="ml-3 underline underline-offset-2 hover:no-underline"
                    >
                      {openId === hypothesis.id ? "hide rows" : "view rows"}
                    </button>
                  </div>
                )}

                {result?.status === "skipped" && (
                  <p className="muted text-sm mt-1">Could not evaluate: {result.reason}</p>
                )}

                {openId === hypothesis.id && (
                  <div className="mt-3">
                    {previewError && (
                      <p className="text-red-600 dark:text-red-400 text-sm">{previewError}</p>
                    )}
                    {!previewError && !preview && <p className="muted text-sm">Loading rows…</p>}
                    {preview && (
                      <>
                        <p className="muted text-xs mb-1">
                          Shown from local DuckDB. These rows are not sent anywhere.
                        </p>
                        <ViolationTable preview={preview} />
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
