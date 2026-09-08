import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "duck-invariant",
  description:
    "Profile a dataset in the browser and test falsifiable hypotheses about it with DuckDB.",
  // Belt and braces alongside robots.txt and the X-Robots-Tag header: a crawler
  // that reaches the page anyway is told not to index, cache or excerpt it.
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
      "max-snippet": 0,
      "max-image-preview": "none",
      "max-video-preview": 0,
    },
  },
  // The app fetches user-supplied data URLs from the browser. Without this the
  // Referer header would hand this site's address to every host you point it at.
  referrer: "no-referrer",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
