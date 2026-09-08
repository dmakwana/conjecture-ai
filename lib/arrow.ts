import type * as arrow from "apache-arrow";

/**
 * DuckDB hands back Arrow. Two things bite when reading it from JS:
 * INT64 columns arrive as BigInt (which JSON.stringify throws on), and
 * temporal columns arrive as numbers or Dates depending on the unit.
 * Everything crossing into plain JS goes through here.
 */
export function toJs(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") {
    // Counts and sums exceeding 2^53 are not realistic here, and a Number is
    // far easier to work with downstream than a BigInt.
    return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>);
  if (Array.isArray(value)) return value.map(toJs);
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // Arrow StructRow and friends expose toJSON()
    if (typeof (obj as { toJSON?: unknown }).toJSON === "function") {
      return toJs((obj as { toJSON: () => unknown }).toJSON());
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = toJs(v);
    return out;
  }
  return value;
}

/** Convert an Arrow table to plain JS row objects. */
export function toRows<T = Record<string, unknown>>(table: arrow.Table): T[] {
  return table.toArray().map((row) => toJs(row) as T);
}

/** Convert an Arrow table to a single row, or null when empty. */
export function firstRow<T = Record<string, unknown>>(table: arrow.Table): T | null {
  return table.numRows === 0 ? null : (toJs(table.get(0)) as T);
}

/** Column names in order. */
export function columnNames(table: arrow.Table): string[] {
  return table.schema.fields.map((f) => f.name);
}

/**
 * Decode an Arrow Decimal128, which arrives as four little-endian 32-bit words.
 *
 * DuckDB returns HUGEINT for sum() over BIGINT and for DECIMAL columns, and
 * Arrow surfaces both this way. Read naively it looks like the array [2,0,0,0]
 * and coerces to 0 — a silent wrong answer rather than an error, which is why
 * it is handled explicitly here as well as cast away in SQL.
 */
function decimal128ToNumber(words: number[]): number | null {
  if (words.length !== 4) return null;
  let value = 0n;
  for (let i = 3; i >= 0; i--) {
    value = (value << 32n) | BigInt(words[i] >>> 0);
  }
  // Two's complement: the top bit of the most significant word is the sign.
  if (words[3] & 0x80000000) value -= 1n << 128n;
  return Number(value);
}

/** Coerce a value that should be numeric, returning null for anything else. */
export function asNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  // Only ever called on scalar statistic fields, never on list columns, so a
  // four-element numeric array here is a Decimal128 rather than real data.
  if (Array.isArray(value) && value.every((v) => typeof v === "number")) {
    return decimal128ToNumber(value as number[]);
  }
  if (value instanceof Uint32Array || value instanceof Int32Array) {
    return decimal128ToNumber(Array.from(value));
  }
  return null;
}
