/**
 * Thumbs up / down on one artifact, asked at the foot of the artifact itself.
 *
 * Alexandra Suntrup, 2026-09-02: "That would be amazing. That actually would be
 * fantastic... give some concrete kind of results for you and your team to be
 * able to see like, okay, these ones are good."
 *
 * PER ARTIFACT, NOT PER SECTION. A recap has a summary, pain points, a gap
 * audit and a demo strategy, and it is tempting to ask about each. Sub-section
 * voting collects almost nothing: deciding WHICH part to rate costs more than
 * the click is worth, so the rep rates none of them. One question at the foot
 * of the thing gets answered.
 *
 * GET, NOT POST. It has to work from Outlook, from Gmail, from a phone, with no
 * JavaScript and no session. The token carries the identity, so there is
 * nothing to log in to.
 */

import { randomUUID } from "node:crypto";

/** A fresh token for one artifact. Generated before the artifact is rendered. */
export function newFeedbackToken(): string {
  return randomUUID();
}

function baseUrl(): string {
  return (process.env.DEALRIPE_APP_URL ?? "https://app.dealripe.com").replace(/\/+$/, "");
}

export function feedbackUrl(token: string, vote: "up" | "down"): string {
  return `${baseUrl()}/api/feedback?id=${encodeURIComponent(token)}&v=${vote}`;
}

const SANS = "-apple-system,'Segoe UI',Helvetica,Arial,sans-serif";

/**
 * The footer line.
 *
 * Deliberately small and last. This is a question DealRipe is asking for its own
 * benefit, and it must never compete with the artifact the rep opened the mail
 * to read.
 */
export function feedbackFooterHtml(token: string, label = "Was this useful?"): string {
  return (
    `<div style="margin-top:18px;padding-top:12px;border-top:1px solid #E5E7EB;font-family:${SANS};font-size:12px;color:#6B7280;">` +
    `${label} ` +
    `<a href="${feedbackUrl(token, "up")}" style="color:#059669;text-decoration:none;font-weight:600;">Yes</a>` +
    `<span style="color:#D1D5DB;"> &nbsp;|&nbsp; </span>` +
    `<a href="${feedbackUrl(token, "down")}" style="color:#B45309;text-decoration:none;font-weight:600;">No</a>` +
    `</div>`
  );
}

export function feedbackFooterText(token: string, label = "Was this useful?"): string {
  return `${label}  Yes: ${feedbackUrl(token, "up")}   No: ${feedbackUrl(token, "down")}`;
}
