"use client";

import { useState } from "react";
import type { Exchange } from "@/lib/hypotheses/schema";

type Tab = "request" | "response";

/**
 * The full record of the exchange with Claude. There is exactly one request and
 * one response per run, and `httpAttempts` is measured in the Worker rather
 * than assumed, so the count shown here is the real one.
 */
export function ExchangePanel({ exchange }: { exchange: Exchange }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("response");

  const retried = exchange.httpAttempts > 1;

  return (
    <section className="panel rounded-md">
      <header className="flex items-baseline justify-between gap-4 px-4 py-3 flex-wrap">
        <div className="text-sm">
          <span className="font-medium">Transcript</span>
          <span className="muted ml-2">
            {exchange.httpAttempts} request{exchange.httpAttempts === 1 ? "" : "s"} ·{" "}
            1 response · {exchange.model} ·{" "}
            {exchange.inputTokens.toLocaleString()} in /{" "}
            {exchange.outputTokens.toLocaleString()} out ·{" "}
            {(exchange.latencyMs / 1000).toFixed(1)}s
          </span>
        </div>
        <button
          onClick={() => setOpen((v) => !v)}
          className="text-sm underline underline-offset-2 hover:no-underline"
        >
          {open ? "hide" : "read it"}
        </button>
      </header>

      {retried && (
        <p className="muted text-xs px-4 pb-2">
          More than one request means the SDK resent the same query after a
          transient failure — not an extra question.
        </p>
      )}

      {open && (
        <div className="border-t hairline">
          <div className="flex gap-1 px-4 pt-3 text-sm">
            {(["request", "response"] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-1 rounded-t-md ${
                  tab === t ? "panel border-b-0 font-medium" : "muted"
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          <div className="px-4 pb-4">
            {tab === "request" ? (
              <>
                <p className="muted text-xs my-2">
                  Sent verbatim. The profile below is the only data in it — no cell
                  values, and no tools are declared, so the model cannot ask for a
                  second turn.
                </p>
                <Block label="system" body={exchange.system} />
                <Block label="user" body={exchange.userMessage} />
              </>
            ) : (
              <>
                <p className="muted text-xs my-2">
                  The model&apos;s structured output, exactly as returned
                  {exchange.stopReason ? ` (stop_reason: ${exchange.stopReason})` : ""}.
                  {" "}
                  {exchange.hypothesesReturned} hypothes
                  {exchange.hypothesesReturned === 1 ? "is" : "es"} returned.
                </p>
                <Block label="response" body={exchange.responseJson} />
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function Block({ label, body }: { label: string; body: string }) {
  return (
    <div className="mt-2">
      <div className="muted text-xs font-mono mb-1">{label}</div>
      <pre className="text-xs font-mono whitespace-pre-wrap break-words overflow-auto max-h-80 p-3 rounded border hairline">
        {body}
      </pre>
    </div>
  );
}
