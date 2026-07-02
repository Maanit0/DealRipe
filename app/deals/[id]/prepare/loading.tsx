export default function Loading() {
  return (
    <div className="min-h-screen bg-bg">
      <main className="max-w-[1200px] mx-auto px-6 py-7">
        <div className="bg-white rounded-xl2 shadow-card border border-line p-10 text-center">
          <div className="inline-flex items-center gap-2 text-[14px] text-ink font-medium">
            <span className="w-3.5 h-3.5 rounded-full border-2 border-line border-t-ink animate-spin" />
            Preparing briefing…
          </div>
          <p className="text-[12px] text-muted mt-2">
            Reading the deal&rsquo;s open gaps and generating the call plan.
          </p>
        </div>
      </main>
    </div>
  );
}
