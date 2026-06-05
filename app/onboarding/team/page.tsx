"use client";

import Link from "next/link";
import { OnboardingShell } from "@/components/onboarding/OnboardingShell";
import { TEAM_MEMBERS, type TeamMember } from "@/lib/onboarding-data";
import { useOnboardingState } from "@/lib/onboarding-state";

export default function TeamPage() {
  const { state, update } = useOnboardingState();

  function toggle(id: string) {
    update((prev) => {
      const isSelected = prev.selectedTeam.includes(id);
      return {
        ...prev,
        selectedTeam: isSelected
          ? prev.selectedTeam.filter((x) => x !== id)
          : [...prev.selectedTeam, id],
      };
    });
  }

  const selectedCount = state.selectedTeam.length;
  const canContinue = selectedCount > 0;

  return (
    <OnboardingShell
      step={3}
      title="Add your sales team to the pilot."
      subtitle="Your reps will get a Slack DM with a setup link they can use in one click. They do not need to log into DealRipe."
      footer={
        <div className="flex items-center gap-3">
          <Link
            href="/onboarding/framework"
            className="text-[13px] font-semibold text-muted hover:text-ink transition"
          >
            Back
          </Link>
          <Link
            href={canContinue ? "/onboarding/deals" : "#"}
            aria-disabled={!canContinue}
            onClick={(e) => {
              if (!canContinue) e.preventDefault();
            }}
            className={`inline-flex items-center gap-2 px-5 py-2.5 rounded-xl2 text-[14px] font-semibold transition ${
              canContinue
                ? "bg-ink text-white hover:bg-ink/90"
                : "bg-bg border border-line text-muted cursor-not-allowed"
            }`}
          >
            Continue
            <span aria-hidden>→</span>
          </Link>
        </div>
      }
    >
      <div className="bg-white rounded-xl2 border border-line overflow-hidden">
        <div className="px-5 py-3 border-b border-line bg-bg flex items-center justify-between">
          <span className="text-[12px] font-semibold text-ink">
            {TEAM_MEMBERS.length} team members on your account
          </span>
          <span className="text-[12px] text-muted">
            {selectedCount} included in pilot
          </span>
        </div>
        <ul className="divide-y divide-line">
          {TEAM_MEMBERS.map((m) => (
            <TeamMemberRow
              key={m.id}
              member={m}
              included={state.selectedTeam.includes(m.id)}
              onToggle={() => toggle(m.id)}
            />
          ))}
        </ul>
      </div>
    </OnboardingShell>
  );
}

function TeamMemberRow({
  member,
  included,
  onToggle,
}: {
  member: TeamMember;
  included: boolean;
  onToggle: () => void;
}) {
  const initials = member.name
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const colorIdx = hashIndex(member.id, AVATAR_COLORS.length);

  return (
    <li className="px-5 py-3.5 flex items-center gap-4">
      <div
        className="w-9 h-9 rounded-full flex items-center justify-center text-white text-[12px] font-bold shrink-0"
        style={{ backgroundColor: AVATAR_COLORS[colorIdx] }}
        aria-hidden
      >
        {initials}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[14px] font-semibold text-ink">{member.name}</div>
        <div className="text-[12px] text-muted">{member.email}</div>
      </div>
      <span className="text-[11px] uppercase tracking-wider font-bold text-muted bg-bg border border-line rounded px-2 py-0.5 shrink-0">
        {member.role}
      </span>
      <Toggle on={included} onChange={onToggle} label="Include in pilot" />
    </li>
  );
}

function Toggle({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      onClick={onChange}
      aria-label={label}
      aria-pressed={on}
      className={`relative w-11 h-6 rounded-full transition shrink-0 ${
        on ? "bg-accent" : "bg-line"
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-transform ${
          on ? "translate-x-5" : "translate-x-0"
        }`}
      />
    </button>
  );
}

const AVATAR_COLORS = [
  "#0F172A",
  "#22c55e",
  "#0EA5E9",
  "#F59E0B",
  "#6366F1",
  "#EF4444",
];

function hashIndex(s: string, mod: number): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % mod;
}
