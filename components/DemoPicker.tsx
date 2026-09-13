"use client";

import { DEMO_DATASETS, type DemoId } from "@/lib/demo";
import { formatBytes } from "@/lib/sources/validate";

/**
 * The landing experience. A curated dataset is pre-selected so the tool can be
 * tried in one click, but loading still needs that click: the engine plus the
 * commerce data is tens of megabytes, and downloading it unasked would be rude
 * on a metered connection.
 */
export function DemoPicker({
  selected,
  busy,
  loadedId,
  onSelect,
  onLoad,
}: {
  selected: DemoId;
  busy: boolean;
  loadedId: DemoId | null;
  onSelect: (id: DemoId) => void;
  onLoad: (id: DemoId) => void;
}) {
  const dataset = DEMO_DATASETS.find((d) => d.id === selected)!;
  const isLoaded = loadedId === selected;

  return (
    <section className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-3">
        {DEMO_DATASETS.map((d) => {
          const active = d.id === selected;
          return (
            <button
              key={d.id}
              onClick={() => onSelect(d.id)}
              disabled={busy}
              aria-pressed={active}
              className={`panel rounded-md px-3 py-2.5 text-left transition disabled:opacity-50 ${
                active
                  ? "ring-2 ring-blue-500/60"
                  : "hover:ring-2 hover:ring-blue-500/20"
              }`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium text-sm">{d.name}</span>
                {loadedId === d.id && (
                  <span className="text-emerald-600 dark:text-emerald-400 text-xs">
                    loaded
                  </span>
                )}
              </div>
              <div className="muted text-xs mt-0.5">
                {d.files.length} table{d.files.length === 1 ? "" : "s"} ·{" "}
                {d.approxRows.toLocaleString()} rows · {formatBytes(d.approxBytes)}
              </div>
            </button>
          );
        })}
      </div>

      <div className="panel rounded-md px-4 py-3">
        <p className="text-sm">{dataset.blurb}</p>
        <p className="muted text-sm mt-1">
          <span className="font-medium">What to look for: </span>
          {dataset.lookFor}
        </p>
        <div className="mt-3 flex items-center gap-3 flex-wrap">
          <button
            onClick={() => onLoad(dataset.id)}
            disabled={busy || isLoaded}
            className="rounded-md px-4 py-2 text-sm font-medium bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isLoaded ? `${dataset.name} loaded` : `Load ${dataset.name}`}
          </button>
          <span className="muted text-xs">
            Runs entirely in your browser. Nothing is uploaded.
          </span>
        </div>
      </div>
    </section>
  );
}
