"use client";

import { useCallback, useRef, useState } from "react";
import type * as duckdb from "@duckdb/duckdb-wasm";
import { validateSource, formatFromExtension, sniffFormat, formatBytes } from "@/lib/sources/validate";
import type { ValidationReport, SourceFormat } from "@/lib/sources/validate";
import type { LoadedTable } from "@/lib/duckdb/load";
import type { TableProfile } from "@/lib/profile/types";
import type { Exchange, Hypothesis } from "@/lib/hypotheses/schema";
import { evaluateAllHypotheses, fetchViolationRows } from "@/lib/hypotheses/evaluate";
import { requestHypotheses } from "@/lib/api";
import { ValidationChecklist } from "@/components/ValidationChecklist";
import { ProfilePanel } from "@/components/ProfilePanel";
import { HypothesisList, type HypothesisRow } from "@/components/HypothesisList";
import { ExchangePanel } from "@/components/ExchangePanel";

const DEMO_URL = "https://shell.duckdb.org/data/tpch/0_01/parquet/lineitem.parquet";

type Phase =
  | "idle" | "validating" | "loading" | "profiling"
  | "ready" | "hypothesizing" | "testing";

export default function Page() {
  const [url, setUrl] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [loaded, setLoaded] = useState<LoadedTable | null>(null);
  const [profile, setProfile] = useState<TableProfile | null>(null);
  const [rows, setRows] = useState<HypothesisRow[]>([]);
  const [exchange, setExchange] = useState<Exchange | null>(null);
  const dbRef = useRef<duckdb.AsyncDuckDB | null>(null);

  const connRef = useRef<duckdb.AsyncDuckDBConnection | null>(null);
  const busy = phase !== "idle" && phase !== "ready";

  const reset = () => {
    setError(null);
    setProfile(null);
    setLoaded(null);
    setRows([]);
    setExchange(null);
  };

  /** Shared tail of both entry points: boot DuckDB, load bytes, profile. */
  const ingest = useCallback(
    async (bytes: Uint8Array, format: SourceFormat, label: string) => {
      const { getDuckDB } = await import("@/lib/duckdb/client");
      const { loadIntoDuckDB } = await import("@/lib/duckdb/load");
      const { profileTable } = await import("@/lib/profile/profile");

      setPhase("loading");
      setStatus("Starting DuckDB…");
      const db = await getDuckDB((p) => {
        if (p.bytesTotal > 0) {
          setStatus(
            `Downloading DuckDB engine… ${Math.round((p.bytesLoaded / p.bytesTotal) * 100)}%`,
          );
        }
      });

      setStatus("Loading into DuckDB…");
      // loadIntoDuckDB re-opens the database, which invalidates any connection
      // held for the previous dataset, so release it first.
      if (connRef.current) {
        await connRef.current.close();
        connRef.current = null;
      }
      const table = await loadIntoDuckDB(db, { bytes, format, label });
      setLoaded(table);
      dbRef.current = db;
      connRef.current = await db.connect();

      setPhase("profiling");
      const prof = await profileTable(connRef.current, table, (done, total) =>
        setStatus(`Profiling columns… ${done}/${total}`),
      );
      setProfile(prof);
      setPhase("ready");
      setStatus("");
    },
    [],
  );

  const loadUrl = useCallback(async () => {
    reset();
    setReport(null);
    const target = url.trim();
    if (target === "") return;

    try {
      setPhase("validating");
      setStatus("Checking the URL…");
      const validation = await validateSource(target);
      setReport(validation);
      if (!validation.ok || !validation.format) {
        setPhase("idle");
        setStatus("");
        return;
      }

      const { fetchWithProgress } = await import("@/lib/duckdb/load");
      setPhase("loading");
      const bytes = await fetchWithProgress(target, (p) =>
        setStatus(
          p.total
            ? `Downloading data… ${formatBytes(p.loaded)} of ${formatBytes(p.total)}`
            : `Downloading data… ${formatBytes(p.loaded)}`,
        ),
      );

      const label = decodeURIComponent(new URL(target).pathname.split("/").pop() || "data");
      await ingest(bytes, validation.format, label);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("idle");
      setStatus("");
    }
  }, [url, ingest]);

  const loadFile = useCallback(
    async (file: File) => {
      reset();
      setReport(null);
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const format = sniffFormat(bytes.subarray(0, 1024)) ?? formatFromExtension(file.name);
        if (!format) {
          setError(`Could not tell what kind of file "${file.name}" is.`);
          return;
        }
        await ingest(bytes, format, file.name);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setPhase("idle");
        setStatus("");
      }
    },
    [ingest],
  );

  const findInvariants = useCallback(async () => {
    if (!profile || !loaded || !dbRef.current) return;
    setError(null);
    setRows([]);
    setExchange(null);
    setPhase("hypothesizing");
    setStatus("Asking Claude for hypotheses…");

    try {
      // One request, one response — see worker/hypotheses.ts.
      const response = await requestHypotheses(profile);
      setExchange(response.exchange);

      // Render every hypothesis immediately, then fill verdicts in as they land
      // rather than making the user wait for the whole batch.
      setRows(
        response.hypotheses.map((h) => ({ hypothesis: h, result: null, running: false })),
      );
      setStatus("");
      setPhase("testing");

      await evaluateAllHypotheses(
        dbRef.current,
        response.hypotheses,
        loaded.columns.map((c) => c.name),
        loaded.rowCount,
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
  }, [profile, loaded]);

  const inspect = useCallback(
    async (h: Hypothesis) => {
      if (!connRef.current || !loaded) throw new Error("No table loaded.");
      return fetchViolationRows(connRef.current, h, loaded.columns.map((c) => c.name));
    },
    [loaded],
  );

  const falsified = rows.filter((r) => r.result?.status === "falsified").length;
  const tested = rows.filter((r) => r.result !== null).length;

  return (
    <main className="mx-auto max-w-4xl px-6 py-10 space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">duck-invariant</h1>
        <p className="muted text-sm mt-1">
          Profile a dataset in your browser, then test falsifiable hypotheses about it.
          The data never leaves this page.
        </p>
      </header>

      <section className="space-y-2">
        <div className="flex gap-2">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !busy && loadUrl()}
            placeholder="https://example.com/data.parquet"
            spellCheck={false}
            className="panel flex-1 rounded-md px-3 py-2 text-sm font-mono outline-none focus:ring-2 focus:ring-blue-500/40"
          />
          <button
            onClick={loadUrl}
            disabled={busy || url.trim() === ""}
            className="rounded-md px-4 py-2 text-sm font-medium bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Load
          </button>
        </div>

        <div className="flex items-center gap-3 text-sm muted flex-wrap">
          <button onClick={() => setUrl(DEMO_URL)} disabled={busy} className="underline underline-offset-2 hover:no-underline disabled:opacity-40">
            use a sample parquet
          </button>
          <span>or</span>
          <label className="underline underline-offset-2 hover:no-underline cursor-pointer">
            choose a local file
            <input
              type="file"
              accept=".parquet,.csv,.tsv,.json,.ndjson,.jsonl"
              className="hidden"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) loadFile(file);
                e.target.value = "";
              }}
            />
          </label>
          <span className="muted">Parquet, CSV or JSON.</span>
        </div>
      </section>

      {report && <ValidationChecklist checks={report.checks} />}

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
            {rows.length > 0 && (
              <span className="muted text-sm">
                {tested} of {rows.length} tested
                {falsified > 0 && ` · ${falsified} falsified`}
              </span>
            )}
            {loaded && !loaded.externalAccessDisabled && (
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
