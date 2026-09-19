"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type * as duckdb from "@duckdb/duckdb-wasm";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { sql, PostgreSQL } from "@codemirror/lang-sql";
import type { LoadedDatabase } from "@/lib/duckdb/load";
import { columnNames, toJs } from "@/lib/arrow";
import { statementAt } from "@/lib/sql/statements";
import { Modal } from "./Modal";
import { ResultTable, type ResultRows } from "./ResultTable";
import { Spinner } from "./Spinner";

/** Rows held in the DOM. The query itself is unbounded; only the display is. */
const MAX_DISPLAY_ROWS = 500;

export interface RanQuery {
  title: string;
  sql: string;
}

interface Outcome {
  rows: ResultRows;
  rowCount: number;
  ms: number;
  truncated: boolean;
}

/**
 * Seed the editor with something to react to rather than an empty box.
 *
 * Every check the run already executed is included, commented out, so the user
 * can uncomment one and take it apart instead of retyping it from the summary.
 */
export function buildInitialSql(loaded: LoadedDatabase, ran: RanQuery[]): string {
  const lines: string[] = [
    "-- DuckDB running in this tab. Nothing here leaves your browser.",
    "-- Cmd/Ctrl+Enter runs the statement under the cursor, or the selection.",
    "--",
    "-- Tables:",
    ...loaded.tables.map(
      (t) => `--   ${t.table}(${t.columns.map((c) => c.name).join(", ")})`,
    ),
  ];

  if (ran.length > 0) {
    lines.push("--", "-- Checks already run. Uncomment one to pull it apart:", "--");
    for (const q of ran.slice(0, 25)) {
      lines.push(`-- ${q.title}`);
      lines.push(`-- ${q.sql.replace(/\s+/g, " ").trim()}`);
      lines.push("--");
    }
  }

  lines.push("");
  const first = loaded.tables[0];
  if (first) lines.push(`SELECT * FROM ${first.table} LIMIT 100;`);
  return lines.join("\n");
}

export function SqlConsole({
  open, onClose, getDb, loaded, ranQueries,
}: {
  open: boolean;
  onClose: () => void;
  /** A getter, not the value: the parent holds DuckDB in a ref, and reading a
   *  ref during render is exactly what React warns about. */
  getDb: () => duckdb.AsyncDuckDB | null;
  loaded: LoadedDatabase;
  ranQueries: RanQuery[];
}) {
  const [text, setText] = useState(() => buildInitialSql(loaded, ranQueries));
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  // Read once at mount rather than assigning inside an effect, which would
  // render light first and then immediately re-render dark.
  const [dark, setDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Column names feed CodeMirror's completion, so the schema is discoverable
  // by typing rather than by scrolling back to the profile.
  const extensions = useMemo(() => {
    const schema: Record<string, string[]> = {};
    for (const t of loaded.tables) schema[t.table] = t.columns.map((c) => c.name);
    return [sql({ dialect: PostgreSQL, schema, upperCaseKeywords: true })];
  }, [loaded]);

  const run = useCallback(async () => {
    if (running) return;
    const db = getDb();
    if (!db) {
      setError("DuckDB is not ready yet.");
      return;
    }
    const view = viewRef.current;
    const selection = view?.state.sliceDoc(
      view.state.selection.main.from,
      view.state.selection.main.to,
    );
    const statement =
      selection && selection.trim() !== ""
        ? selection
        : statementAt(text, view?.state.selection.main.head ?? text.length);

    if (!statement) {
      setError("Nothing to run: the editor holds only comments.");
      setOutcome(null);
      return;
    }

    setRunning(true);
    setError(null);
    const started = performance.now();
    // A fresh connection per run: rebuildDatabase re-opens the database when
    // sources change, which invalidates anything held across that.
    const conn = await db.connect();
    try {
      const table = await conn.query(statement);
      const cols = columnNames(table);
      const all = table.toArray();
      const rows = all.slice(0, MAX_DISPLAY_ROWS).map((row) => {
        const obj = toJs(row) as Record<string, unknown>;
        return cols.map((c) => obj[c] ?? null);
      });
      setOutcome({
        rows: { columns: cols, rows },
        rowCount: table.numRows,
        ms: Math.round(performance.now() - started),
        truncated: table.numRows > MAX_DISPLAY_ROWS,
      });
    } catch (err) {
      // The user's own console over their own data, so the engine's full
      // message is the useful thing to show.
      setError(err instanceof Error ? err.message : String(err));
      setOutcome(null);
    } finally {
      await conn.close();
      setRunning(false);
    }
  }, [getDb, running, text]);

  return (
    <Modal
      open={open}
      title="SQL Console"
      subtitle="DuckDB running in this tab, over the tables you loaded."
      onClose={onClose}
    >
      <div
        className="rounded border hairline overflow-hidden"
        // Capture phase, so it fires before CodeMirror's own Enter handling.
        onKeyDownCapture={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void run();
          }
        }}
      >
        <CodeMirror
          value={text}
          onChange={setText}
          onCreateEditor={(view) => {
            viewRef.current = view;
          }}
          height="260px"
          theme={dark ? "dark" : "light"}
          extensions={extensions}
          basicSetup={{ foldGutter: false, highlightActiveLine: false }}
        />
      </div>

      <div className="flex items-center gap-3 mt-3 flex-wrap">
        <button
          onClick={run}
          disabled={running}
          className="inline-flex items-center gap-1.5 rounded-md px-4 py-1.5 text-sm font-medium bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40"
        >
          {running && <Spinner />}
          {running ? "Running" : "Run"}
        </button>
        <span className="muted text-xs">Cmd/Ctrl+Enter</span>
        {outcome && (
          <span className="muted text-sm">
            {outcome.rowCount.toLocaleString()} row
            {outcome.rowCount === 1 ? "" : "s"} · {outcome.ms} ms
            {outcome.truncated && ` · showing the first ${MAX_DISPLAY_ROWS}`}
          </span>
        )}
      </div>

      {error && (
        <pre className="mt-3 text-xs font-mono whitespace-pre-wrap text-red-600 dark:text-red-400 p-3 rounded border hairline">
          {error}
        </pre>
      )}

      {outcome && outcome.rows.rows.length > 0 && (
        <div className="mt-3">
          <ResultTable preview={outcome.rows} />
        </div>
      )}
      {outcome && outcome.rows.rows.length === 0 && !error && (
        <p className="muted text-sm mt-3">The query returned no rows.</p>
      )}
    </Modal>
  );
}
