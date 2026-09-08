<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# duck-invariant

Two invariants hold this project together. Both are load-bearing; check them before changing
anything in `lib/profile/` or `lib/hypotheses/`.

1. **No cell value leaves the browser.** The only outbound payload is `TableProfile`. Adding a
   field that carries a value — a min/max on a string column, a top-k of actual values, a sample
   row — breaks the product's central claim. `lib/profile/redaction.ts` and the PII fixtures in
   `test/profile.test.ts` are there to catch exactly that.
2. **Model-authored SQL is contained.** Claude emits structured checks, never raw SQL. The `FROM`
   clause is always ours. `lib/hypotheses/guard.ts` rejects `SELECT`, semicolons, comments, and
   file/URL functions; `SET enable_external_access=false` runs before any generated SQL. Do not
   add a code path that interpolates model output into a query without going through the guard.

Practical notes:

- Aggregates need explicit casts. `sum()` over BIGINT returns HUGEINT, which Arrow delivers as a
  Decimal128 word array that reads as `0` if you are not careful — a silent wrong answer, not an
  error. Cast to BIGINT or DOUBLE in SQL; `asNumber` in `lib/arrow.ts` is the backstop.
- Import `@duckdb/duckdb-wasm` dynamically from client code. A static import breaks the static
  export build.
- Tests use the Node build of duckdb-wasm, so they run the same SQL the browser does.
