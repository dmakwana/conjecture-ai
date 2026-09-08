import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import robots from "@/app/robots";
import { ALL_CRAWLERS, AI_CRAWLERS } from "@/lib/crawlers";

describe("robots.txt", () => {
  const rules = robots().rules as { userAgent: string | string[]; disallow: string }[];

  it("disallows everything under the wildcard", () => {
    const wildcard = rules.find((r) => r.userAgent === "*");
    expect(wildcard?.disallow).toBe("/");
  });

  it("names the opt-out tokens that the wildcard cannot cover", () => {
    // Google-Extended and Applebot-Extended are not crawlers; they are control
    // tokens that only take effect when addressed by name.
    expect(AI_CRAWLERS).toContain("Google-Extended");
    expect(AI_CRAWLERS).toContain("Applebot-Extended");
    const named = rules.find((r) => Array.isArray(r.userAgent))?.userAgent as string[];
    expect(named).toContain("Google-Extended");
    expect(named).toContain("Applebot-Extended");
  });

  it("names the major AI crawlers and disallows them", () => {
    const named = rules.find((r) => Array.isArray(r.userAgent))?.userAgent as string[];
    for (const bot of ["GPTBot", "ClaudeBot", "CCBot", "PerplexityBot", "Bytespider"]) {
      expect(named, bot).toContain(bot);
    }
    expect(rules.every((r) => r.disallow === "/")).toBe(true);
  });

  it("lists every crawler exactly once", () => {
    expect(new Set(ALL_CRAWLERS).size).toBe(ALL_CRAWLERS.length);
  });
});

describe("_headers", () => {
  const headers = readFileSync("public/_headers", "utf8");

  it("applies noindex to every path", () => {
    expect(headers).toMatch(/^\/\*$/m);
    expect(headers).toMatch(/X-Robots-Tag:.*noindex/);
    expect(headers).toMatch(/X-Robots-Tag:.*nofollow/);
  });

  it("stops this site's URL leaking to data hosts via Referer", () => {
    expect(headers).toMatch(/Referrer-Policy:\s*no-referrer/);
  });
});
