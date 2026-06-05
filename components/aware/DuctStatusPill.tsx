import type { GateStatus } from "@/lib/aware-data";

const STYLES: Record<GateStatus, { bg: string; text: string; label: string }> = {
  green:  { bg: "bg-accentSoft",  text: "text-accent", label: "Evidenced" },
  yellow: { bg: "bg-warnSoft",    text: "text-warn",   label: "Partial" },
  red:    { bg: "bg-dangerSoft",  text: "text-danger", label: "Open" },
};

export function DuctStatusPill({
  status,
  label,
}: {
  status: GateStatus;
  label?: string;
}) {
  const s = STYLES[status];
  return (
    <span
      className={`inline-flex items-center text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 rounded-full ${s.bg} ${s.text}`}
    >
      {label ?? s.label}
    </span>
  );
}

export function DuctLetterChip({
  letter,
  status,
}: {
  letter: string;
  status: GateStatus;
}) {
  const ring =
    status === "green"
      ? "bg-accent text-white"
      : status === "yellow"
        ? "bg-warn text-white"
        : "bg-danger text-white";
  return (
    <span
      className={`inline-flex items-center justify-center w-7 h-7 rounded-md font-mono text-[12px] font-bold ${ring}`}
      aria-label={`${letter} status ${status}`}
    >
      {letter}
    </span>
  );
}
