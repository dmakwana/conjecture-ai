/**
 * Collapse runs in a masked shape so long values stay readable:
 * "aaaaaaa9999@aaaa.aaa" becomes "a{7}9{4}@a{4}.a{3}".
 *
 * Runs of one or two characters are left alone, because "a{2}" is longer and
 * harder to read than "aa". This runs on already-masked strings, so it never
 * touches real data.
 */
export function collapseShape(shape: string): string {
  let out = "";
  let i = 0;
  while (i < shape.length) {
    const ch = shape[i];
    let run = 1;
    while (i + run < shape.length && shape[i + run] === ch) run++;
    out += run >= 3 ? `${ch}{${run}}` : ch.repeat(run);
    i += run;
  }
  return out;
}
