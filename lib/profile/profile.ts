import type * as duckdb from "@duckdb/duckdb-wasm";
import { asNumber, firstRow, toRows } from "@/lib/arrow";
import type { LoadedTable } from "@/lib/duckdb/load";
import { aggregateQuery, chunkColumns, classify, shapeQuery, type ColumnSpec } from "./queries";
import { collapseShape } from "./shapes";
import { assertNoValues } from "./redaction";
import type { ColumnProfile, TableProfile } from "./types";

/** Shapes cost one query per column, so only the first N string columns get them. */
const MAX_SHAPE_COLUMNS = 20;

type Row = Record<string, unknown>;

const n = (row: Row, key: string): number => asNumber(row[key]) ?? 0;
const nOrNull = (row: Row, key: string): number | null => asNumber(row[key]);
const str = (row: Row, key: string): string | null => {
  const v = row[key];
  return typeof v === "string" ? v : v === null || v === undefined ? null : String(v);
};

function pct(part: number, whole: number): number {
  return whole === 0 ? 0 : (part / whole) * 100;
}

export async function profileTable(
  conn: duckdb.AsyncDuckDBConnection,
  loaded: LoadedTable,
  onProgress?: (done: number, total: number) => void,
): Promise<TableProfile> {
  const started = performance.now();

  const specs: ColumnSpec[] = loaded.columns.map((c, i) => ({
    name: c.name,
    sqlType: c.sqlType,
    ordinal: i,
    class: classify(c.sqlType),
  }));

  const chunks = chunkColumns(specs);
  const shapeTargets = specs
    .filter((s) => s.class === "string")
    .slice(0, MAX_SHAPE_COLUMNS);
  const totalSteps = chunks.length + shapeTargets.length;
  let step = 0;

  // ---- aggregates -------------------------------------------------------
  const stats: Row = {};
  let rowCount = loaded.rowCount;
  for (const chunk of chunks) {
    const row = firstRow<Row>(await conn.query(aggregateQuery(chunk)));
    if (row) {
      Object.assign(stats, row);
      rowCount = asNumber(row.row_count) ?? rowCount;
    }
    onProgress?.(++step, totalSteps);
  }

  // ---- shapes -----------------------------------------------------------
  const shapesByColumn = new Map<number, { shape: string; count: number }[]>();
  for (const spec of shapeTargets) {
    try {
      const rows = toRows<{ shape: unknown; n: unknown }>(
        await conn.query(shapeQuery(spec)),
      );
      shapesByColumn.set(
        spec.ordinal,
        rows
          .filter((r) => typeof r.shape === "string")
          .map((r) => ({
            shape: collapseShape(r.shape as string),
            count: asNumber(r.n) ?? 0,
          })),
      );
    } catch {
      // A shape histogram is a nice-to-have; never fail the whole profile for it.
    }
    onProgress?.(++step, totalSteps);
  }

  // ---- assemble ---------------------------------------------------------
  const columns: ColumnProfile[] = specs.map((spec) => {
    const p = `c${spec.ordinal}`;
    const nonNull = n(stats, `${p}_nonnull`);
    const nullCount = Math.max(0, rowCount - nonNull);
    const approxDistinct = n(stats, `${p}_ndv`);

    const base: ColumnProfile = {
      name: spec.name,
      ordinal: spec.ordinal,
      sqlType: spec.sqlType,
      class: spec.class,
      rowCount,
      nullCount,
      nullPct: pct(nullCount, rowCount),
      approxDistinct,
      distinctPct: pct(approxDistinct, Math.max(1, nonNull)),
      // approx_count_distinct is an estimate, so treat "within 1%" as unique.
      isCandidateKey:
        nullCount === 0 && nonNull > 0 && approxDistinct >= nonNull * 0.99,
      numeric: null,
      temporal: null,
      boolean: null,
      string: null,
    };

    switch (spec.class) {
      case "numeric":
        base.numeric = {
          min: nOrNull(stats, `${p}_min`),
          max: nOrNull(stats, `${p}_max`),
          avg: nOrNull(stats, `${p}_avg`),
          stddev: nOrNull(stats, `${p}_stddev`),
          p01: nOrNull(stats, `${p}_p01`),
          p25: nOrNull(stats, `${p}_p25`),
          p50: nOrNull(stats, `${p}_p50`),
          p75: nOrNull(stats, `${p}_p75`),
          p99: nOrNull(stats, `${p}_p99`),
          zeroCount: n(stats, `${p}_zero`),
          negativeCount: n(stats, `${p}_neg`),
          nonFiniteCount: n(stats, `${p}_nonfinite`),
        };
        break;
      case "temporal":
        base.temporal = {
          minISO: str(stats, `${p}_min`),
          maxISO: str(stats, `${p}_max`),
          spanDays: nOrNull(stats, `${p}_span`),
          futureCount: n(stats, `${p}_future`),
          epochZeroCount: n(stats, `${p}_epoch`),
        };
        break;
      case "boolean":
        base.boolean = {
          trueCount: n(stats, `${p}_true`),
          falseCount: n(stats, `${p}_false`),
        };
        break;
      case "string": {
        const chars = n(stats, `${p}_chars`);
        const alpha = n(stats, `${p}_alpha`);
        const digit = n(stats, `${p}_digit`);
        const space = n(stats, `${p}_space`);
        const punct = n(stats, `${p}_punct`);
        base.string = {
          lenMin: nOrNull(stats, `${p}_lenmin`),
          lenP50: nOrNull(stats, `${p}_lenp50`),
          lenMax: nOrNull(stats, `${p}_lenmax`),
          lenAvg: nOrNull(stats, `${p}_lenavg`),
          emptyCount: n(stats, `${p}_empty`),
          whitespaceOnlyCount: n(stats, `${p}_ws`),
          untrimmedCount: n(stats, `${p}_untrimmed`),
          charClassPct: {
            alpha: pct(alpha, chars),
            digit: pct(digit, chars),
            space: pct(space, chars),
            punct: pct(punct, chars),
            other: Math.max(0, pct(chars - alpha - digit - space - punct, chars)),
          },
          distinctCaseInsensitive: nOrNull(stats, `${p}_ndv_ci`),
          shapes: shapesByColumn.get(spec.ordinal) ?? [],
        };
        break;
      }
      case "nested":
      case "other":
        break;
    }

    return base;
  });

  const profile: TableProfile = {
    table: loaded.label,
    format: loaded.format,
    rowCount,
    columnCount: columns.length,
    profileMs: Math.round(performance.now() - started),
    columns,
  };

  // Never let a profile reach the network without passing the redaction check.
  return assertNoValues(profile);
}
