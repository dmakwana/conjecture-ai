"use client";

import { useState } from "react";
import type { Hypothesis, HypothesisResult, Severity } from "@/lib/hypotheses/schema";
import { isCrossTable, tablesInCheck } from "@/lib/hypotheses/schema";
import type { ViolationPreview } from "@/lib/hypotheses/evaluate";
import { ViolationTable } from "./ViolationTable";
import { Spinner } from "./Spinner";

export interface HypothesisRow {
  hypothesis: Hypothesis;
  /** null until this check has run. */
  result: HypothesisResult | null;
  /** True while its query is in flight. */
  running: boolean;
}

const SEVERITY_TONE: Record<Severity, string> = {
  high: "text-red-600 dark:text-red-400",
  medium: "text-amber-600 dark:text-amber-400",
  low: "muted",
};

/** Human-readable form of the check, before it becomes SQL. */
function checkText(h: Hypothesis): string {
  const c = h.check;
  if (c.kind === "unique") return `UNIQUE (${c.columns.join(", ")}) in ${c.table}`;
  if (c.kind === "references") {
    return `${c.table}(${c.columns.join(", ")}) → ${c.referencesTable}(${c.referencesColumns.join(", ")})`;
  }
  return c.expression;
}

function Verdict({
  result,
  running,
}: {
  result: HypothesisResult | null;
  running: boolean;
}) {
  if (result === null) {
    return running ? (
      <span className="text-blue-600 dark:text-blue-400 text-xs font-mono inline-flex items-center gap-1.5">
        <Spinner />
        running
      </span>
    ) : (
      <span className="muted text-xs font-mono">queued</span>
    );
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
  const [openRows, setOpenRows] = useState<string | null>(null);
  const [openSql, setOpenSql] = useState<string | null>(null);
  const [preview, setPreview] = useState<ViolationPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  async function toggleRows(h: Hypothesis) {
    if (openRows === h.id) {
      setOpenRows(null);
      return;
    }
    setOpenRows(h.id);
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
      {rows.map(({ hypothesis, result, running }) => {
        const cross = isCrossTable(hypothesis.check);
        return (
          <li
            key={hypothesis.id}
            className={`px-4 py-3 transition-opacity ${
              result === null && !running ? "opacity-60" : ""
            }`}
          >
            <div className="flex items-baseline gap-3">
              <span className="w-20 shrink-0">
                <Verdict result={result} running={running} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="font-medium">{hypothesis.title}</span>
                  <span className={`text-xs ${SEVERITY_TONE[hypothesis.severity]}`}>
                    {hypothesis.severity}
                  </span>
                  {cross && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-blue-600/10 text-blue-700 dark:text-blue-300">
                      cross-table
                    </span>
                  )}
                  <span className="muted text-xs font-mono">
                    {tablesInCheck(hypothesis.check).join(" · ")}
                  </span>
                </div>

                <p className="muted text-sm mt-0.5">{hypothesis.rationale}</p>
                <code className="block muted text-xs font-mono mt-1 break-all">
                  {checkText(hypothesis)}
                </code>

                <div className="mt-1.5 text-sm flex items-baseline gap-3 flex-wrap">
                  {result?.status === "falsified" && (
                    <>
                      <span className="text-red-600 dark:text-red-400">
                        {result.violations.toLocaleString()} of{" "}
                        {result.rowCount.toLocaleString()} rows ({result.pct.toFixed(2)}%)
                      </span>
                      <button
                        onClick={() => toggleRows(hypothesis)}
                        className="underline underline-offset-2 hover:no-underline"
                      >
                        {openRows === hypothesis.id ? "hide rows" : "view rows"}
                      </button>
                    </>
                  )}

                  {result?.status === "skipped" && (
                    <span className="muted">Could not evaluate: {result.reason}</span>
                  )}

                  {result && "ms" in result && (
                    <span className="muted text-xs font-mono">SQL {result.ms} ms</span>
                  )}
                  {result?.sql && (
                    <button
                      onClick={() =>
                        setOpenSql(openSql === hypothesis.id ? null : hypothesis.id)
                      }
                      className="muted text-xs underline underline-offset-2 hover:no-underline"
                    >
                      {openSql === hypothesis.id ? "hide SQL" : "show SQL"}
                    </button>
                  )}
                </div>

                {openSql === hypothesis.id && result?.sql && (
                  <pre className="mt-2 text-xs font-mono whitespace-pre-wrap break-words p-3 rounded border hairline">
                    {result.sql}
                  </pre>
                )}

                {openRows === hypothesis.id && (
                  <div className="mt-3">
                    {previewError && (
                      <p className="text-red-600 dark:text-red-400 text-sm">{previewError}</p>
                    )}
                    {!previewError && !preview && (
                      <p className="muted text-sm">Loading rows…</p>
                    )}
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
