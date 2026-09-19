import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const css = readFileSync("app/globals.css", "utf8");
const modal = readFileSync("components/Modal.tsx", "utf8");

describe("modal centring", () => {
  it("restores margin:auto on dialog", () => {
    // Browsers centre a modal <dialog> through the UA rule `dialog { margin:
    // auto }` acting on `inset: 0`. Tailwind Preflight sets `margin: 0` on `*`,
    // and an author rule beats a UA rule, so deleting this pins every modal to
    // the top-left corner. It is one line and entirely non-obvious, hence a test.
    expect(css).toMatch(/dialog\s*\{[^}]*margin:\s*auto/);
  });

  it("does not let a utility class re-zero the margin", () => {
    const className = modal.match(/className="([^"]*)"/)?.[1] ?? "";
    expect(className).not.toMatch(/\bm-0\b/);
    expect(className).not.toMatch(/\bm[xy]-0\b/);
  });

  it("keeps the height auto so margin:auto can centre vertically", () => {
    // margin:auto only centres on an axis whose size is definite. A stretched
    // height (from inset:0 with height:auto) would fill the viewport instead.
    const className = modal.match(/className="([^"]*)"/)?.[1] ?? "";
    expect(className).toMatch(/\bh-fit\b/);
    expect(className).not.toMatch(/\bh-full\b/);
  });
});
