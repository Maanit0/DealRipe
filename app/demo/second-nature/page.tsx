import Link from "next/link";
import { NeatDemoView } from "@/components/neat/NeatDemoView";

export const metadata = {
  title: "DealRipe · Second Nature",
};

export default function SecondNatureDemoPage() {
  return (
    <div className="min-h-screen bg-bg">
      <header className="border-b border-line bg-white">
        <div className="max-w-[900px] mx-auto px-6 py-4 flex items-center gap-6">
          <Link href="/" className="text-[14px] font-semibold tracking-tight text-ink hover:opacity-80 transition">
            DealRipe
          </Link>
          <nav className="flex items-center gap-4">
            <span className="text-[12px] font-semibold text-ink">Deal &amp; closed loop</span>
            <Link href="/demo/second-nature/forecast-board" className="text-[12px] font-semibold text-muted hover:text-ink transition">
              Forecast Board
            </Link>
            <Link href="/forecast?tenant=second-nature" className="text-[12px] font-semibold text-muted hover:text-ink transition">
              Forecast Room
            </Link>
          </nav>
        </div>
      </header>
      <main className="max-w-[900px] mx-auto px-6 py-8">
        <div className="mb-5">
          <div className="text-[11px] uppercase tracking-wider font-semibold text-muted">
            Representative example · not live data · AE closed-loop flow
          </div>
          <h1 className="text-[15px] text-ink font-semibold mt-1">
            One deal, end to end: the meeting, the pre-call briefing, the call read back into Salesforce
          </h1>
        </div>
        <NeatDemoView />
      </main>
    </div>
  );
}
