/**
 * Splitting SQL on ";" is only correct if you skip the places a semicolon can
 * legally appear without ending a statement: string literals, quoted
 * identifiers, comments and dollar-quoted blocks. The console pre-fills the
 * editor with commented-out queries, so comment handling is not optional here.
 */

interface Span {
  sql: string;
  from: number;
  to: number;
}

function scan(text: string, onSemicolon: (index: number) => void): void {
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];

    if (c === "'" || c === '"') {
      const quote = c;
      i++;
      while (i < text.length) {
        if (text[i] === quote) {
          if (text[i + 1] === quote) i += 2; // doubled quote is an escape
          else { i++; break; }
        } else i++;
      }
      continue;
    }

    if (c === "-" && next === "-") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }

    if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }

    // Dollar quoting: $$ ... $$ or $tag$ ... $tag$
    if (c === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(text.slice(i));
      if (tag) {
        const close = text.indexOf(tag[0], i + tag[0].length);
        i = close === -1 ? text.length : close + tag[0].length;
        continue;
      }
    }

    if (c === ";") onSemicolon(i);
    i++;
  }
}

/** Remove comments, so a statement can be tested for having any real content. */
export function stripSqlComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === "'" || c === '"') {
      const quote = c;
      out += c;
      i++;
      while (i < text.length) {
        out += text[i];
        if (text[i] === quote) {
          if (text[i + 1] === quote) { out += text[i + 1]; i += 2; }
          else { i++; break; }
        } else i++;
      }
      continue;
    }
    if (c === "-" && next === "-") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** True when a chunk is only whitespace and comments. */
export function isBlank(sql: string): boolean {
  return stripSqlComments(sql).trim() === "";
}

/** Split into executable statements, dropping any that are purely commentary. */
export function splitStatements(text: string): Span[] {
  const cuts: number[] = [];
  scan(text, (i) => cuts.push(i));

  const spans: Span[] = [];
  let start = 0;
  for (const cut of [...cuts, text.length]) {
    const chunk = text.slice(start, cut);
    if (!isBlank(chunk)) spans.push({ sql: chunk.trim(), from: start, to: cut });
    start = cut + 1;
  }
  return spans;
}

/**
 * The statement to run for a given cursor position.
 *
 * Running the whole buffer would execute every example the console pre-filled;
 * running only the statement under the cursor is what a SQL console is expected
 * to do. Falls back to the last statement when the cursor sits in the trailing
 * comment block.
 */
export function statementAt(text: string, cursor: number): string | null {
  const spans = splitStatements(text);
  if (spans.length === 0) return null;
  const hit = spans.find((s) => cursor >= s.from && cursor <= s.to);
  return (hit ?? spans[spans.length - 1]).sql;
}
