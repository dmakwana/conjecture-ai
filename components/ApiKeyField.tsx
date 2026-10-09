"use client";

import { useState, useSyncExternalStore } from "react";
import {
  getApiKey, getServerApiKey, setApiKey, subscribeApiKey,
} from "@/lib/apiKey";

/** The key currently saved in this browser, or "" when there is none. */
export function useApiKey(): string {
  return useSyncExternalStore(subscribeApiKey, getApiKey, getServerApiKey);
}

/**
 * Where the user supplies their own Anthropic key. Claude is called directly
 * from this browser with it, so the disclaimer is a literal description of the
 * data flow, not a policy promise.
 */
export function ApiKeyField({ disabled }: { disabled?: boolean }) {
  const apiKey = useApiKey();
  const [draft, setDraft] = useState("");

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.trim()) return;
    setApiKey(draft);
    setDraft("");
  };

  return (
    <section className="panel rounded-md px-4 py-3 space-y-2 text-sm">
      {apiKey ? (
        <div className="flex items-center gap-3 flex-wrap">
          <span>
            Anthropic API key saved in this browser{" "}
            <span className="muted font-mono">…{apiKey.slice(-4)}</span>
          </span>
          <button
            type="button"
            onClick={() => setApiKey("")}
            disabled={disabled}
            className="muted underline underline-offset-2 hover:no-underline disabled:opacity-50"
          >
            Forget key
          </button>
        </div>
      ) : (
        <form onSubmit={save} className="flex items-center gap-2 flex-wrap">
          <label htmlFor="anthropic-api-key" className="font-medium">
            Anthropic API key
          </label>
          <input
            id="anthropic-api-key"
            type="password"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="sk-ant-…"
            autoComplete="off"
            spellCheck={false}
            className="flex-1 min-w-48 rounded-md border border-current/20 bg-transparent px-2 py-1 font-mono text-xs"
          />
          <button
            type="submit"
            disabled={!draft.trim()}
            className="rounded-md px-3 py-1 text-sm font-medium bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Save
          </button>
        </form>
      )}
      <p className="muted text-xs">
        Your key is saved only in this browser&apos;s local storage and is sent only to
        Anthropic, directly from your browser. We never receive or store it. Usage is
        billed to your Anthropic account, roughly $0.40 per round.
        {!apiKey && (
          <>
            {" "}
            <a
              href="https://console.anthropic.com/settings/keys"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:no-underline"
            >
              Get a key
            </a>
          </>
        )}
      </p>
    </section>
  );
}
