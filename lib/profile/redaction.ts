import { TableProfileSchema, type TableProfile } from "./types";

/**
 * The privacy backstop.
 *
 * The product's central promise is that no cell value leaves the browser, so
 * the profile is re-parsed through its zod schema (which strips any unknown
 * key) and then structurally checked before it is allowed onto the network.
 *
 * What legitimately crosses the wire, and nothing else:
 *   - column names, the table label, and DuckDB type names
 *   - numbers
 *   - ISO timestamps for date/time columns, which are included deliberately
 *   - masked shape strings, where every letter is a/A and every digit is 9
 *
 * Punctuation inside a shape stays literal, because that is what makes a shape
 * useful for spotting format drift. A value made entirely of punctuation would
 * therefore survive masking, so shapes are also length-capped. Anything
 * containing a letter or digit, such as emails, names and identifiers, cannot survive.
 */
const MAX_SHAPE_LENGTH = 60;

/**
 * What a masked shape is allowed to contain, as an allowlist rather than a
 * denylist.
 *
 * The previous check looked for `[b-zB-Z0-8]`, which only catches ASCII, so
 * every non-ASCII value sailed past it. Inverting this is the point: anything
 * the mask failed to handle now fails the check instead of shipping. The
 * permitted set is the three mask symbols plus ASCII punctuation and space,
 * which stays literal because it is what makes a shape useful for spotting
 * format drift.
 */
const ALLOWED_SHAPE_CHAR =
  /^[aA9\x20-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E]*$/;

function unmaskedCharacters(shape: string): string[] {
  // Run-length counts written by collapseShape (`a{7}`) are structural.
  const residue = shape.replace(/\{\d+\}/g, "");
  return ALLOWED_SHAPE_CHAR.test(residue)
    ? []
    : [...residue].filter((ch) => !ALLOWED_SHAPE_CHAR.test(ch));
}

export class RedactionError extends Error {}

export function assertNoValues(profile: TableProfile): TableProfile {
  // Reparsing drops any property not declared in the schema.
  const clean = TableProfileSchema.parse(profile);

  for (const col of clean.columns) {
    for (const { shape } of col.string?.shapes ?? []) {
      if (shape.length > MAX_SHAPE_LENGTH) {
        throw new RedactionError(
          `Shape for column "${col.name}" exceeds ${MAX_SHAPE_LENGTH} characters.`,
        );
      }
      const unmasked = unmaskedCharacters(shape);
      if (unmasked.length > 0) {
        throw new RedactionError(
          `Shape for column "${col.name}" contains unmasked characters: ${JSON.stringify(unmasked.join(""))}`,
        );
      }
    }
  }

  return clean;
}
