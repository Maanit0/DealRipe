"use client";

import { useState } from "react";
import {
  getSimilarDealsIntel,
  type ObjectionPlay,
  type SimilarAccount,
} from "@/lib/similar-deals";

type Props = {
  dealId: string;
  account: string;
};

export function SimilarDealsCard({ dealId, account }: Props) {
  const intel = getSimilarDealsIntel(dealId);
  const [openId, setOpenId] = useState<string | null>(intel?.objections[0]?.id ?? null);

  if (!intel) return null;

  return (
    <section className="bg-white rounded-xl2 shadow-card border border-line p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-wider font-bold text-muted mb-1">
            Similar deals and plays
          </div>
          <h2 className="text-[18px] font-semibold tracking-tight text-ink">
            How deals like {account} were won and lost
          </h2>
        </div>
        <div className="text-right shrink-0 text-[11px] text-muted leading-snug max-w-[150px]">
          Learned from {intel.trainedOn} closed marketplace deals
        </div>
      </div>

      <p className="text-[12.5px] text-muted mt-2 leading-snug max-w-[720px]">
        {account} looks like: {intel.profileLabel}. You have won{" "}
        <span className="font-semibold text-accent">{intel.wonCount}</span> deals
        like it and lost{" "}
        <span className="font-semibold text-danger">{intel.lostCount}</span>.
      </p>

      {/* Reference accounts */}
      <div className="mt-4 flex flex-wrap gap-2">
        {intel.references.map((r) => (
          <ReferenceChip key={r.name} account={r} />
        ))}
      </div>

      {/* Objection plays */}
      <div className="mt-5 space-y-2.5">
        <div className="text-[11px] uppercase tracking-wider font-bold text-muted">
          Objections these deals raised, and what worked
        </div>
        {intel.objections.map((o) => (
          <ObjectionRow
            key={o.id}
            play={o}
            open={openId === o.id}
            onToggle={() => setOpenId(openId === o.id ? null : o.id)}
          />
        ))}
      </div>

      {/* Tied insight */}
      <div className="mt-5 bg-dangerSoft border border-danger/30 rounded-lg px-4 py-3">
        <div className="text-[10px] uppercase tracking-wider font-bold text-danger mb-1">
          What this means for {account}
        </div>
        <p className="text-[12.5px] text-ink leading-snug">{intel.tiedInsight}</p>
      </div>
    </section>
  );
}

function ReferenceChip({ account }: { account: SimilarAccount }) {
  const won = account.outcome === "won";
  return (
    <div
      className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 ${
        won ? "border-accent/40 bg-accentSoft" : "border-danger/40 bg-dangerSoft"
      }`}
    >
      <span
        className={`text-[9px] uppercase tracking-wider font-bold ${
          won ? "text-accent" : "text-danger"
        }`}
      >
        {won ? "Won" : "Lost"}
      </span>
      <span className="text-[12.5px] font-semibold text-ink">{account.name}</span>
      <span className="text-[11px] text-muted">
        {account.descriptor} &middot; {formatMoney(account.arr)}
      </span>
    </div>
  );
}

function ObjectionRow({
  play,
  open,
  onToggle,
}: {
  play: ObjectionPlay;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="border border-line rounded-lg overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full text-left px-4 py-3 hover:bg-bg transition"
        aria-expanded={open}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[13px] text-ink leading-snug italic">
              &ldquo;{play.objection}&rdquo;
            </p>
            <p className="text-[11px] text-muted mt-1">{play.frequency}</p>
          </div>
          <span
            className={`text-muted text-[13px] shrink-0 mt-0.5 transition-transform ${
              open ? "rotate-180" : ""
            }`}
            aria-hidden
          >
            ⌄
          </span>
        </div>

        <div className="mt-2.5 flex items-start gap-2">
          <span className="text-[10px] uppercase tracking-wider font-bold text-accent shrink-0 mt-0.5">
            Winning play
          </span>
          <span className="text-[12.5px] text-ink leading-snug">
            {play.winningPlay}{" "}
            <span className="text-muted">Proven at {play.provenAt}.</span>
          </span>
        </div>
      </button>

      {open && (
        <div className="px-4 pb-4 pt-1 space-y-3 border-t border-line bg-bg">
          <div>
            <div className="text-[10px] uppercase tracking-wider font-bold text-muted mb-1 mt-3">
              Evidence, {play.provenAt}
            </div>
            <p className="text-[12.5px] text-ink italic leading-snug">
              &ldquo;{play.evidenceQuote}&rdquo;
            </p>
            <p className="text-[12px] text-accent font-semibold mt-1.5">
              {play.outcome}
            </p>
          </div>
          <div className="bg-dangerSoft border border-danger/30 rounded-lg px-3 py-2.5">
            <div className="text-[10px] uppercase tracking-wider font-bold text-danger mb-1">
              What lost it, avoid
            </div>
            <p className="text-[12px] text-ink leading-snug">
              {play.losingPattern}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function formatMoney(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (Math.abs(v) >= 1000) return `$${Math.round(v / 1000)}K`;
  return `$${v}`;
}
