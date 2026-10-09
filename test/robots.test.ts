import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { AI_TRAINING_CRAWLERS } from "@/lib/crawlers";
import { SITE_URL } from "@/lib/site";

type Rule = { userAgent: string | string[]; allow?: string; disallow?: string };

describe("robots.txt", () => {
  const result = robots();
  const rules = result.rules as Rule[];

  it("lets every crawler in under the wildcard, so search engines index the site", () => {
    const wildcard = rules.find((r) => r.userAgent === "*");
    expect(wildcard?.allow).toBe("/");
    expect(wildcard?.disallow).toBeUndefined();
  });

  it("opts out of AI training by name, including the control tokens", () => {
    const named = rules.find((r) => Array.isArray(r.userAgent));
    expect(named?.disallow).toBe("/");
    // Google-Extended and Applebot-Extended only take effect when named.
    for (const bot of ["GPTBot", "ClaudeBot", "CCBot", "Google-Extended", "Applebot-Extended"]) {
      expect(named?.userAgent, bot).toContain(bot);
    }
  });

  it("never blocks a search crawler", () => {
    for (const bot of ["Googlebot", "Bingbot", "DuckDuckBot", "Applebot", "OAI-SearchBot"]) {
      expect(AI_TRAINING_CRAWLERS, bot).not.toContain(bot);
    }
  });

  it("lists every training crawler exactly once", () => {
    expect(new Set(AI_TRAINING_CRAWLERS).size).toBe(AI_TRAINING_CRAWLERS.length);
  });

  it("points at the sitemap", () => {
    expect(result.sitemap).toBe(`${SITE_URL}/sitemap.xml`);
  });
});

describe("sitemap.xml", () => {
  it("lists the app and the terms", () => {
    expect(sitemap().map((e) => e.url)).toEqual([SITE_URL, `${SITE_URL}/terms`]);
  });
});

describe("_headers", () => {
  const headers = readFileSync("public/_headers", "utf8");

  it("does not tell search engines to stay away", () => {
    expect(headers).not.toMatch(/X-Robots-Tag/i);
  });

  it("stops this site's URL leaking to data hosts via Referer", () => {
    expect(headers).toMatch(/^\/\*$/m);
    expect(headers).toMatch(/Referrer-Policy:\s*no-referrer/);
  });
});
