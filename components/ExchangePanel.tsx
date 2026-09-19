"use client";

import { useState } from "react";
import type { Exchange } from "@/lib/hypotheses/schema";
import { Modal } from "./Modal";
import { IconInspect } from "./icons";

type Tab = "request" | "response";

/**
 * The full record of the exchange with Claude. There is exactly one request and
 * one response per run, and `httpAttempts` is measured in the Worker rather
 * than assumed, so the count shown here is the real one.
 */
export function ExchangePanel({ exchanges }: { exchanges: Exchange[] }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("response");
  const [round, setRound] = useState(0);

  const index = Math.min(round, exchanges.length - 1);
  const exchange = exchanges[index];
  const totalAttempts = exchanges.reduce((n, e) => n + e.httpAttempts, 0);
  const retried = exchange.httpAttempts > 1;

  return (
    <section className="panel rounded-md">
      <header className="flex items-baseline justify-between gap-4 px-4 py-3 flex-wrap">
        <div className="text-sm">
          <span className="font-medium">Transcript</span>
          <span className="muted ml-2">
            {exchanges.length} round{exchanges.length === 1 ? "" : "s"} ·{" "}
            {totalAttempts} request{totalAttempts === 1 ? "" : "s"} ·{" "}
            {exchanges.length} response{exchanges.length === 1 ? "" : "s"}
          </span>
        </div>
        <button
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm panel hover:ring-2 hover:ring-blue-500/30"
        >
          <IconInspect />
          Inspect Exchange
        </button>
      </header>

      <Modal
        open={open}
        title="Inspect Exchange"
        subtitle="Recorded verbatim — exactly what was asked, and exactly what came back."
        onClose={() => setOpen(false)}
      >
        {exchanges.length > 1 && (
          <div className="flex items-center gap-1 mb-3">
            <span className="muted text-xs mr-1">Round</span>
            {exchanges.map((e, i) => (
              <button
                key={e.round}
                onClick={() => setRound(i)}
                aria-pressed={i === index}
                className={`px-2.5 py-1 rounded text-sm ${
                  i === index ? "panel font-medium ring-1 ring-blue-500/40" : "muted"
                }`}
              >
                {e.round}
              </button>
            ))}
          </div>
        )}

        <p className="muted text-xs mb-3">
          Round {exchange.round} · {exchange.inputTokens.toLocaleString()} in /{" "}
          {exchange.outputTokens.toLocaleString()} out ·{" "}
          {(exchange.latencyMs / 1000).toFixed(1)}s · {exchange.httpAttempts} HTTP
          request{exchange.httpAttempts === 1 ? "" : "s"}
          {retried &&
            " — more than one means the same query was resent after a transient failure, not a second question."}
        </p>

        <div className="flex gap-1 mb-3">
          {(["request", "response"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              aria-pressed={tab === t}
              className={`px-3 py-1 rounded text-sm ${
                tab === t ? "panel font-medium ring-1 ring-blue-500/40" : "muted"
              }`}
            >
              {t === "request" ? "Request" : "Response"}
            </button>
          ))}
        </div>

        {tab === "request" ? (
          <>
            <p className="muted text-xs mb-2">
              No cell values, and no tools are declared, so the model cannot ask for a
              second turn.
              {exchange.round > 1 &&
                " Earlier rounds' verdicts are included as counts and percentages only."}
            </p>
            <Block label="System" body={exchange.system} />
            <Block label="User" body={exchange.userMessage} />
          </>
        ) : (
          <>
            <p className="muted text-xs mb-2">
              Structured output, exactly as returned
              {exchange.stopReason ? ` (stop_reason: ${exchange.stopReason})` : ""}.{" "}
              {exchange.hypothesesReturned} hypothes
              {exchange.hypothesesReturned === 1 ? "is" : "es"} returned.
            </p>
            <Block label="Response" body={exchange.responseJson} />
          </>
        )}
      </Modal>
    </section>
  );
}

function Block({ label, body }: { label: string; body: string }) {
  return (
    <div className="mt-2">
      <div className="muted text-xs font-mono mb-1">{label}</div>
      <pre className="text-xs font-mono whitespace-pre-wrap break-words overflow-auto max-h-96 p-3 rounded border hairline">
        {body}
      </pre>
    </div>
  );
}
