import { DUCT, type DuctKey, type Gate } from "@/lib/aware-data";
import { DuctLetterChip, DuctStatusPill } from "./DuctStatusPill";

export function DuctGateCard({ gateKey, gate }: { gateKey: DuctKey; gate: Gate }) {
  const def = DUCT[gateKey];
  return (
    <div className="bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
      <div className="px-5 py-4 border-b border-line flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 flex-1 min-w-0">
          <DuctLetterChip letter={def.letter} status={gate.status} />
          <div className="flex-1 min-w-0">
            <div className="text-[15px] font-semibold text-ink leading-tight">
              {def.name}
            </div>
            <p className="text-[12px] text-muted mt-1 leading-snug italic">
              {def.description}
            </p>
          </div>
        </div>
        <DuctStatusPill status={gate.status} />
      </div>

      <div className="px-5 py-4 space-y-4">
        {gate.evidence.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-wider font-bold text-muted mb-2">
              Evidence
            </div>
            <ul className="space-y-2.5">
              {gate.evidence.map((e, i) => (
                <li key={i} className="flex gap-2 items-start">
                  <span className="w-1 h-4 mt-1 bg-accent rounded shrink-0" aria-hidden />
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] text-ink italic leading-snug">
                      &ldquo;{e.quote}&rdquo;
                    </p>
                    <p className="text-[11px] text-muted mt-0.5">
                      {e.speaker} &middot; Gong call {e.callDate}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {gate.missing.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-wider font-bold text-muted mb-2">
              {gate.evidence.length > 0 ? "Still missing" : "Open"}
            </div>
            <ul className="space-y-1.5">
              {gate.missing.map((m, i) => (
                <li
                  key={i}
                  className={`text-[13px] leading-snug pl-3 border-l-2 ${
                    gate.status === "red"
                      ? "border-danger text-ink"
                      : "border-warn text-ink"
                  }`}
                >
                  {m}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="pt-1 text-[11px] text-muted leading-snug">
          <span className="font-semibold text-ink">What we look for: </span>
          {def.lookFor}
        </div>
      </div>
    </div>
  );
}
