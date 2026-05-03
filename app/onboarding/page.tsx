"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getSession, markOnboarded } from "@/lib/auth";
import { SCOTSMAN_FIELDS } from "@/lib/scotsman";

type Step = 1 | 2 | 3;

export default function Onboarding() {
  const router = useRouter();
  const [step, setStep] = useState<Step>(1);

  useEffect(() => {
    if (!getSession()) router.replace("/login");
  }, [router]);

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-[560px]">
        <Progress step={step} />
        <div className="mt-6 bg-white rounded-xl2 shadow-card border border-line p-8">
          {step === 1 && <Step1Connect onNext={() => setStep(2)} />}
          {step === 2 && <Step2Framework onNext={() => setStep(3)} />}
          {step === 3 && (
            <Step3Playbook
              onNext={() => {
                markOnboarded();
                router.push("/dashboard");
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function Progress({ step }: { step: Step }) {
  return (
    <div className="flex items-center justify-center gap-2">
      {[1, 2, 3].map(n => (
        <div key={n} className="flex items-center gap-2">
          <div
            className={`h-1.5 w-12 rounded-full transition ${
              step >= (n as Step) ? "bg-navy" : "bg-line"
            }`}
          />
        </div>
      ))}
      <div className="ml-3 text-[12px] text-muted font-medium">Step {step} of 3</div>
    </div>
  );
}

/* ----- STEP 1 ----- */
function Step1Connect({ onNext }: { onNext: () => void }) {
  const [connecting, setConnecting] = useState<string | null>(null);

  function connect(name: string) {
    setConnecting(name);
    setTimeout(onNext, 2000);
  }

  return (
    <div className="text-center">
      <IconCircle>
        <svg viewBox="0 0 24 24" fill="none" className="w-7 h-7" stroke="currentColor" strokeWidth="2">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </IconCircle>
      <h1 className="text-[22px] font-semibold text-ink mt-5">Let&apos;s set up your pipeline</h1>
      <p className="text-sm text-muted mt-1.5 max-w-[420px] mx-auto">
        Connect your existing tools. DealRipe will import your deals and qualification framework
        automatically.
      </p>

      {connecting ? (
        <div className="mt-8 flex flex-col items-center gap-3 py-6">
          <div className="w-7 h-7 border-2 border-navy/20 border-t-navy rounded-full animate-spin" />
          <div className="text-sm text-muted">Connecting to {connecting}…</div>
        </div>
      ) : (
        <div className="mt-7 space-y-2.5">
          <ConnectButton label="Connect Salesforce" onClick={() => connect("Salesforce")} />
          <ConnectButton label="Connect HubSpot" onClick={() => connect("HubSpot")} />
          <ConnectButton label="Upload CSV" onClick={() => connect("CSV")} />
        </div>
      )}
    </div>
  );
}

function ConnectButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full bg-white border border-line hover:border-navy hover:bg-navy/[0.02] text-ink py-3 rounded-lg text-sm font-medium transition flex items-center justify-center gap-2"
    >
      {label}
    </button>
  );
}

/* ----- STEP 2 ----- */
function Step2Framework({ onNext }: { onNext: () => void }) {
  const preview = SCOTSMAN_FIELDS.slice(0, 5);
  return (
    <div>
      <div className="text-center">
        <IconCircle>
          <svg viewBox="0 0 24 24" fill="none" className="w-7 h-7" stroke="currentColor" strokeWidth="2">
            <path d="M9 11l3 3L22 4" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </IconCircle>
        <h1 className="text-[22px] font-semibold text-ink mt-5">Import your SCOTSMAN framework</h1>
        <p className="text-sm text-muted mt-1.5">
          We detected your qualification framework. Confirm the import.
        </p>
      </div>

      <div className="mt-6 border border-line rounded-lg overflow-hidden">
        <div className="bg-bg px-4 py-2.5 text-[11px] uppercase tracking-wide text-muted font-semibold flex justify-between">
          <span>Field</span>
          <span>18 qualification fields detected</span>
        </div>
        {preview.map(f => (
          <div
            key={f.id}
            className="px-4 py-2.5 flex items-start gap-3 border-t border-line first:border-t-0 text-sm"
          >
            <span className="font-mono text-[11px] text-muted w-8 mt-0.5">{f.id}</span>
            <span className="font-medium text-ink w-20 shrink-0">{f.category}</span>
            <span className="text-ink/80">{f.question}</span>
          </div>
        ))}
        <div className="px-4 py-2.5 text-[12px] text-muted border-t border-line bg-bg">
          + 13 more fields
        </div>
      </div>

      <button
        onClick={onNext}
        className="mt-6 w-full bg-navy hover:bg-navy2 text-white py-3 rounded-lg text-sm font-semibold transition"
      >
        Import 18 fields →
      </button>
    </div>
  );
}

/* ----- STEP 3 ----- */
function Step3Playbook({ onNext }: { onNext: () => void }) {
  const [progress, setProgress] = useState(0);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const start = Date.now();
    const id = setInterval(() => {
      const pct = Math.min(100, ((Date.now() - start) / 2000) * 100);
      setProgress(pct);
      if (pct >= 100) {
        clearInterval(id);
        setDone(true);
      }
    }, 50);
    return () => clearInterval(id);
  }, []);

  return (
    <div>
      <div className="text-center">
        <IconCircle>
          <svg viewBox="0 0 24 24" fill="none" className="w-7 h-7" stroke="currentColor" strokeWidth="2">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </IconCircle>
        <h1 className="text-[22px] font-semibold text-ink mt-5">Import your discovery questions</h1>
        <p className="text-sm text-muted mt-1.5">
          {done ? "47 questions imported successfully." : "We found your SPIN question bank. Importing now."}
        </p>
      </div>

      <div className="mt-6 h-2 bg-line rounded-full overflow-hidden">
        <div
          className="h-full bg-accent transition-all"
          style={{ width: `${progress}%` }}
        />
      </div>

      {done && (
        <div className="mt-5 grid grid-cols-2 gap-2.5">
          <Stat n={12} label="Situation" />
          <Stat n={14} label="Problem" />
          <Stat n={11} label="Implication" />
          <Stat n={10} label="Need-Payoff" />
        </div>
      )}

      <button
        onClick={onNext}
        disabled={!done}
        className="mt-6 w-full bg-navy hover:bg-navy2 disabled:bg-navy/30 text-white py-3 rounded-lg text-sm font-semibold transition"
      >
        Go to my pipeline →
      </button>
    </div>
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <div className="border border-line rounded-lg p-3">
      <div className="text-xl font-semibold text-ink">{n}</div>
      <div className="text-[11px] uppercase tracking-wide text-muted font-medium">
        {label} questions
      </div>
    </div>
  );
}

function IconCircle({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-14 h-14 rounded-full bg-navy text-white flex items-center justify-center">
      {children}
    </div>
  );
}
