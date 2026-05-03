"use client";

import { useEffect, useState } from "react";
import { Deal } from "@/lib/deals";
import { CallScore, CRITERIA } from "@/lib/scoring";
import { postJson, getJson } from "@/lib/fetcher";

type QuestionGroup = {
  fieldId: string;
  fieldLabel: string;
  category: string;
  questions: { spinType: string; text: string; whatYouLearn: string }[];
};

type Stakeholder = {
  role: string;
  whyMissing: string;
  likelyPersona: "Innovator" | "Conservative" | "Risk-Averse";
  howToGetInFront: string;
  discoveryQuestions: string[];
  desiredOutcome: string;
};

export default function RepView({
  deal,
  allMissing,
}: {
  deal: Deal;
  allMissing: string[];
}) {
  const missingAuthority = allMissing.filter(id => id.startsWith("A"));

  const [groups, setGroups] = useState<QuestionGroup[] | null>(null);
  const [stakeholders, setStakeholders] = useState<Stakeholder[] | null>(null);
  const [activityBasis, setActivityBasis] = useState<string | null>(null);
  const [asked, setAsked] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scores, setScores] = useState<CallScore[]>([]);

  // Auto-load on mount / deal change
  useEffect(() => {
    setGroups(null);
    setStakeholders(null);
    setActivityBasis(null);
    setError(null);
    if (allMissing.length > 0) void loadQuestions();
    else setGroups([]);
    if (missingAuthority.length > 0) void loadPersona();
    void loadScores();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deal.id]);

  async function loadQuestions() {
    setLoading("questions");
    setError(null);
    try {
      const data = await postJson("/api/questions", { deal, missingIds: allMissing });
      setGroups(data.groups || []);
    } catch (e: any) {
      setError(e.message);
      setGroups([]);
    } finally {
      setLoading(null);
    }
  }

  async function loadPersona() {
    try {
      const data = await postJson("/api/persona", {
        deal,
        missingAuthorityIds: missingAuthority,
      });
      setStakeholders(data.stakeholders || []);
    } catch (e: any) {
      console.warn(e);
    }
  }

  async function loadScores() {
    try {
      const data = await getJson(`/api/scores?dealId=${deal.id}`);
      setScores(data.scores || []);
    } catch {}
  }

  async function generateActivityBasis() {
    setLoading("activity");
    setError(null);
    try {
      const unasked: { fieldId: string; text: string }[] = [];
      (groups || []).forEach(g =>
        g.questions.forEach((q, i) => {
          const key = `${g.fieldId}:${i}`;
          if (!asked[key]) unasked.push({ fieldId: g.fieldId, text: q.text });
        })
      );
      const data = await postJson("/api/activity-basis", {
        deal,
        missingIds: allMissing,
        unaskedQuestions: unasked,
      });
      setActivityBasis(data.activityBasis);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="space-y-4 lg:sticky lg:top-5">
      {/* Discovery questions */}
      <div className="bg-white rounded-xl2 shadow-card border border-line p-5">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-[15px] font-semibold text-ink">Discovery questions</h2>
          {loading === "questions" && (
            <span className="text-[11px] text-muted">Generating…</span>
          )}
        </div>
        <p className="text-[12px] text-muted mb-4">
          Tick the questions you've already asked. Unticked questions land in the call prep.
        </p>

        {!groups && loading !== "questions" && allMissing.length > 0 && (
          <div className="text-[12px] text-muted">Loading…</div>
        )}
        {groups && groups.length === 0 && allMissing.length === 0 && (
          <div className="text-[12px] text-muted">All 18 fields confirmed. Nothing to ask.</div>
        )}

        <div className="space-y-4">
          {(groups || []).map(g => (
            <div key={g.fieldId}>
              <div className="text-[11px] uppercase tracking-wide font-semibold text-muted mb-2">
                <span className="text-danger font-mono mr-1.5">{g.fieldId}</span>
                {g.fieldLabel}
              </div>
              <div className="space-y-2">
                {g.questions.map((q, i) => {
                  const key = `${g.fieldId}:${i}`;
                  const isAsked = !!asked[key];
                  return (
                    <label
                      key={i}
                      className={`flex gap-2.5 p-3 rounded-lg cursor-pointer border transition ${
                        isAsked
                          ? "bg-accentSoft/60 border-accent/40"
                          : "bg-bg border-line hover:border-navy/30"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isAsked}
                        onChange={() => setAsked(a => ({ ...a, [key]: !a[key] }))}
                        className="mt-0.5 w-[18px] h-[18px] accent-accent shrink-0"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-[10px] uppercase tracking-wide text-muted font-semibold">
                          {q.spinType} · Asked already?
                        </div>
                        <div
                          className={`text-[13px] mt-0.5 ${
                            isAsked ? "line-through text-muted" : "text-ink"
                          }`}
                        >
                          {q.text}
                        </div>
                        <div className="text-[11px] text-muted mt-1">
                          <span className="font-medium">What you learn:</span> {q.whatYouLearn}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Persona */}
      {stakeholders && stakeholders.length > 0 && (
        <div className="bg-white rounded-xl2 shadow-card border border-line p-5">
          <h2 className="text-[15px] font-semibold text-ink mb-3">Stakeholders to reach</h2>
          <div className="space-y-3">
            {stakeholders.map((s, i) => (
              <PersonaCard key={i} s={s} />
            ))}
          </div>
        </div>
      )}

      {/* Activity Basis button */}
      <button
        onClick={generateActivityBasis}
        disabled={loading !== null || !groups}
        className="w-full bg-navy hover:bg-navy2 disabled:bg-navy/30 text-white py-3.5 rounded-xl2 text-sm font-semibold transition shadow-card"
      >
        {loading === "activity" ? "Building…" : "Generate Activity Basis for next call"}
      </button>

      {error && (
        <div className="bg-dangerSoft border border-danger/30 text-danger rounded-lg p-3 text-[12px]">
          <div className="font-semibold mb-0.5">AI request failed</div>
          {error}
        </div>
      )}

      {activityBasis && (
        <div className="bg-white rounded-xl2 shadow-card border border-line p-5">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-[15px] font-semibold text-ink">Activity Basis — Next Call</h2>
            <button
              onClick={() => navigator.clipboard.writeText(activityBasis)}
              className="text-[11px] text-muted hover:text-navy"
            >
              Copy
            </button>
          </div>
          <pre className="whitespace-pre-wrap font-mono text-[12px] text-ink leading-relaxed">
            {activityBasis}
          </pre>
        </div>
      )}

      {/* Post-call scoring */}
      <PostCallPanel deal={deal} allMissing={allMissing} onScored={loadScores} scores={scores} />
    </div>
  );
}

/* ---------- Post-call notes panel ---------- */
function PostCallPanel({
  deal,
  allMissing,
  onScored,
  scores,
}: {
  deal: Deal;
  allMissing: string[];
  onScored: () => void;
  scores: CallScore[];
}) {
  const [notes, setNotes] = useState("");
  const [scoring, setScoring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [latest, setLatest] = useState<CallScore | null>(scores[0] || null);

  useEffect(() => {
    setLatest(scores[0] || null);
  }, [scores]);

  async function score() {
    setScoring(true);
    setError(null);
    try {
      const data = await postJson("/api/score-call", {
        dealId: deal.id,
        dealName: deal.name,
        ae: deal.ae,
        notes,
        missingIds: allMissing,
      });
      setLatest(data.score);
      setNotes("");
      onScored();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setScoring(false);
    }
  }

  return (
    <div className="bg-white rounded-xl2 shadow-card border border-line p-5">
      <h2 className="text-[15px] font-semibold text-ink mb-1">Log post-call notes</h2>
      <p className="text-[12px] text-muted mb-3">
        Paste notes from the call you just had. DealRipe scores them against Paul's 6 criteria
        and updates SCOTSMAN.
      </p>
      <textarea
        value={notes}
        onChange={e => setNotes(e.target.value)}
        placeholder="What did you cover? Who was on the call? What did they commit to? Did you book the next meeting?"
        className="w-full h-28 px-3 py-2 border border-line rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-navy/10 focus:border-navy resize-none"
      />
      <button
        onClick={score}
        disabled={scoring || notes.trim().length < 20}
        className="mt-3 w-full bg-accent hover:bg-accent/90 disabled:bg-accent/30 text-white py-2.5 rounded-lg text-sm font-semibold transition"
      >
        {scoring ? "Scoring…" : "Score this call"}
      </button>
      {error && (
        <div className="mt-3 bg-dangerSoft border border-danger/30 text-danger rounded-lg p-2.5 text-[11px]">
          {error}
        </div>
      )}

      {latest && (
        <div className="mt-4 pt-4 border-t border-line">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[12px] uppercase tracking-wide font-semibold text-muted">
              Latest call score
            </div>
            <div className="text-[13px] font-semibold text-ink">{latest.overall}/6</div>
          </div>
          <CallScoreList score={latest} />
          {latest.summary && (
            <div className="mt-2 text-[12px] text-ink/80 italic">"{latest.summary}"</div>
          )}
        </div>
      )}
    </div>
  );
}

export function CallScoreList({ score }: { score: CallScore }) {
  return (
    <div className="space-y-1.5">
      {score.criteria.map(c => {
        const isCardinal = c.key === "next_meeting";
        return (
          <div key={c.key} className="flex items-start gap-2">
            <CheckOrX passed={c.passed} />
            <div className="flex-1 min-w-0">
              <div className={`text-[12px] ${c.passed ? "text-ink" : "text-danger"} ${isCardinal ? "font-semibold" : ""}`}>
                {c.label}
                {isCardinal && (
                  <span className="ml-1.5 text-[9px] uppercase tracking-wide font-bold text-danger">
                    Cardinal rule
                  </span>
                )}
              </div>
              <div className="text-[11px] text-muted mt-0.5">{c.evidence}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CheckOrX({ passed }: { passed: boolean }) {
  return passed ? (
    <div className="w-[16px] h-[16px] rounded-full bg-accent text-white flex items-center justify-center mt-0.5 shrink-0">
      <svg viewBox="0 0 16 16" className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth="3">
        <path d="M3 8l3.5 3.5L13 5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  ) : (
    <div className="w-[16px] h-[16px] rounded-full bg-danger text-white flex items-center justify-center mt-0.5 shrink-0">
      <svg viewBox="0 0 16 16" className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth="3">
        <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
      </svg>
    </div>
  );
}

/* ---------- Persona card ---------- */
function PersonaCard({ s }: { s: Stakeholder }) {
  const personaStyle = {
    Innovator: "bg-accentSoft text-accent",
    Conservative: "bg-blue-50 text-blue-600",
    "Risk-Averse": "bg-warnSoft text-warn",
  }[s.likelyPersona];
  return (
    <div className="border border-line rounded-lg p-3.5">
      <div className="flex items-center justify-between mb-1">
        <div className="text-[14px] font-semibold text-ink">{s.role}</div>
        <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${personaStyle}`}>
          {s.likelyPersona}
        </span>
      </div>
      <div className="text-[11px] text-muted mb-2">{s.whyMissing}</div>
      <div className="text-[12px] text-ink mb-2">
        <span className="font-medium">How to reach:</span> {s.howToGetInFront}
      </div>
      <div className="text-[11px] text-muted font-medium mb-1">Confirm persona by asking:</div>
      <ul className="list-disc list-inside text-[12px] text-ink/80 space-y-0.5 mb-2">
        {s.discoveryQuestions.map((q, i) => (
          <li key={i}>{q}</li>
        ))}
      </ul>
      <div className="mt-2 p-2 bg-accentSoft border-l-2 border-accent text-[12px] text-ink">
        <span className="font-semibold">Desired outcome:</span> {s.desiredOutcome}
      </div>
    </div>
  );
}
