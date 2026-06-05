"use client";

import Link from "next/link";
import { useState } from "react";
import { SlackMessage } from "@/components/SlackMessage";

type AuthState = "idle" | "pending" | "connected";

export default function RepOnboardingPage() {
  const [gmail, setGmail] = useState<AuthState>("idle");
  const [calendar, setCalendar] = useState<AuthState>("idle");

  function authorize(setter: (s: AuthState) => void) {
    setter("pending");
    setTimeout(() => setter("connected"), 1500);
  }

  const bothConnected = gmail === "connected" && calendar === "connected";

  return (
    <div className="min-h-screen bg-bg font-sans text-ink antialiased">
      <header className="border-b border-line bg-white">
        <div className="max-w-[760px] mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/" className="text-[14px] font-semibold tracking-tight text-ink hover:opacity-80 transition">
            DealRipe
          </Link>
          <Link
            href="/onboarding/complete"
            className="text-[12px] font-semibold text-muted hover:text-ink transition"
          >
            Back to setup
          </Link>
        </div>
      </header>

      <main className="max-w-[760px] mx-auto px-6 py-10">
        <div className="mb-8">
          <div className="text-[10px] uppercase tracking-wider font-bold text-muted mb-2">
            Rep view
          </div>
          <h1 className="text-[24px] sm:text-[28px] font-semibold tracking-tight text-ink leading-tight">
            What your reps see when you add them to the pilot.
          </h1>
          <p className="mt-3 text-[14px] text-muted leading-relaxed max-w-[600px]">
            A Slack DM from DealRipe Bot. Two clicks to authorize email and
            calendar. Then they are done. No login. No dashboard to learn.
          </p>
        </div>

        <SlackThread>
          <SlackMessage authorName="DealRipe Bot" authorRole="App" time="9:14 AM">
            <p>
              Hi Sarah, you&rsquo;ve been added to a DealRipe pilot by Mike
              Rogers. DealRipe helps you prep for sales calls and saves you
              time logging to Salesforce. To get started, connect your email
              and calendar.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <AuthButton
                label="Authorize Gmail"
                connectedLabel="Gmail connected"
                state={gmail}
                onClick={() => authorize(setGmail)}
              />
              <AuthButton
                label="Authorize Calendar"
                connectedLabel="Calendar connected"
                state={calendar}
                onClick={() => authorize(setCalendar)}
              />
            </div>
          </SlackMessage>

          {bothConnected && (
            <SlackMessage authorName="DealRipe Bot" authorRole="App" time="9:15 AM">
              <p>
                All set. You will get briefings 30 minutes before each
                scheduled call. First briefing coming Tuesday 10:30 AM for
                your Acme Corp call.
              </p>
            </SlackMessage>
          )}
        </SlackThread>
      </main>
    </div>
  );
}

function SlackThread({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl2 border border-line overflow-hidden">
      <div className="px-5 py-3 border-b border-line bg-bg flex items-center gap-2 text-[12px] text-muted">
        <span className="w-4 h-4 rounded-full bg-accent flex items-center justify-center text-white font-bold text-[8px]">
          DR
        </span>
        <span className="font-semibold text-ink">DealRipe</span>
        <span>·</span>
        <span>Direct message</span>
      </div>
      <div className="px-5 py-6 space-y-6">{children}</div>
    </div>
  );
}

function AuthButton({
  label,
  connectedLabel,
  state,
  onClick,
}: {
  label: string;
  connectedLabel: string;
  state: AuthState;
  onClick: () => void;
}) {
  if (state === "connected") {
    return (
      <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-accent/10 text-accent text-[12.5px] font-semibold border border-accent/30">
        <svg viewBox="0 0 16 16" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="3">
          <path d="M3 8l3.5 3.5L13 5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {connectedLabel}
      </span>
    );
  }
  if (state === "pending") {
    return (
      <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-bg border border-line text-muted text-[12.5px] font-semibold">
        <svg
          className="w-3 h-3 animate-spin"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden
        >
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.25" />
          <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        Connecting
      </span>
    );
  }
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center px-3 py-1.5 rounded-md bg-white border border-line text-ink text-[12.5px] font-semibold hover:bg-bg transition"
    >
      {label}
    </button>
  );
}
