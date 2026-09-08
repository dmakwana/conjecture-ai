import type { MetadataRoute } from "next";
import { ALL_CRAWLERS } from "@/lib/crawlers";

/**
 * Ask every crawler to stay away, both under the wildcard and by name.
 * See lib/crawlers.ts for why the explicit names matter.
 */
export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", disallow: "/" },
      { userAgent: ALL_CRAWLERS, disallow: "/" },
    ],
  };
}
