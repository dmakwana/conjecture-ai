/**
 * Table names are derived from filenames and URLs, so they are user-controlled
 * and end up inside SQL we build. They are sanitised down to a plain
 * `[a-z][a-z0-9_]*` identifier rather than quoted-and-hoped-for, and the result
 * is the only name the model is ever told about.
 */

const RESERVED = new Set([
  "table", "select", "from", "where", "group", "order", "by", "join",
  "union", "all", "and", "or", "not", "null", "true", "false", "case", "when",
  "then", "else", "end", "as", "on", "in", "is", "like", "between", "default",
]);

/** Strip a filename or URL down to a usable base name. */
export function baseNameFor(label: string): string {
  let name = label;
  try {
    if (/^https?:/i.test(label)) {
      name = decodeURIComponent(new URL(label).pathname.split("/").pop() ?? label);
    }
  } catch {
    /* fall through and use the raw label */
  }
  // Drop the extension, including doubled ones like .csv.gz
  name = name.replace(/\.(gz|zst|bz2)$/i, "").replace(/\.[^.]+$/, "");

  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (slug === "" || /^[0-9]/.test(slug)) return `t_${slug || "table"}`;
  return RESERVED.has(slug) ? `${slug}_tbl` : slug;
}

/**
 * Assign a unique table name, appending a counter when the base is taken so two
 * files called orders.csv do not collide.
 */
export function uniqueTableName(label: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = baseNameFor(label);
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}_${i}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** True when a name is safe to interpolate into SQL without quoting. */
export function isSafeTableName(name: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(name) && name.length <= 64;
}
