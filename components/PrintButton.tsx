"use client";

export function PrintButton() {
  return (
    <button
      onClick={() => window.print()}
      className="no-print text-[12px] px-3 py-1.5 rounded-lg border border-line bg-white text-ink/80 hover:text-ink hover:bg-bg transition"
    >
      Print / Save PDF
    </button>
  );
}
