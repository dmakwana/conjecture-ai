import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const css = readFileSync("app/globals.css", "utf8");
const modal = readFileSync("components/Modal.tsx", "utf8");

describe("native browser chrome", () => {
  it("declares color-scheme so scrollbars follow the theme", () => {
    // Scrollbars, form controls and the dialog backdrop are painted by the
    // browser. Swapping our CSS variables tells it nothing, so without this the
    // page is dark and its scrollbars are bright white.
    expect(css).toMatch(/:root\s*\{[^}]*color-scheme:\s*light dark/);
  });
});

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

  it("mounts contents only while open", () => {
    // A closed <dialog> is display:none. Anything that measures itself on mount,
    // CodeMirror included, reads a zero-width viewport there and comes back
    // horizontally mis-scrolled once shown.
    expect(modal).toMatch(/\{open && children\}/);
  });

  it("keeps a definite height on both modes so margin:auto can centre", () => {
    // margin:auto only centres on an axis whose size is definite. A stretched
    // height (from inset:0 with height:auto) would fill the viewport instead.
    expect(modal).toMatch(/h-\[85vh\]/);  // fixed-size mode
    expect(modal).toMatch(/h-fit/);        // grow-to-content mode
    expect(modal).not.toMatch(/\bh-full\b/);
  });

  it("locks the page behind it, and puts back the scrollbar's width", () => {
    // showModal() makes the document inert, which stops clicks and focus but
    // not the wheel, so the page behind still scrolls under the dialog.
    expect(modal).toMatch(/overflow\s*=\s*"hidden"/);
    // Removing the scrollbar frees its width and the page jumps sideways.
    expect(modal).toMatch(/paddingRight/);
    // Counted, so one modal closing cannot unlock while another is open.
    expect(modal).toMatch(/lockCount/);
  });
});
