import { z } from "zod";

/**
 * The profile is the ONLY thing that ever leaves the browser.
 *
 * Every field here is a number, a column name, a SQL type name, or a derived
 * shape string. There are deliberately no cell values: no string min/max, no
 * top-k values, no row samples. See lib/profile/redaction.ts for the assertion
 * that enforces this, and test/redaction.test.ts for the proof.
 *
 * These zod schemas are shared with the Worker, which re-parses the incoming
 * profile. Because zod strips unknown keys, a client that tried to smuggle
 * extra fields through would have them dropped before reaching Anthropic.
 */

export const COLUMN_CLASSES = [
  "numeric",
  "temporal",
  "boolean",
  "string",
  "nested",
  "other",
] as const;

export const ColumnClassSchema = z.enum(COLUMN_CLASSES);
export type ColumnClass = z.infer<typeof ColumnClassSchema>;

const num = z.number().nullable();

export const NumericStatsSchema = z.object({
  min: num,
  max: num,
  avg: num,
  stddev: num,
  p01: num,
  p25: num,
  p50: num,
  p75: num,
  p99: num,
  zeroCount: z.number(),
  negativeCount: z.number(),
  nonFiniteCount: z.number(),
});

export const TemporalStatsSchema = z.object({
  /** ISO-8601. Dates are included deliberately: a 1970 min or a year-3000 max
   *  is the single highest-value data-quality signal in most datasets. */
  minISO: z.string().nullable(),
  maxISO: z.string().nullable(),
  spanDays: num,
  futureCount: z.number(),
  epochZeroCount: z.number(),
});

export const BooleanStatsSchema = z.object({
  trueCount: z.number(),
  falseCount: z.number(),
});

export const CharClassPctSchema = z.object({
  alpha: z.number(),
  digit: z.number(),
  space: z.number(),
  punct: z.number(),
  other: z.number(),
});

/** A shape is a value with every letter mapped to a/A and every digit to 9,
 *  e.g. "aaaa9@aaa.aa". Non-reversible; carries format, never content. */
export const ShapeSchema = z.object({
  shape: z.string(),
  count: z.number(),
});

export const StringStatsSchema = z.object({
  lenMin: num,
  lenP50: num,
  lenMax: num,
  lenAvg: num,
  emptyCount: z.number(),
  whitespaceOnlyCount: z.number(),
  untrimmedCount: z.number(),
  charClassPct: CharClassPctSchema,
  /** Distinct count ignoring case. Much lower than approxDistinct means the
   *  column mixes casing for the same logical value. */
  distinctCaseInsensitive: z.number().nullable(),
  shapes: z.array(ShapeSchema),
});

export const ColumnProfileSchema = z.object({
  name: z.string(),
  ordinal: z.number(),
  sqlType: z.string(),
  class: ColumnClassSchema,
  rowCount: z.number(),
  nullCount: z.number(),
  nullPct: z.number(),
  approxDistinct: z.number(),
  distinctPct: z.number(),
  isCandidateKey: z.boolean(),
  numeric: NumericStatsSchema.nullable(),
  temporal: TemporalStatsSchema.nullable(),
  boolean: BooleanStatsSchema.nullable(),
  string: StringStatsSchema.nullable(),
});

export const TableProfileSchema = z.object({
  /** The SQL identifier. This is the name the model is told to use. */
  table: z.string(),
  /** Original filename or URL. Display only; never referenced in SQL. */
  label: z.string(),
  format: z.enum(["parquet", "csv", "json"]),
  rowCount: z.number(),
  columnCount: z.number(),
  profileMs: z.number(),
  columns: z.array(ColumnProfileSchema),
});

/** Every loaded table. This whole object is what crosses the network. */
export const DatabaseProfileSchema = z.object({
  tables: z.array(TableProfileSchema),
  profileMs: z.number(),
});

export type NumericStats = z.infer<typeof NumericStatsSchema>;
export type TemporalStats = z.infer<typeof TemporalStatsSchema>;
export type BooleanStats = z.infer<typeof BooleanStatsSchema>;
export type StringStats = z.infer<typeof StringStatsSchema>;
export type ColumnProfile = z.infer<typeof ColumnProfileSchema>;
export type TableProfile = z.infer<typeof TableProfileSchema>;
export type DatabaseProfile = z.infer<typeof DatabaseProfileSchema>;
