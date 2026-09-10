/** Three staggered dots. Used wherever we are waiting on the AI. */
export function ThinkingDots({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="inline-flex gap-1" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="w-1.5 h-1.5 rounded-full bg-current opacity-60 animate-bounce"
            style={{ animationDelay: `${i * 140}ms`, animationDuration: "900ms" }}
          />
        ))}
      </span>
      {label && <span>{label}</span>}
    </span>
  );
}

/** A small determinate-looking bar for work with no real progress signal. */
export function Barberpole() {
  return (
    <span className="block h-0.5 w-full overflow-hidden rounded bg-current/10" aria-hidden>
      <span className="block h-full w-1/3 rounded bg-current/50 animate-[slide_1.4s_ease-in-out_infinite]" />
      <style>{`@keyframes slide{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}`}</style>
    </span>
  );
}

/** Spinning ring, for inline "this query is running" states. */
export function Spinner({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-block w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin ${className}`}
      aria-hidden
    />
  );
}
