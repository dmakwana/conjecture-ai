import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";

const DIR = "public/claude-code-transcript";

describe("published transcript", () => {
  it("has an index and its paginated pages", () => {
    expect(existsSync(`${DIR}/index.html`)).toBe(true);
    const pages = readdirSync(DIR).filter((f) => /^page-\d+\.html$/.test(f));
    expect(pages.length).toBeGreaterThan(0);
  });

  it("links to a path that works in dev, whenever it links at all", () => {
    // The link is currently commented out (1f5844b), which is a product choice,
    // so this does not demand one. What it does guard is the hazard: if a link
    // is present it must carry the explicit index.html, because `next dev`
    // serves files from public/ but not directory indexes, so the bare
    // directory URL 404s locally while working in production.
    //
    // Comments are stripped first. The earlier version grepped raw source and
    // so passed even with the link commented out: a guard blind to the very
    // thing it guarded.
    const live = readFileSync("app/page.tsx", "utf8")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");

    const links = live.match(/href="\/claude-code-transcript[^"]*"/g) ?? [];
    for (const link of links) {
      expect(link, "bare directory URL 404s under next dev").toContain("index.html");
    }
  });

  it("links every page it claims to have", () => {
    const index = readFileSync(`${DIR}/index.html`, "utf8");
    for (const page of readdirSync(DIR).filter((f) => /^page-\d+\.html$/.test(f))) {
      expect(index, `index does not link ${page}`).toContain(page);
    }
  });

  it("carries no credential, having been regenerated from a live session", () => {
    // The generator renders whatever the session contained, so this has to be
    // rechecked on every regeneration rather than assumed from the last one.
    let longest = 0;
    for (const f of readdirSync(DIR).filter((f) => f.endsWith(".html"))) {
      for (const m of readFileSync(`${DIR}/${f}`, "utf8").match(/sk-[A-Za-z0-9_-]*/g) ?? []) {
        longest = Math.max(longest, m.length);
      }
    }
    // A real Anthropic key runs past a hundred characters.
    expect(longest, "a key-length token appears in the published transcript").toBeLessThan(30);
  });

  it("stays under Cloudflare's per-file asset limit", () => {
    for (const f of readdirSync(DIR)) {
      expect(statSync(`${DIR}/${f}`).size, f).toBeLessThan(25 * 1024 * 1024);
    }
  });
});
