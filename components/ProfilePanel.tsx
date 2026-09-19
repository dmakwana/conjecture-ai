"use client";

import { useState } from "react";
import type { ColumnProfile, DatabaseProfile, TableProfile } from "@/lib/profile/types";
import { Modal } from "./Modal";
import { IconChevron, IconInspect, IconShield } from "./icons";

function pct(v: number): string {
  if (v === 0) return "0%";
  if (v < 0.01) return "<0.01%";
  return `${v.toFixed(v < 10 ? 2 : 1)}%`;
}

function num(v: number | null): string {
  if (v === null) return "—";
  if (Number.isInteger(v)) return v.toLocaleString();
  return v.toFixed(Math.abs(v) < 1 ? 4 : 2);
}

/** One line of the most decision-relevant statistics for a column. */
function summary(c: ColumnProfile): string {
  if (c.numeric) {
    const parts = [`${num(c.numeric.min)} … ${num(c.numeric.max)}`];
    if (c.numeric.negativeCount > 0) parts.push(`${c.numeric.negativeCount.toLocaleString()} negative`);
    if (c.numeric.zeroCount > 0) parts.push(`${c.numeric.zeroCount.toLocaleString()} zero`);
    if (c.numeric.nonFiniteCount > 0) parts.push(`${c.numeric.nonFiniteCount} NaN/Inf`);
    return parts.join(" · ");
  }
  if (c.temporal) {
    const parts = [`${c.temporal.minISO ?? "—"} … ${c.temporal.maxISO ?? "—"}`];
    if (c.temporal.futureCount > 0) parts.push(`${c.temporal.futureCount.toLocaleString()} future`);
    if (c.temporal.epochZeroCount > 0) parts.push(`${c.temporal.epochZeroCount.toLocaleString()} at epoch`);
    return parts.join(" · ");
  }
  if (c.boolean) {
    return `${c.boolean.trueCount.toLocaleString()} true · ${c.boolean.falseCount.toLocaleString()} false`;
  }
  if (c.string) {
    const parts = [`len ${num(c.string.lenMin)}–${num(c.string.lenMax)}`];
    if (c.string.emptyCount > 0) parts.push(`${c.string.emptyCount.toLocaleString()} empty`);
    if (c.string.untrimmedCount > 0) parts.push(`${c.string.untrimmedCount.toLocaleString()} untrimmed`);
    if (c.string.shapes.length > 0) {
      parts.push(`shapes: ${c.string.shapes.slice(0, 3).map((s) => s.shape).join(", ")}`);
    }
    return parts.join(" · ");
  }
  return "";
}

export function ProfilePanel({ profile }: { profile: DatabaseProfile }) {
  const [openTable, setOpenTable] = useState<string | null>(null);
  const [showPayload, setShowPayload] = useState(false);

  const totalRows = profile.tables.reduce((n, t) => n + t.rowCount, 0);
  const totalCols = profile.tables.reduce((n, t) => n + t.columnCount, 0);

  return (
    <section className="panel rounded-md">
      <header className="flex items-baseline justify-between gap-4 px-4 py-3 border-b hairline flex-wrap">
        <div>
          <span className="font-medium">
            {profile.tables.length} table{profile.tables.length === 1 ? "" : "s"}
          </span>
          <span className="muted text-sm ml-2">
            {totalRows.toLocaleString()} rows · {totalCols} columns · profiled in{" "}
            {profile.profileMs} ms
          </span>
        </div>
        <button
          onClick={() => setShowPayload(true)}
          className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm panel hover:ring-2 hover:ring-blue-500/30"
        >
          <IconInspect />
          Inspect Prompt
        </button>
      </header>

      <ul className="divide-y hairline">
        {profile.tables.map((t) => (
          <li key={t.table}>
            <button
              onClick={() => setOpenTable(openTable === t.table ? null : t.table)}
              className="w-full flex items-baseline gap-3 px-4 py-2 text-left hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
            >
              <IconChevron open={openTable === t.table} className="muted" />
              <code className="font-mono text-xs font-medium">{t.table}</code>
              <span className="muted text-xs flex-1">
                {t.rowCount.toLocaleString()} rows · {t.columnCount} columns · {t.format}
              </span>
              {t.columns.some((c) => c.nullPct > 50) && (
                <span
                  className="text-amber-600 dark:text-amber-400 text-xs"
                  title="At least one column is more than half NULL"
                >
                  Sparse
                </span>
              )}
            </button>
            {openTable === t.table && <ColumnTable table={t} />}
          </li>
        ))}
      </ul>

      <Modal
        open={showPayload}
        title="Inspect Prompt"
        subtitle="The exact request body. This is everything that leaves your browser."
        onClose={() => setShowPayload(false)}
      >
        <p className="muted text-sm mb-3 flex items-start gap-2">
          <IconShield className="mt-0.5 text-emerald-600 dark:text-emerald-400" />
          <span>
            Table and column names, type names and numbers, plus masked format shapes
            where every letter is <code className="font-mono">a</code>/
            <code className="font-mono">A</code> and every digit is{" "}
            <code className="font-mono">9</code>. No cell values.
          </span>
        </p>
        <pre className="text-xs font-mono overflow-auto p-3 rounded border hairline">
          {JSON.stringify(profile, null, 2)}
        </pre>
      </Modal>
    </section>
  );
}

function ColumnTable({ table }: { table: TableProfile }) {
  return (
    <div className="overflow-x-auto border-t hairline">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b hairline muted text-xs">
            <th className="text-left font-medium px-4 py-1.5">Column</th>
            <th className="text-left font-medium px-2 py-1.5">Type</th>
            <th className="text-right font-medium px-2 py-1.5">Nulls</th>
            <th className="text-right font-medium px-2 py-1.5">Distinct</th>
            <th className="text-left font-medium px-2 py-1.5">Summary</th>
          </tr>
        </thead>
        <tbody>
          {table.columns.map((c) => (
            <tr key={c.name} className="border-b hairline last:border-0">
              <td className="px-4 py-1.5 font-mono text-xs">
                {c.name}
                {c.isCandidateKey && (
                  <span
                    className="muted ml-1.5"
                    title="Unique and never null — a possible key"
                  >
                    ★
                  </span>
                )}
              </td>
              <td className="px-2 py-1.5 muted font-mono text-xs">{c.sqlType}</td>
              <td className={`px-2 py-1.5 text-right font-mono text-xs ${c.nullPct > 0 ? "" : "muted"}`}>
                {pct(c.nullPct)}
              </td>
              <td className="px-2 py-1.5 text-right font-mono text-xs muted">
                {c.approxDistinct.toLocaleString()}
              </td>
              <td className="px-2 py-1.5 muted font-mono text-xs">{summary(c)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
