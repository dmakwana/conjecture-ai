/**
 * Crawlers named explicitly in robots.txt.
 *
 * A blanket `User-agent: *` rule already covers well-behaved crawlers, so why
 * list these? Because several of the most important entries are not crawlers at
 * all. Google-Extended and Applebot-Extended are opt-out control tokens that
 * only take effect when addressed by name, and are ignored under the wildcard.
 * Others (Bytespider, CCBot) have a track record of honouring only rules that
 * name them. Naming costs nothing and covers those cases.
 *
 * None of this is enforcement. robots.txt is a request that a crawler is free
 * to ignore; Cloudflare Access is what actually keeps this site private.
 */

/** AI training, retrieval and assistant crawlers. */
export const AI_CRAWLERS = [
  // OpenAI
  "GPTBot", "ChatGPT-User", "OAI-SearchBot",
  // Anthropic
  "ClaudeBot", "Claude-User", "Claude-SearchBot", "anthropic-ai",
  // Google / Apple AI opt-out tokens (only honoured when named)
  "Google-Extended", "Applebot-Extended",
  // Meta
  "meta-externalagent", "meta-externalfetcher", "FacebookBot",
  // Perplexity
  "PerplexityBot", "Perplexity-User",
  // Common Crawl, which feeds a large share of public training corpora
  "CCBot",
  // Others
  "Bytespider", "Amazonbot", "Applebot", "cohere-ai",
  "cohere-training-data-crawler", "Diffbot", "ImagesiftBot", "Omgilibot",
  "Omgili", "YouBot", "AI2Bot", "Ai2Bot-Dolma", "Timpibot", "PanguBot",
  "Webzio-Extended", "DuckAssistBot", "MistralAI-User", "Kangaroo Bot",
  "Scrapy", "TurnitinBot", "Firecrawl",
];

/** Search and SEO crawlers. */
export const SEARCH_CRAWLERS = [
  "Googlebot", "Googlebot-Image", "Bingbot", "Slurp", "DuckDuckBot",
  "Baiduspider", "YandexBot", "Sogou", "Exabot", "facebot",
  "ia_archiver", "archive.org_bot", "AhrefsBot", "SemrushBot",
  "MJ12bot", "DotBot", "PetalBot", "Bytespider",
];

export const ALL_CRAWLERS = Array.from(
  new Set([...AI_CRAWLERS, ...SEARCH_CRAWLERS]),
).sort((a, b) => a.localeCompare(b));
