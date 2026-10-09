import type { Metadata } from "next";
import Link from "next/link";
import { IconGitHub } from "@/components/icons";
import { SITE_URL } from "@/lib/site";
import "./globals.css";

const REPO_URL = "https://github.com/dmakwana/conjecture-ai";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  alternates: { canonical: "/" },
  title: "conjecture-ai",
  description:
    "Profile a dataset in the browser and test falsifiable hypotheses about it with DuckDB.",
  // The app fetches user-supplied data URLs from the browser. Without this the
  // Referer header would hand this site's address to every host you point it at.
  referrer: "no-referrer",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        {children}
        <footer className="mx-auto max-w-4xl px-6 pb-10 flex items-center gap-4 text-xs muted">
          <Link href="/terms" className="underline underline-offset-2 hover:no-underline">
            Terms of use
          </Link>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="panel inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 hover:ring-2 hover:ring-blue-500/30"
          >
            <IconGitHub />
            GitHub
          </a>
        </footer>
      </body>
    </html>
  );
}
