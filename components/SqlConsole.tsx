"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type * as duckdb from "@duckdb/duckdb-wasm";
import type * as arrow from "apache-arrow";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { sql, PostgreSQL } from "@codemirror/lang-sql";
import type { LoadedDatabase } from "@/lib/duckdb/load";
import { columnNames, toJs } from "@/lib/arrow";
import { statementAt } from "@/lib/sql/statements";
import { Modal } from "./Modal";
import { ResultTable, type ResultRows } from "./ResultTable";
import { Spinner } from "./Spinner";

/**
 * Rows on screen at once.
 *
 * The full result stays in Arrow, where DuckDB already put it, and only the
 * visible page is converted to JS objects. Converting all of it to show the
 * first screenful is the expensive half of a large SELECT.
 */
const PAGE_SIZE = 50;

export interface RanQuery {
  title: string;
  sql: string;
}

interface Outcome {
  table: arrow.Table;
  columns: string[];
  rowCount: number;
  ms: number;
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
  const [page, setPage] = useState(0);
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
    setPage(0);
    const started = performance.now();
    // A fresh connection per run: rebuildDatabase re-opens the database when
    // sources change, which invalidates anything held across that.
    const conn = await db.connect();
    try {
      const table = await conn.query(statement);
      setOutcome({
        table,
        columns: columnNames(table),
        rowCount: table.numRows,
        ms: Math.round(performance.now() - started),
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

  // Only this page is turned into JS objects; the rest stays in Arrow.
  const visible: ResultRows | null = useMemo(() => {
    if (!outcome) return null;
    const start = page * PAGE_SIZE;
    const end = Math.min(start + PAGE_SIZE, outcome.rowCount);
    const rows: unknown[][] = [];
    for (let i = start; i < end; i++) {
      const obj = toJs(outcome.table.get(i)) as Record<string, unknown>;
      rows.push(outcome.columns.map((c) => obj[c] ?? null));
    }
    return { columns: outcome.columns, rows };
  }, [outcome, page]);

  const lastPage = outcome ? Math.max(0, Math.ceil(outcome.rowCount / PAGE_SIZE) - 1) : 0;
  const from = outcome ? page * PAGE_SIZE + 1 : 0;
  const to = outcome ? Math.min((page + 1) * PAGE_SIZE, outcome.rowCount) : 0;

  return (
    <Modal
      fill
      open={open}
      title="SQL Console"
      subtitle="DuckDB running in this tab, over the tables you loaded."
      onClose={onClose}
    >
      <div
        className="rounded border hairline overflow-hidden shrink-0"
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

      <div className="flex items-center gap-3 mt-3 flex-wrap shrink-0">
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
          </span>
        )}
      </div>

      {error && (
        <pre className="mt-3 text-xs font-mono whitespace-pre-wrap text-red-600 dark:text-red-400 p-3 rounded border hairline shrink-0">
          {error}
        </pre>
      )}

      {/* The results area takes whatever height is left and scrolls inside it,
          so the dialog itself never changes size between a 3-row and a
          300,000-row result. */}
      {visible && visible.rows.length > 0 && (
        <div className="mt-3 flex-1 min-h-0 flex flex-col">
          <div className="flex-1 min-h-0 overflow-auto">
            <ResultTable preview={visible} />
          </div>

          {outcome && outcome.rowCount > PAGE_SIZE && (
            <div className="flex items-center justify-between gap-3 pt-2 shrink-0">
              <span className="muted text-xs font-mono tabular-nums">
                {from.toLocaleString()}-{to.toLocaleString()} of{" "}
                {outcome.rowCount.toLocaleString()}
              </span>
              <span className="flex items-center gap-1">
                <button
                  onClick={() => setPage((n) => Math.max(0, n - 1))}
                  disabled={page === 0}
                  className="panel rounded-md px-3 py-1 text-sm disabled:opacity-40 hover:ring-2 hover:ring-blue-500/30"
                >
                  Previous
                </button>
                <button
                  onClick={() => setPage((n) => Math.min(lastPage, n + 1))}
                  disabled={page >= lastPage}
                  className="panel rounded-md px-3 py-1 text-sm disabled:opacity-40 hover:ring-2 hover:ring-blue-500/30"
                >
                  Next
                </button>
              </span>
            </div>
          )}
        </div>
      )}

      {visible && visible.rows.length === 0 && !error && (
        <p className="muted text-sm mt-3">The query returned no rows.</p>
      )}
    </Modal>
  );
}
