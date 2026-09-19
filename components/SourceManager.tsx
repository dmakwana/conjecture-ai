"use client";

import { useRef, useState } from "react";
import type { ValidationReport } from "@/lib/sources/validate";
import { formatBytes } from "@/lib/sources/validate";
import { ValidationChecklist } from "./ValidationChecklist";
import { IconClose, IconPlus } from "./icons";

/**
 * A working example for the tip below. jsDelivr rather than raw.githubusercontent
 * because it supports range requests and sends a real content type; the GitHub
 * page URL serves HTML and would fail the format check.
 */
const EXAMPLE_URL =
  "https://cdn.jsdelivr.net/npm/vega-datasets@3/data/seattle-weather.csv";

export interface SourceSummary {
  id: string;
  table: string;
  label: string;
  rowCount: number;
  columnCount: number;
  bytes: number;
}


/**
 * Adding data is a choice between a URL and a file, so neither input is shown
 * until one is picked. An always-visible URL box implies the URL is the only
 * way in.
 */
export function SourceManager({
  sources,
  busy,
  report,
  onAddUrl,
  onAddFiles,
  onRemove,
}: {
  sources: SourceSummary[];
  busy: boolean;
  report: ValidationReport | null;
  onAddUrl: (url: string) => void;
  onAddFiles: (files: File[]) => void;
  onRemove: (id: string) => void;
}) {
  const [mode, setMode] = useState<"none" | "url">("none");
  const [url, setUrl] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const submitUrl = () => {
    const target = url.trim();
    if (target === "" || busy) return;
    onAddUrl(target);
    setUrl("");
    setMode("none");
  };

  return (
    <section
      className={`space-y-3 rounded-md ${dragging ? "outline-2 outline-dashed outline-blue-500/60 outline-offset-4" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        if (!busy) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (busy) return;
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) onAddFiles(files);
      }}
    >
      {sources.length > 0 && (
        <ul className="panel rounded-md divide-y hairline text-sm">
          {sources.map((s) => (
            <li key={s.id} className="flex items-baseline gap-3 px-3 py-2">
              <code className="font-mono text-xs font-medium">{s.table}</code>
              <span className="muted text-xs truncate flex-1" title={s.label}>
                {s.label}
              </span>
              <span className="muted text-xs whitespace-nowrap">
                {s.rowCount.toLocaleString()} rows · {s.columnCount} cols ·{" "}
                {formatBytes(s.bytes)}
              </span>
              <button
                onClick={() => onRemove(s.id)}
                disabled={busy}
                className="muted rounded p-1 hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40"
                aria-label={`Remove ${s.table}`}
                title={`Remove ${s.table}`}
              >
                <IconClose className="w-3 h-3" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {mode === "url" ? (
        <div className="flex gap-2">
          <input
            autoFocus
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitUrl();
              if (e.key === "Escape") setMode("none");
            }}
            placeholder="https://example.com/data.parquet"
            spellCheck={false}
            className="panel flex-1 rounded-md px-3 py-2 text-sm font-mono outline-none focus:ring-2 focus:ring-blue-500/40"
          />
          <button
            onClick={submitUrl}
            disabled={busy || url.trim() === ""}
            className="rounded-md px-4 py-2 text-sm font-medium bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Add
          </button>
          <button
            onClick={() => setMode("none")}
            className="muted rounded-md px-2 py-2 text-sm hover:underline"
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setMode("url")}
            disabled={busy}
            className="panel inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm hover:ring-2 hover:ring-blue-500/30 disabled:opacity-40"
          >
            <IconPlus /> From a URL
          </button>
          <button
            onClick={() => fileInput.current?.click()}
            disabled={busy}
            className="panel inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm hover:ring-2 hover:ring-blue-500/30 disabled:opacity-40"
          >
            <IconPlus /> From a file
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept=".parquet,.csv,.tsv,.json,.ndjson,.jsonl"
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length > 0) onAddFiles(files);
              e.target.value = "";
            }}
          />
          <span className="muted text-xs">
            Parquet, CSV or JSON. Drop files anywhere; add several to test across them.
          </span>
        </div>
      )}

      {mode === "none" && (
        <p className="muted text-xs leading-relaxed">
          Looking for something to try?{" "}
          <a
            href="https://github.com/vega/vega-datasets/tree/main/data"
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-2 hover:no-underline"
          >
            vega-datasets
          </a>{" "}
          has around sixty small public datasets. Browse there, then load the file
          through its CDN rather than the GitHub page, which serves HTML:{" "}
          <button
            onClick={() => onAddUrl(EXAMPLE_URL)}
            disabled={busy}
            className="font-mono underline underline-offset-2 hover:no-underline disabled:opacity-40"
            title="Load this dataset now"
          >
            {EXAMPLE_URL.replace("https://", "")}
          </button>{" "}
          Swap the filename for any other in that folder.
        </p>
      )}

      {report && !report.ok && <ValidationChecklist checks={report.checks} />}
    </section>
  );
}
