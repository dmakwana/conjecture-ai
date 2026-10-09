/**
 * The user's own Anthropic API key, kept in this browser's localStorage and
 * nowhere else. It goes from here straight to api.anthropic.com; this site has
 * no server that could receive it.
 *
 * Every storage access is wrapped: storage can be blocked (private windows,
 * site-data settings) and throws rather than returning null when it is. The
 * key then lives in memory for the life of the page instead.
 *
 * Shaped as an external store (subscribe + getSnapshot) for
 * useSyncExternalStore, which reads it after hydration rather than during the
 * static prerender, and keeps other tabs in step via the storage event.
 */
const STORAGE_KEY = "conjecture-ai:anthropic-api-key";

let memory = "";
const listeners = new Set<() => void>();

export function getApiKey(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? memory;
  } catch {
    return memory;
  }
}

/** Store a key, or clear it with "". */
export function setApiKey(raw: string): void {
  // Trims paste debris. Deliberately not a format check: Anthropic is the judge.
  const key = raw.trim();
  memory = key;
  try {
    if (key) localStorage.setItem(STORAGE_KEY, key);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable; `memory` carries it for this page.
  }
  listeners.forEach((l) => l());
}

export function subscribeApiKey(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY || e.key === null) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** Nothing is known about the key at prerender time. */
export const getServerApiKey = () => "";
