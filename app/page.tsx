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
import {
  assertFindingsSafe, knownIdentifiers, toFinding,
  type Finding, type PriorRound,
} from "@/lib/hypotheses/findings";
import { MAX_ROUNDS } from "@/worker/prompt";
import { buildMarkdownReport, reportFilename } from "@/lib/report";
import { ProfilePanel } from "@/components/ProfilePanel";
import { HypothesisList, type HypothesisRow } from "@/components/HypothesisList";
import { ExchangePanel } from "@/components/ExchangePanel";
import { SourceManager, type SourceSummary } from "@/components/SourceManager";
import { DemoPicker } from "@/components/DemoPicker";
import { ThinkingDots } from "@/components/Spinner";
import { IconCode, IconDownload } from "@/components/icons";
import dynamic from "next/dynamic";

// CodeMirror is browser-only and sizeable, so it is kept out of the initial
// bundle and out of the prerender.
const SqlConsole = dynamic(
  () => import("@/components/SqlConsole").then((m) => m.SqlConsole),
  { ssr: false },
);
import { DEFAULT_DEMO, demoById, type DemoId } from "@/lib/demo";

interface Source extends SourceInput {
  id: string;
}

type Phase = "idle" | "adding" | "rebuilding" | "ready" | "thinking" | "testing";

/** Demo is the landing mode: a curated dataset beats an empty box. */
type Mode = "demo" | "own";

export default function Page() {
  const [mode, setMode] = useState<Mode>("demo");
  const [demoId, setDemoId] = useState<DemoId>(DEFAULT_DEMO);
  const [loadedDemo, setLoadedDemo] = useState<DemoId | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [loaded, setLoaded] = useState<LoadedDatabase | null>(null);
  const [profile, setProfile] = useState<DatabaseProfile | null>(null);
  const [rows, setRows] = useState<HypothesisRow[]>([]);
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [priorRounds, setPriorRounds] = useState<PriorRound[]>([]);
  const [sqlOpen, setSqlOpen] = useState(false);

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
   * database is rebuilt wholesale rather than mutated. See rebuildDatabase.
   */
  /**
   * Drop everything derived from the data currently loaded.
   *
   * Called before a load starts rather than when the new profile arrives,
   * otherwise the previous tables and findings stay on screen through the
   * download and profiling and read as though they describe the new data.
   */
  const clearDerived = useCallback(() => {
    setLoaded(null);
    setProfile(null);
    setRows([]);
    setExchanges([]);
    setPriorRounds([]);
  }, []);

  const rebuild = useCallback(async (next: Source[]) => {
    setError(null);
    clearDerived();

    if (next.length === 0) {
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
  }, [clearDerived]);

  /**
   * Load a bundled dataset. These are same-origin and known-good, so they skip
   * the CORS/format validation that user-supplied URLs need.
   */
  const loadDemo = useCallback(
    async (id: DemoId) => {
      setReport(null);
      setError(null);
      setLoadedDemo(null);
      try {
        setPhase("adding");
        clearDerived();
        const dataset = demoById(id);
        const { fetchWithProgress } = await import("@/lib/duckdb/load");

        const next: Source[] = [];
        for (const [i, file] of dataset.files.entries()) {
          const label = file.path.split("/").pop() ?? file.table;
          setStatus(
            `Downloading ${dataset.name}: ${label} (${i + 1} of ${dataset.files.length})…`,
          );
          const bytes = await fetchWithProgress(file.path);
          next.push({
            id: `${id}:${file.table}`,
            table: file.table,
            label,
            format: file.format,
            bytes,
          });
        }

        setSources(next);
        await rebuild(next);
        setLoadedDemo(id);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setPhase("idle");
        setStatus("");
      }
    },
    [rebuild, clearDerived],
  );

  const switchMode = useCallback(
    async (next: Mode) => {
      if (next === mode) return;
      setMode(next);
      setError(null);
      setReport(null);
      setLoadedDemo(null);
      setSources([]);
      await rebuild([]);
    },
    [mode, rebuild],
  );

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

        // Past validation, so we are committed to loading: drop the old tables
        // now rather than after the download, but not before, or a typo in a
        // URL would wipe data that is perfectly good.
        clearDerived();

        const { fetchWithProgress } = await import("@/lib/duckdb/load");
        const bytes = await fetchWithProgress(url, (p) =>
          setStatus(
            p.total
              ? `Downloading… ${formatBytes(p.loaded)} of ${formatBytes(p.total)}`
              : `Downloading… ${formatBytes(p.loaded)}`,
          ),
        );

        // validateSource may have learned the real size from Content-Range. If
        // so, hold the download to it: a short read is otherwise invisible
        // until DuckDB chokes on the missing footer.
        const { verifyDownload } = await import("@/lib/sources/validate");
        const short = verifyDownload(bytes, validation.format, validation.sizeBytes);
        if (short) throw new Error(short);

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
    [sources, rebuild, clearDerived],
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
        clearDerived();
        setSources(next);
        await rebuild(next);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setPhase(sources.length > 0 ? "ready" : "idle");
        setStatus("");
      }
    },
    [sources, rebuild, clearDerived],
  );

  const removeSource = useCallback(
    async (id: string) => {
      const next = sources.filter((s) => s.id !== id);
      setSources(next);
      setLoadedDemo(null);
      await rebuild(next);
    },
    [sources, rebuild],
  );

  /**
   * Run one round. Round 1 sees only the profile; later rounds also receive the
   * verdicts of everything already tested, so the model can narrow down what
   * failed instead of guessing again from scratch.
   */
  const runRound = useCallback(async () => {
    if (!profile || !loaded || !schema || !dbRef.current) return;
    if (priorRounds.length >= MAX_ROUNDS) return;

    setError(null);
    setPhase("thinking");
    setStatus("");

    const round = priorRounds.length + 1;

    try {
      // One request, one response per round. See worker/hypotheses.ts.
      const response = await requestHypotheses(profile, priorRounds);
      setExchanges((prev) => [...prev, response.exchange]);

      // Ids are assigned per response, so round 2 would hand out h1 again and
      // collide with round 1, breaking React keys and result routing alike.
      const hypotheses = response.hypotheses.map((h, i) => ({
        ...h,
        id: `r${round}h${i + 1}`,
      }));

      // Append rather than replace: earlier rounds stay visible, since a
      // follow-up only makes sense read against what came before.
      setRows((prev) => [
        ...prev,
        ...hypotheses.map((h) => ({
          round, hypothesis: h, result: null, running: false,
        })),
      ]);
      setPhase("testing");

      const known = knownIdentifiers(loaded.tables);
      const findings: Finding[] = [];

      await evaluateAllHypotheses(
        dbRef.current, hypotheses, schema, rowCounts,
        {
          onStart: (id) =>
            setRows((prev) =>
              prev.map((r) => (r.hypothesis.id === id ? { ...r, running: true } : r)),
            ),
          onResult: (id, result) => {
            setRows((prev) =>
              prev.map((r) =>
                r.hypothesis.id === id ? { ...r, result, running: false } : r,
              ),
            );
            const h = hypotheses.find((x) => x.id === id);
            if (h) findings.push(toFinding(h, result, known));
          },
        },
      );

      // Assert before storing, not just before sending, so a leak surfaces here
      // rather than one round later.
      setPriorRounds((prev) => [
        ...prev,
        { round, findings: assertFindingsSafe(findings) as never },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPhase("ready");
      setStatus("");
    }
  }, [profile, loaded, schema, rowCounts, priorRounds]);

  /**
   * Download the run as Markdown. Nothing here is persisted, so a saved file is
   * the only record that outlives the tab.
   */
  const downloadReport = useCallback(() => {
    if (!profile || !loaded) return;
    const markdown = buildMarkdownReport({
      profile,
      loaded,
      rows,
      // Only when the data is one of ours; a file the user supplied is theirs
      // to credit, not ours to guess at.
      attribution: mode === "demo" && loadedDemo ? demoById(loadedDemo).attribution : null,
    });
    const url = URL.createObjectURL(
      new Blob([markdown], { type: "text/markdown;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = reportFilename();
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke on the next tick; revoking synchronously can cancel the download.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [profile, loaded, rows, mode, loadedDemo]);

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
        <h1 className="text-xl font-semibold tracking-tight">conjecture-ai</h1>
        <p className="muted text-sm mt-1">
          Profile your data, then test falsifiable hypotheses about it. Everything runs
          entirely in your browser: nothing is uploaded, and your data never leaves this
          page.
        </p>
      </header>

      <nav className="flex gap-1 text-sm" role="tablist">
        {(["demo", "own"] as Mode[]).map((m) => (
          <button
            key={m}
            role="tab"
            aria-selected={mode === m}
            onClick={() => switchMode(m)}
            disabled={busy}
            className={`px-3 py-1.5 rounded-md transition disabled:opacity-50 ${
              mode === m ? "panel font-medium" : "muted hover:underline"
            }`}
          >
            {m === "demo" ? "Demo Data" : "Your Own Data"}
          </button>
        ))}
      </nav>

      {mode === "demo" ? (
        <DemoPicker
          selected={demoId}
          busy={busy}
          loadedId={loadedDemo}
          onSelect={setDemoId}
          onLoad={loadDemo}
        />
      ) : (
        <SourceManager
          sources={summaries}
          busy={busy}
          report={report}
          onAddUrl={addUrl}
          onAddFiles={addFiles}
          onRemove={removeSource}
        />
      )}

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
              onClick={runRound}
              disabled={busy || priorRounds.length >= MAX_ROUNDS}
              className="rounded-md px-4 py-2 text-sm font-medium bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {priorRounds.length === 0
                ? "Find invariants"
                : `Dig deeper (round ${priorRounds.length + 1} of ${MAX_ROUNDS})`}
            </button>

            {phase === "thinking" && (
              <span className="text-sm text-blue-600 dark:text-blue-400">
                <ThinkingDots
                  label={
                    priorRounds.length === 0
                      ? "AI is reading the profile…"
                      : "AI is reading the previous results…"
                  }
                />
              </span>
            )}

            {rows.length > 0 && phase !== "thinking" && (
              <span className="muted text-sm">
                {tested} of {rows.length} tested
                {falsified > 0 && ` · ${falsified} falsified`}
                {sqlMs > 0 && ` · ${sqlMs} ms of SQL`}
              </span>
            )}

            {!busy && (
              <button
                onClick={() => setSqlOpen(true)}
                className="panel inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm hover:ring-2 hover:ring-blue-500/30"
              >
                <IconCode />
                SQL Console
              </button>
            )}

            {rows.length > 0 && !busy && (
              <button
                onClick={downloadReport}
                className="panel inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm hover:ring-2 hover:ring-blue-500/30"
              >
                <IconDownload />
                Export Report
              </button>
            )}

            {priorRounds.length >= MAX_ROUNDS && (
              <span className="muted text-xs">
                {MAX_ROUNDS} rounds is the limit
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

      {loaded && (
        <SqlConsole
          open={sqlOpen}
          onClose={() => setSqlOpen(false)}
          getDb={() => dbRef.current}
          loaded={loaded}
          ranQueries={rows
            .filter((r) => r.result?.sql)
            .map((r) => ({ title: r.hypothesis.title, sql: r.result!.sql! }))}
        />
      )}

      {exchanges.length > 0 && <ExchangePanel exchanges={exchanges} />}

      {rows.length > 0 && <HypothesisList rows={rows} onInspect={inspect} />}
    </main>
  );
}
