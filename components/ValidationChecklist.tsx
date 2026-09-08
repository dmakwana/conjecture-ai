import type { SourceCheck, CheckStatus } from "@/lib/sources/validate";

const MARK: Record<CheckStatus, string> = { pass: "✓", warn: "!", fail: "✗" };
const TONE: Record<CheckStatus, string> = {
  pass: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400",
  fail: "text-red-600 dark:text-red-400",
};

export function ValidationChecklist({ checks }: { checks: SourceCheck[] }) {
  if (checks.length === 0) return null;
  return (
    <ul className="panel rounded-md divide-y hairline text-sm">
      {checks.map((c) => (
        <li key={c.id} className="flex gap-3 px-3 py-2">
          <span className={`${TONE[c.status]} font-mono w-3 shrink-0`}>{MARK[c.status]}</span>
          <span className="w-40 shrink-0">{c.label}</span>
          <span className="muted">{c.detail}</span>
        </li>
      ))}
    </ul>
  );
}
