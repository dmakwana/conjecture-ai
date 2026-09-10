"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type * as duckdb from "@duckdb/duckdb-wasm";
import {
  validateSource, formatFromExtension, sniffFormat, formatBytes,
} from "@/lib/sources/validate";
import type { ValidationReport, SourceFormat } from "@/lib/sources/validate";
import type { LoadedDatabase, SourceInput } from "@/lib/duckdb/load";
import { uniqueTableName } from "@/lib/duckdb/tables";
import type { DatabaseProfile } from "@/lib/profile/types";
import type { Exchange, Hypothesis } from "@/lib/hypotheses/schema";
import {
  evaluateAllHypotheses, fetchViolationRows, schemaFrom, type Schema,
} from "@/lib/hypotheses/evaluate";
import { requestHypotheses } from "@/lib/api";
import { ProfilePanel } from "@/components/ProfilePanel";
import { HypothesisList, type HypothesisRow } from "@/components/HypothesisList";
import { ExchangePanel } from "@/components/ExchangePanel";
import { SourceManager, type SourceSummary } from "@/components/SourceManager";
import { ThinkingDots } from "@/components/Spinner";

interface Source extends SourceInput {
  id: string;
}

type Phase = "idle" | "adding" | "rebuilding" | "ready" | "thinking" | "testing";

export default function Page() {
  const [sources, setSources] = useState<Source[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [loaded, setLoaded] = useState<LoadedDatabase | null>(null);
  const [profile, setProfile] = useState<DatabaseProfile | null>(null);
  const [rows, setRows] = useState<HypothesisRow[]>([]);
  const [exchange, setExchange] = useState<Exchange | null>(null);

  const dbRef = useRef<duckdb.AsyncDuckDB | null>(null);
  const connRef = useRef<duckdb.AsyncDuckDBConnection | null>(null);

  const busy = phase !== "idle" && phase !== "ready";

  const schema: Schema | null = useMemo(
    () => (loaded ? schemaFrom(loaded.tables) : null),
    [loaded],
  );
  const rowCounts = useMemo(
    () => new Map((loaded?.tables ?? []).map((t) => [t.table, t.rowCount])),
    [loaded],
  );

  /**
   * Rebuild the database from the full source list and re-profile.
   *
   * Every add and remove goes through here. The lockdown that protects against
   * generated SQL reaching the network is irreversible per database, so the
   * database is rebuilt wholesale rather than mutated — see rebuildDatabase.
   */
  const rebuild = useCallback(async (next: Source[]) => {
    setError(null);
    setRows([]);
    setExchange(null);

    if (next.length === 0) {
      setLoaded(null);
      setProfile(null);
      setPhase("idle");
      setStatus("");
      return;
    }

    const { getDuckDB } = await import("@/lib/duckdb/client");
    const { rebuildDatabase } = await import("@/lib/duckdb/load");
    const { profileDatabase } = await import("@/lib/profile/profile");

    setPhase("rebuilding");
    setStatus("Starting DuckDB…");
    const db = await getDuckDB((p) => {
      if (p.bytesTotal > 0) {
        setStatus(`Downloading DuckDB engine… ${Math.round((p.bytesLoaded / p.bytesTotal) * 100)}%`);
      }
    });
    dbRef.current = db;

    // rebuildDatabase re-opens the database, invalidating any open connection.
    if (connRef.current) {
      await connRef.current.close();
      connRef.current = null;
    }

    const db2 = await rebuildDatabase(db, next, (done, total, label) =>
      setStatus(total > 0 ? `Loading ${label} (${done + 1} of ${total})…` : "Loading…"),
    );
    setLoaded(db2);

    connRef.current = await db.connect();
    setStatus("Profiling columns…");
    const prof = await profileDatabase(connRef.current, db2, (done, total, table) =>
      setStatus(`Profiling ${table}… ${Math.round((done / Math.max(1, total)) * 100)}%`),
    );
    setProfile(prof);
    setPhase("ready");
    setStatus("");
  }, []);

  const addUrl = useCallback(
    async (url: string) => {
      setReport(null);
      setError(null);
      try {
        setPhase("adding");
        setStatus("Checking the URL…");
        const validation = await validateSource(url);
        setReport(validation);
        if (!validation.ok || !validation.format) {
          setPhase(sources.length > 0 ? "ready" : "idle");
          setStatus("");
          return;
        }

        const { fetchWithProgress } = await import("@/lib/duckdb/load");
        const bytes = await fetchWithProgress(url, (p) =>
          setStatus(
            p.total
              ? `Downloading… ${formatBytes(p.loaded)} of ${formatBytes(p.total)}`
              : `Downloading… ${formatBytes(p.loaded)}`,
          ),
        );

        const label = decodeURIComponent(new URL(url).pathname.split("/").pop() || url);
        const next = [
          ...sources,
          {
            id: crypto.randomUUID(),
            table: uniqueTableName(label, sources.map((s) => s.table)),
            label,
            format: validation.format,
            bytes,
          },
        ];
        setSources(next);
        await rebuild(next);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setPhase(sources.length > 0 ? "ready" : "idle");
        setStatus("");
      }
    },
    [sources, rebuild],
  );

  const addFiles = useCallback(
    async (files: File[]) => {
      setReport(null);
      setError(null);
      try {
        setPhase("adding");
        const next = [...sources];
        const rejected: string[] = [];

        for (const file of files) {
          setStatus(`Reading ${file.name}…`);
          const bytes = new Uint8Array(await file.arrayBuffer());
          const format: SourceFormat | null =
            sniffFormat(bytes.subarray(0, 1024)) ?? formatFromExtension(file.name);
          if (!format) {
            rejected.push(file.name);
            continue;
          }
          next.push({
            id: crypto.randomUUID(),
            table: uniqueTableName(file.name, next.map((s) => s.table)),
            label: file.name,
            format,
            bytes,
          });
        }

        if (rejected.length > 0) {
          setError(
            `Not Parquet, CSV or JSON, so skipped: ${rejected.join(", ")}.`,
          );
        }
        if (next.length === sources.length) {
          setPhase(sources.length > 0 ? "ready" : "idle");
          setStatus("");
          return;
        }
        setSources(next);
        await rebuild(next);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setPhase(sources.length > 0 ? "ready" : "idle");
        setStatus("");
      }
    },
    [sources, rebuild],
  );

  const removeSource = useCallback(
    async (id: string) => {
      const next = sources.filter((s) => s.id !== id);
      setSources(next);
      await rebuild(next);
    },
    [sources, rebuild],
  );

  const findInvariants = useCallback(async () => {
    if (!profile || !loaded || !schema || !dbRef.current) return;
    setError(null);
    setRows([]);
    setExchange(null);
    setPhase("thinking");
    setStatus("");

    try {
      // One request, one response — see worker/hypotheses.ts.
      const response = await requestHypotheses(profile);
      setExchange(response.exchange);

      // Render every hypothesis immediately, then fill verdicts in as they land
      // rather than making the user wait for the whole batch.
      setRows(response.hypotheses.map((h) => ({ hypothesis: h, result: null, running: false })));
      setPhase("testing");

      await evaluateAllHypotheses(
        dbRef.current, response.hypotheses, schema, rowCounts,
        {
          onStart: (id) =>
            setRows((prev) =>
              prev.map((r) => (r.hypothesis.id === id ? { ...r, running: true } : r)),
            ),
          onResult: (id, result) =>
            setRows((prev) =>
              prev.map((r) =>
                r.hypothesis.id === id ? { ...r, result, running: false } : r,
              ),
            ),
        },
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPhase("ready");
      setStatus("");
    }
  }, [profile, loaded, schema, rowCounts]);

  const inspect = useCallback(
    async (h: Hypothesis) => {
      if (!connRef.current || !schema) throw new Error("No data loaded.");
      return fetchViolationRows(connRef.current, h, schema);
    },
    [schema],
  );

  const summaries: SourceSummary[] = (loaded?.tables ?? []).map((t, i) => ({
    id: sources[i]?.id ?? t.table,
    table: t.table,
    label: t.label,
    rowCount: t.rowCount,
    columnCount: t.columns.length,
    bytes: t.bytes,
  }));

  const tested = rows.filter((r) => r.result !== null).length;
  const falsified = rows.filter((r) => r.result?.status === "falsified").length;
  const sqlMs = rows.reduce(
    (n, r) => n + (r.result && "ms" in r.result ? r.result.ms : 0),
    0,
  );

  return (
    <main className="mx-auto max-w-4xl px-6 py-10 space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">duck-invariant</h1>
        <p className="muted text-sm mt-1">
          Profile your data in the browser, then test falsifiable hypotheses about it.
          The data never leaves this page.
        </p>
      </header>

      <SourceManager
        sources={summaries}
        busy={busy}
        report={report}
        onAddUrl={addUrl}
        onAddFiles={addFiles}
        onRemove={removeSource}
      />

      {status && <p className="muted text-sm font-mono">{status}</p>}

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400 panel rounded-md px-3 py-2">
          {error}
        </p>
      )}

      {profile && (
        <>
          <ProfilePanel profile={profile} />

          <div className="flex items-center gap-4 flex-wrap">
            <button
              onClick={findInvariants}
              disabled={busy}
              className="rounded-md px-4 py-2 text-sm font-medium bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Find invariants
            </button>

            {phase === "thinking" && (
              <span className="text-sm text-blue-600 dark:text-blue-400">
                <ThinkingDots label="AI is reading the profile…" />
              </span>
            )}

            {rows.length > 0 && phase !== "thinking" && (
              <span className="muted text-sm">
                {tested} of {rows.length} tested
                {falsified > 0 && ` · ${falsified} falsified`}
                {sqlMs > 0 && ` · ${sqlMs} ms of SQL`}
              </span>
            )}

            {loaded && loaded.tables.length > 0 && !loaded.externalAccessDisabled && (
              <span className="muted text-xs">
                note: DuckDB would not disable external access on this build
              </span>
            )}
          </div>
        </>
      )}

      {exchange && <ExchangePanel exchange={exchange} />}

      {rows.length > 0 && <HypothesisList rows={rows} onInspect={inspect} />}
    </main>
  );
}
