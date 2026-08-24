/**
 * Do the reps actually open what DealRipe sends them?
 *
 * Follow-through tells us what a rep DID after a briefing. It cannot separate
 * "read it and ignored it" from "never opened it", and those need completely
 * different responses: the first is a content problem, the second is a delivery
 * or timing problem. This is the only thing that separates them.
 *
 * Every briefing and recap already carries a Resend provider id;
 * app/api/webhooks/resend/route.ts records what Resend says happened to it.
 *
 * HOW HONEST THE NUMBER IS, because it will be quoted:
 *
 *   An OPEN means the mail was rendered and a tracking pixel loaded. Outlook
 *   prefetches images on some configurations, which inflates it, and a rep
 *   reading in a preview pane with images blocked never registers, which
 *   deflates it. So an open rate is a floor with noise on top.
 *
 *   A NON-OPEN on a DELIVERED message is the sturdier half and the half we
 *   actually want. "Delivered and never rendered, across eleven briefings" is a
 *   statement worth acting on; "68% open rate" is not.
 *
 *   A BOUNCE is unambiguous and is reported separately, because a briefing
 *   nobody received is a different failure from one nobody read.
 *
 *   npx tsx scripts/email-engagement.ts
 *   npx tsx scripts/email-engagement.ts --days 30 --kind briefing
 *
 * Read-only.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { repName } from "../lib/display-names";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

type Sent = { provider_id: string | null; kind: string; to_email: string; sent_at: string | null };

async function main(): Promise<void> {
  const days = Number(arg("--days") ?? 30);
  const onlyKind = arg("--kind");
  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  let q = db
    .from("sent_messages")
    .select("provider_id, kind, to_email, sent_at")
    .eq("tenant_id", tenantId)
    .gte("sent_at", since)
    .not("provider_id", "is", null);
  if (onlyKind) q = q.eq("kind", onlyKind);
  const sentRes = await q;
  if (sentRes.error) throw new Error(`sent_messages read failed: ${sentRes.error.message}`);
  const sent = (sentRes.data ?? []) as Sent[];

  const evRes = await db
    .from("email_events")
    .select("provider_id, event")
    .eq("tenant_id", tenantId)
    .gte("occurred_at", since);

  console.log(`\n${"=".repeat(78)}`);
  console.log(`WHAT HAPPENS TO WHAT DEALRIPE SENDS, last ${days} days`);
  console.log(`${"=".repeat(78)}\n`);

  if (evRes.error) {
    // The table not existing is the expected state before the migration, and
    // saying so beats a zero that looks like nobody opened anything.
    const missing = /does not exist|schema cache/i.test(evRes.error.message);
    console.log(`  ${sent.length} message(s) sent and trackable.\n`);
    console.log(
      missing
        ? `  email_events does not exist yet, so nothing is recorded.\n` +
            `  Apply supabase/add-email-events.sql, then add the webhook in Resend:\n` +
            `    URL     <your app>/api/webhooks/resend\n` +
            `    events  email.delivered, email.opened, email.clicked, email.bounced\n` +
            `    secret  put the signing secret in RESEND_WEBHOOK_SECRET\n`
        : `  Could not read email_events: ${evRes.error.message}\n`,
    );
    console.log(`  This is "not measured", NOT "nobody opened them".\n`);
    return;
  }

  const events = (evRes.data ?? []) as Array<{ provider_id: string; event: string }>;
  const byProvider = new Map<string, Set<string>>();
  for (const e of events) {
    (byProvider.get(e.provider_id) ?? byProvider.set(e.provider_id, new Set()).get(e.provider_id)!).add(e.event);
  }

  if (events.length === 0) {
    console.log(`  ${sent.length} message(s) sent and trackable, and no events recorded yet.\n`);
    console.log(`  Either the webhook is not configured in Resend, or nothing has been sent since it was.`);
    console.log(`  Read this as "not measured", never as "nobody opened them".\n`);
    return;
  }

  type Tally = { sent: number; delivered: number; opened: number; bounced: number };
  const blank = (): Tally => ({ sent: 0, delivered: 0, opened: 0, bounced: 0 });
  const byKind = new Map<string, Tally>();
  const byRep = new Map<string, Tally>();

  for (const m of sent) {
    const seen = byProvider.get(m.provider_id ?? "") ?? new Set<string>();
    const k = byKind.get(m.kind) ?? byKind.set(m.kind, blank()).get(m.kind)!;
    const rep = repName(m.to_email) ?? m.to_email;
    const r = byRep.get(rep) ?? byRep.set(rep, blank()).get(rep)!;
    for (const t of [k, r]) {
      t.sent += 1;
      if (seen.has("email.delivered")) t.delivered += 1;
      if (seen.has("email.opened")) t.opened += 1;
      if (seen.has("email.bounced")) t.bounced += 1;
    }
  }

  const row = (label: string, t: Tally) => {
    // Unopened out of DELIVERED, not out of sent: a bounced message was never
    // there to open and counting it as unread blames the reader for our
    // delivery problem.
    const unopened = Math.max(0, t.delivered - t.opened);
    console.log(
      `  ${label.padEnd(18)} sent ${String(t.sent).padStart(4)}   delivered ${String(t.delivered).padStart(4)}` +
        `   opened ${String(t.opened).padStart(4)}   never opened ${String(unopened).padStart(4)}` +
        `${t.bounced > 0 ? `   BOUNCED ${t.bounced}` : ""}`,
    );
  };

  console.log("BY WHAT WE SENT");
  for (const [k, t] of [...byKind.entries()].sort((a, b) => b[1].sent - a[1].sent)) row(k, t);
  console.log("\nBY REP");
  for (const [k, t] of [...byRep.entries()].sort((a, b) => b[1].sent - a[1].sent)) row(k, t);

  const noEvents = sent.filter((m) => !byProvider.has(m.provider_id ?? "")).length;
  if (noEvents > 0) {
    console.log(
      `\n  ${noEvents} message(s) have no events at all, which usually means they were sent before the\n` +
        `  webhook was configured. Those are not measured rather than unread.`,
    );
  }
  console.log(
    `\n  An open means the mail was rendered, not that a human read it: Outlook prefetch inflates it\n` +
      `  and a blocked-images preview pane deflates it. "Delivered and never opened" is the sturdier half.\n`,
  );
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
