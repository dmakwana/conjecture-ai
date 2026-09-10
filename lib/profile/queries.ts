import { quoteIdent } from "@/lib/hypotheses/guard";
import type { ColumnClass } from "./types";

export interface ColumnSpec {
  name: string;
  sqlType: string;
  ordinal: number;
  class: ColumnClass;
}

const NUMERIC = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UHUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|FLOAT|DOUBLE|REAL|DECIMAL|NUMERIC)/;
const FLOATING = /^(FLOAT|DOUBLE|REAL)/;
const TEMPORAL = /^(DATE|TIMESTAMP)/;
const STRINGY = /^(VARCHAR|CHAR|TEXT|STRING)/;
const NESTED = /(\[\]|^STRUCT|^MAP|^LIST|^UNION)/;

/** Map a DuckDB type name onto the class that decides which stats we compute. */
export function classify(sqlType: string): ColumnClass {
  const t = sqlType.toUpperCase().trim();
  if (NESTED.test(t)) return "nested";
  if (t === "BOOLEAN") return "boolean";
  if (NUMERIC.test(t)) return "numeric";
  // TIME and INTERVAL are deliberately excluded: they have no date component,
  // so "in the future" and "epoch zero" are meaningless for them.
  if (TEMPORAL.test(t)) return "temporal";
  if (STRINGY.test(t)) return "string";
  return "other";
}

export function isFloating(sqlType: string): boolean {
  return FLOATING.test(sqlType.toUpperCase().trim());
}

/**
 * Aggregate expressions for one column, aliased `c{ordinal}_{stat}`.
 *
 * Everything is computed in a handful of grouped queries rather than one query
 * per column, because a round trip per column is unusably slow on wide tables.
 */
export function columnAggregates(col: ColumnSpec): string[] {
  const c = quoteIdent(col.name);
  const p = `c${col.ordinal}`;
  const out: string[] = [
    `count(${c}) AS ${p}_nonnull`,
  ];

  // Nested types cannot be fed to approx_count_distinct.
  if (col.class !== "nested") {
    out.push(`approx_count_distinct(${c}) AS ${p}_ndv`);
  }

  switch (col.class) {
    case "numeric": {
      out.push(
        // Cast to DOUBLE so DECIMAL and HUGEINT columns do not come back as
        // Arrow Decimal128 (a four-word array that silently reads as 0).
        // Profile statistics are approximate by nature, so the precision loss
        // above 2^53 is acceptable here and nowhere else.
        `CAST(min(${c}) AS DOUBLE) AS ${p}_min`,
        `CAST(max(${c}) AS DOUBLE) AS ${p}_max`,
        `CAST(avg(${c}) AS DOUBLE) AS ${p}_avg`,
        `CAST(stddev_samp(${c}) AS DOUBLE) AS ${p}_stddev`,
        `CAST(approx_quantile(${c}, 0.01) AS DOUBLE) AS ${p}_p01`,
        `CAST(approx_quantile(${c}, 0.25) AS DOUBLE) AS ${p}_p25`,
        `CAST(approx_quantile(${c}, 0.50) AS DOUBLE) AS ${p}_p50`,
        `CAST(approx_quantile(${c}, 0.75) AS DOUBLE) AS ${p}_p75`,
        `CAST(approx_quantile(${c}, 0.99) AS DOUBLE) AS ${p}_p99`,
        `count(*) FILTER (WHERE ${c} = 0) AS ${p}_zero`,
        `count(*) FILTER (WHERE ${c} < 0) AS ${p}_neg`,
      );
      out.push(
        isFloating(col.sqlType)
          ? `count(*) FILTER (WHERE isnan(${c}) OR isinf(${c})) AS ${p}_nonfinite`
          : `0 AS ${p}_nonfinite`,
      );
      break;
    }
    case "temporal": {
      out.push(
        // Cast to text so the value survives Arrow decoding unambiguously,
        // rather than arriving as an epoch number of uncertain unit.
        `CAST(min(${c}) AS VARCHAR) AS ${p}_min`,
        `CAST(max(${c}) AS VARCHAR) AS ${p}_max`,
        `date_diff('day', CAST(min(${c}) AS TIMESTAMP), CAST(max(${c}) AS TIMESTAMP)) AS ${p}_span`,
        `count(*) FILTER (WHERE CAST(${c} AS TIMESTAMP) > now()) AS ${p}_future`,
        `count(*) FILTER (WHERE CAST(${c} AS DATE) = DATE '1970-01-01') AS ${p}_epoch`,
      );
      break;
    }
    case "boolean": {
      out.push(
        `count(*) FILTER (WHERE ${c}) AS ${p}_true`,
        `count(*) FILTER (WHERE NOT ${c}) AS ${p}_false`,
      );
      break;
    }
    case "string": {
      out.push(
        `min(length(${c})) AS ${p}_lenmin`,
        `max(length(${c})) AS ${p}_lenmax`,
        `avg(length(${c})) AS ${p}_lenavg`,
        `approx_quantile(length(${c}), 0.50) AS ${p}_lenp50`,
        `count(*) FILTER (WHERE ${c} = '') AS ${p}_empty`,
        `count(*) FILTER (WHERE ${c} <> '' AND trim(${c}) = '') AS ${p}_ws`,
        `count(*) FILTER (WHERE ${c} <> trim(${c})) AS ${p}_untrimmed`,
        `approx_count_distinct(lower(${c})) AS ${p}_ndv_ci`,
        // Character-class composition: counts of characters, never characters.
        `CAST(sum(length(${c})) AS BIGINT) AS ${p}_chars`,
        `CAST(sum(length(regexp_replace(${c}, '[^A-Za-z]', '', 'g'))) AS BIGINT) AS ${p}_alpha`,
        `CAST(sum(length(regexp_replace(${c}, '[^0-9]', '', 'g'))) AS BIGINT) AS ${p}_digit`,
        `CAST(sum(length(regexp_replace(${c}, '[^[:space:]]', '', 'g'))) AS BIGINT) AS ${p}_space`,
        `CAST(sum(length(regexp_replace(${c}, '[^[:punct:]]', '', 'g'))) AS BIGINT) AS ${p}_punct`,
      );
      break;
    }
    case "nested":
    case "other":
      break;
  }

  return out;
}

/**
 * Group columns so no single query grows unreasonably wide. String columns cost
 * roughly four times as many expressions as the rest, so they are batched harder.
 */
export function chunkColumns(columns: ColumnSpec[], budget = 180): ColumnSpec[][] {
  const chunks: ColumnSpec[][] = [];
  let current: ColumnSpec[] = [];
  let cost = 0;
  for (const col of columns) {
    const colCost = columnAggregates(col).length;
    if (current.length > 0 && cost + colCost > budget) {
      chunks.push(current);
      current = [];
      cost = 0;
    }
    current.push(col);
    cost += colCost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export function aggregateQuery(table: string, chunk: ColumnSpec[]): string {
  const parts = ["count(*) AS row_count", ...chunk.flatMap(columnAggregates)];
  return `SELECT ${parts.join(", ")} FROM ${table}`;
}

/**
 * Top shapes for a string column.
 *
 * A shape masks every letter to a/A and every digit to 9, so "ana@acme.io"
 * becomes "aaa@aaaa.aa". Punctuation is kept literal because that is exactly
 * what makes a shape useful for spotting format drift. Sampled, because a
 * GROUP BY over every row of a wide table is not worth the wait.
 */
export function shapeQuery(
  table: string,
  col: ColumnSpec,
  sampleRows = 50_000,
  limit = 8,
): string {
  const c = quoteIdent(col.name);
  const masked =
    `regexp_replace(regexp_replace(regexp_replace(` +
    `substr(${c}, 1, 40), '[a-z]', 'a', 'g'), '[A-Z]', 'A', 'g'), '[0-9]', '9', 'g')`;
  return (
    `SELECT shape, count(*) AS n FROM (` +
    `SELECT ${masked} AS shape FROM (` +
    `SELECT ${c} FROM ${table} WHERE ${c} IS NOT NULL` +
    `) USING SAMPLE ${sampleRows} ROWS` +
    `) GROUP BY shape ORDER BY n DESC, shape LIMIT ${limit}`
  );
}
