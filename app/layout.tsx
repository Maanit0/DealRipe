import "./globals.css";
import type { Metadata } from "next";
import { DemoStateProvider } from "@/components/DemoStateProvider";

const SITE = "https://dealripe.com";

export const metadata: Metadata = {
  // Absolute base so the OG image resolves for crawlers, which do not follow
  // relative paths.
  metadataBase: new URL(SITE),
  title: "DealRipe",
  description:
    "An AI agent on every open opportunity, tuned to your best rep.",
  openGraph: {
    type: "website",
    url: SITE,
    siteName: "DealRipe",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "DealRipe" }],
  },
  twitter: { card: "summary_large_image", images: ["/og.png"] },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Scroll-reveal starts elements hidden. Without JS nothing would ever
            add the class that shows them, so restore them outright. */}
        <noscript>
          <style>{`.dr-reveal,.dr-reveal .dr-item,.dr-reveal .dr-dot{opacity:1!important;transform:none!important}`}</style>
        </noscript>
      </head>
      <body className="font-sheet">
        <DemoStateProvider>{children}</DemoStateProvider>
      </body>
    </html>
  );
}
