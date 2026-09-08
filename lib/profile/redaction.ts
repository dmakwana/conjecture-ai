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
 * containing a letter or digit — emails, names, identifiers — cannot survive.
 */
const MAX_SHAPE_LENGTH = 60;

/**
 * After masking, the only letters that may appear are `a` and `A` and the only
 * digit is `9`. Run-length counts written by collapseShape (`a{7}`) are stripped
 * before the check, since their digits are structural rather than data.
 */
function unmaskedCharacters(shape: string): string[] {
  const residue = shape.replace(/\{\d+\}/g, "");
  return residue.match(/[b-zB-Z0-8]/g) ?? [];
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
