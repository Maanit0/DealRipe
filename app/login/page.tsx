"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { login, isOnboarded } from "@/lib/auth";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("paul@topsort.com");
  const [password, setPassword] = useState("demo123");
  const [error, setError] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const user = login(email, password);
    if (!user) {
      setError("Invalid email or password.");
      return;
    }
    router.push(isOnboarded() ? "/dashboard" : "/onboarding");
  }

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-4">
      <div className="w-full max-w-[400px]">
        <div className="flex items-center justify-center gap-2 mb-8">
          <div className="w-9 h-9 rounded-lg bg-navy flex items-center justify-center">
            <div className="w-4 h-4 rounded-sm bg-accent" />
          </div>
          <span className="text-xl font-semibold tracking-tight text-ink">DealRipe</span>
        </div>

        <div className="bg-white rounded-xl2 shadow-card border border-line p-8">
          <h1 className="text-[22px] font-semibold text-ink mb-1">Sign in</h1>
          <p className="text-sm text-muted mb-6">Welcome back to DealRipe.</p>

          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="block text-[12px] font-medium text-ink mb-1.5">Email</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                className="w-full px-3 py-2.5 border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-navy/10 focus:border-navy"
              />
            </div>
            <div>
              <label className="block text-[12px] font-medium text-ink mb-1.5">Password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="w-full px-3 py-2.5 border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-navy/10 focus:border-navy"
              />
            </div>
            {error && <div className="text-sm text-danger">{error}</div>}
            <button
              type="submit"
              className="w-full bg-navy text-white py-2.5 rounded-lg text-sm font-semibold hover:bg-navy2 transition"
            >
              Sign in
            </button>
          </form>

          <div className="mt-6 pt-6 border-t border-line">
            <div className="text-[11px] uppercase tracking-wide text-muted font-medium mb-2">
              Demo accounts
            </div>
            <div className="space-y-1.5 text-[12px] text-ink">
              <button
                type="button"
                onClick={() => { setEmail("paul@topsort.com"); setPassword("demo123"); }}
                className="block w-full text-left hover:text-navy"
              >
                <span className="font-medium">paul@topsort.com</span>
                <span className="text-muted"> · CRO (sees all deals)</span>
              </button>
              <button
                type="button"
                onClick={() => { setEmail("regina@topsort.com"); setPassword("demo123"); }}
                className="block w-full text-left hover:text-navy"
              >
                <span className="font-medium">regina@topsort.com</span>
                <span className="text-muted"> · AE (sees her deals only)</span>
              </button>
              <div className="text-muted">Password: <span className="font-mono">demo123</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
