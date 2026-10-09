/**
 * The site is public and meant to be found, so search engines and AI search
 * and assistant crawlers are welcome. Only crawlers that gather AI training
 * data are asked to stay away.
 *
 * They have to be named: a disallow under `User-agent: *` would block search
 * too. Google-Extended and Applebot-Extended are not crawlers at all but
 * training opt-out tokens, honoured only when addressed by name; Googlebot and
 * Applebot keep indexing for search either way.
 *
 * None of this is enforcement. robots.txt is a request that a crawler is free
 * to ignore.
 */
export const AI_TRAINING_CRAWLERS = [
  // OpenAI, Anthropic
  "GPTBot", "ClaudeBot", "anthropic-ai",
  // Google / Apple training opt-out tokens (only honoured when named)
  "Google-Extended", "Applebot-Extended",
  // Common Crawl, which feeds a large share of public training corpora
  "CCBot",
  // Others
  "meta-externalagent", "Bytespider", "cohere-training-data-crawler",
  "AI2Bot", "Ai2Bot-Dolma", "Diffbot", "ImagesiftBot", "Omgilibot", "Omgili",
  "PanguBot", "Timpibot", "Webzio-Extended",
];
