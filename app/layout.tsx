import "./globals.css";
import type { Metadata } from "next";
import { DemoStateProvider } from "@/components/DemoStateProvider";

export const metadata: Metadata = {
  title: "DealRipe — Opportunity Control",
  description: "System interrogation, data interrogation, activity basis.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sheet">
        <DemoStateProvider>{children}</DemoStateProvider>
      </body>
    </html>
  );
}
