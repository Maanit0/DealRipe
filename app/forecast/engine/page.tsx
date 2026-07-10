import Link from "next/link";
import { LearningEngine } from "@/components/LearningEngine";
import { getLearningData } from "@/lib/similar-deals";

export default function LearningEnginePage() {
  const { workedRules, insights, tiedInsight } = getLearningData();

  return (
    <div className="min-h-screen bg-bg font-sans text-ink antialiased">
      <header className="border-b border-line bg-white">
        <div className="max-w-[1080px] mx-auto px-6 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-6">
            <Link
              href="/"
              className="text-[14px] font-semibold tracking-tight text-ink hover:opacity-80 transition"
            >
              DealRipe
            </Link>
            <nav className="flex items-center gap-4">
              <Link
                href="/forecast"
                className="text-[12px] font-semibold text-muted hover:text-ink transition"
              >
                Forecast Room
              </Link>
              <Link
                href="/pipeline"
                className="text-[12px] font-semibold text-muted hover:text-ink transition"
              >
                Pipeline
              </Link>
              <span className="text-[12px] font-semibold text-ink">
                How it learns
              </span>
            </nav>
          </div>
          <Link
            href="/forecast"
            className="text-[12px] font-semibold text-muted hover:text-ink transition"
          >
            ← Back to Forecast Room
          </Link>
        </div>
      </header>

      <main className="max-w-[1080px] mx-auto px-6 pt-8 pb-24">
        <div className="border-b border-line pb-4 mb-2">
          <h1 className="text-[21px] font-bold tracking-tight text-ink">
            How DealRipe learns your winning motion
          </h1>
          <p className="text-[12.5px] text-muted mt-1">
            The closed loop that turns your own deals into sharper calls, every
            week.
          </p>
        </div>
        <LearningEngine
          workedRules={workedRules}
          insights={insights}
          tiedInsight={tiedInsight}
        />
      </main>
    </div>
  );
}
