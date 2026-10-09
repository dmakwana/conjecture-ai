import type { MetadataRoute } from "next";
import { AI_TRAINING_CRAWLERS } from "@/lib/crawlers";
import { SITE_URL } from "@/lib/site";

/**
 * Open to every crawler except the AI training ones named in lib/crawlers.ts.
 */
export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/" },
      { userAgent: AI_TRAINING_CRAWLERS, disallow: "/" },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
