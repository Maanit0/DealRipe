"use client";

import { FormEvent, useState } from "react";

import { createSupabaseBrowserClient } from "@/lib/supabase-browser";

const INPUT_STYLE: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "10px 12px",
  border: "1px solid #CBD5E1",
  borderRadius: 8,
  fontSize: 14,
  color: "#0F172A",
  background: "#FFFFFF",
  fontFamily: "inherit",
};

const BUTTON_STYLE: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  border: "none",
  borderRadius: 8,
  fontSize: 14,
  fontWeight: 600,
  color: "#FFFFFF",
  background: "#10B981",
  cursor: "pointer",
  marginTop: 12,
  fontFamily: "inherit",
};

const BUTTON_DISABLED: React.CSSProperties = {
  ...BUTTON_STYLE,
  background: "#94A3B8",
  cursor: "not-allowed",
};

const NOTICE_STYLE: React.CSSProperties = {
  background: "#ECFDF5",
  border: "1px solid #A7F3D0",
  borderRadius: 8,
  padding: 12,
  color: "#065F46",
  fontSize: 14,
  lineHeight: 1.5,
};

export function LoginForm({ next }: { next?: string }) {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const supabase = createSupabaseBrowserClient();
      const callbackUrl = `${window.location.origin}/auth/callback${
        next ? `?next=${encodeURIComponent(next)}` : ""
      }`;
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: callbackUrl },
      });
      // Intentionally do NOT surface signInWithOtp errors. Showing a
      // different state for "email rate-limited" vs "email not in
      // app_users" vs "succeeded" would let an attacker enumerate which
      // emails exist. Always render the same "check your inbox" notice.
      if (error) {
        // Log to console only; never to the UI.
        console.error("[login] signInWithOtp:", error.message);
      }
    } catch (err) {
      console.error("[login] unexpected:", err);
    } finally {
      setSubmitting(false);
      setSent(true);
    }
  }

  if (sent) {
    return (
      <div style={NOTICE_STYLE}>
        If <strong>{email}</strong> is provisioned for DealRipe, a sign-in link
        is on its way. Check your inbox.
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit}>
      <label
        htmlFor="email"
        style={{
          display: "block",
          marginBottom: 8,
          fontSize: 13,
          fontWeight: 500,
          color: "#0F172A",
        }}
      >
        Work email
      </label>
      <input
        id="email"
        name="email"
        type="email"
        autoComplete="email"
        required
        placeholder="you@company.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        style={INPUT_STYLE}
      />
      <button
        type="submit"
        disabled={submitting || email.length === 0}
        style={submitting || email.length === 0 ? BUTTON_DISABLED : BUTTON_STYLE}
      >
        {submitting ? "Sending link..." : "Email me a sign-in link"}
      </button>
    </form>
  );
}
