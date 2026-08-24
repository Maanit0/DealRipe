/**
 * Resend delivery and engagement webhooks.
 *
 * DealRipe has sent 129 briefings and 102 recaps, every one carrying a Resend
 * provider id on its sent_messages row, and until now nothing received the
 * events Resend emits against those ids. So "do the reps actually read this"
 * had a complete data path and no endpoint at the end of it, and that question
 * decides a renewal: follow-through tells us what a rep DID after a briefing,
 * never whether they opened it, and "read it and ignored it" needs a completely
 * different response from "never opened it".
 *
 * VERIFICATION
 *
 * Resend signs with Svix headers (svix-id, svix-timestamp, svix-signature).
 * The svix package is not a dependency and this verifies the HMAC directly,
 * which is a dozen lines and avoids adding a package to a live cron deployment
 * for one route. The scheme is documented and stable: base64 HMAC-SHA256 over
 * "{id}.{timestamp}.{body}", keyed on the secret with its "whsec_" prefix
 * stripped and the remainder base64-decoded.
 *
 * WITHOUT A SECRET CONFIGURED THIS REFUSES EVERYTHING. An unauthenticated
 * webhook endpoint is an open write into our own database, and the failure mode
 * of accepting unsigned events is silent and permanent. Set
 * RESEND_WEBHOOK_SECRET or this returns 503 and stores nothing.
 *
 * WHAT IT STORES: the event, the provider id, and Resend's own timestamp. No
 * recipient, no body, no user agent. sent_messages already holds who it went
 * to, and Magaya is under NDA.
 */

import crypto from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { envValue } from "@/lib/env-value";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/** Resend's own five-minute replay window, matching Svix's default. */
const TOLERANCE_SECONDS = 5 * 60;

/**
 * Constant-time compare over the candidate signatures.
 *
 * The svix-signature header carries a space-separated list ("v1,sig v1,sig")
 * because a secret can be rotated with both live, so a single-signature
 * comparison rejects valid events during any rotation.
 */
function signatureMatches(header: string, expected: string): boolean {
  const want = Buffer.from(expected);
  for (const part of header.split(" ")) {
    const sig = part.includes(",") ? part.slice(part.indexOf(",") + 1) : part;
    const got = Buffer.from(sig);
    if (got.length === want.length && crypto.timingSafeEqual(got, want)) return true;
  }
  return false;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = envValue("RESEND_WEBHOOK_SECRET");
  if (!secret) {
    // Refusing is the only safe default: this endpoint writes to our database
    // and an unsigned event is indistinguishable from a forged one.
    console.error("[webhooks/resend] RESEND_WEBHOOK_SECRET is not set; refusing to accept unsigned events");
    return NextResponse.json({ ok: false, reason: "webhook secret not configured" }, { status: 503 });
  }

  const id = req.headers.get("svix-id");
  const timestamp = req.headers.get("svix-timestamp");
  const signature = req.headers.get("svix-signature");
  if (!id || !timestamp || !signature) {
    return NextResponse.json({ ok: false, reason: "missing signature headers" }, { status: 400 });
  }

  // Replay guard. Without it a captured request stays valid forever.
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > TOLERANCE_SECONDS) {
    return NextResponse.json({ ok: false, reason: "timestamp outside tolerance" }, { status: 400 });
  }

  // The RAW body, byte for byte. Re-serialising parsed JSON changes key order
  // and whitespace and the HMAC stops matching, which presents as "Resend is
  // sending bad signatures" and is not.
  const raw = await req.text();
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = crypto.createHmac("sha256", key).update(`${id}.${timestamp}.${raw}`).digest("base64");
  if (!signatureMatches(signature, expected)) {
    console.warn("[webhooks/resend] signature mismatch, rejecting");
    return NextResponse.json({ ok: false, reason: "bad signature" }, { status: 401 });
  }

  let payload: { type?: string; created_at?: string; data?: { email_id?: string } };
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false, reason: "body is not JSON" }, { status: 400 });
  }

  const providerId = payload.data?.email_id;
  const event = payload.type;
  if (!providerId || !event) {
    // A 200 on purpose: the event is malformed for us and retrying will not
    // improve it, and leaving it unacknowledged makes Resend retry forever.
    console.warn(`[webhooks/resend] event with no email_id or type: ${raw.slice(0, 200)}`);
    return NextResponse.json({ ok: true, stored: false, reason: "no email_id or type" });
  }

  const db = supabaseAdmin();

  // The tenant comes from the message we sent, never from the payload. Resend
  // does not know our tenants and anything in the body is attacker-controlled
  // even after the signature check, because a compromised Resend key would
  // still sign.
  const msg = await db
    .from("sent_messages")
    .select("tenant_id")
    .eq("provider_id", providerId)
    .limit(1)
    .maybeSingle();

  const res = await db.from("email_events").insert({
    tenant_id: msg.data?.tenant_id ?? null,
    provider_id: providerId,
    event,
    // Resend's timestamp, not ours: a webhook retried an hour later must not
    // look like an open an hour later.
    occurred_at: payload.created_at ?? new Date().toISOString(),
  } as never);

  if (res.error) {
    // The dedupe index firing is success, not failure: Resend retries until it
    // sees a 2xx, so the same event arrives several times by design.
    if (/duplicate key|already exists/i.test(res.error.message)) {
      return NextResponse.json({ ok: true, stored: false, reason: "already recorded" });
    }
    // A real failure gets a 500 so Resend retries rather than dropping it.
    console.error(`[webhooks/resend] insert failed: ${res.error.message}`);
    return NextResponse.json({ ok: false, reason: res.error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, stored: true });
}
