/**
 * Did the reps send the drafts DealRipe wrote.
 *
 * Read-only. Imports lib/draft-adoption.ts rather than restating any of it, so
 * this cannot disagree with what the report says.
 *
 *   npx tsx scripts/draft-adoption.ts [--days 30] [--kind followup_draft]
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import {
  DRAFT_KINDS,
  adoptionRate,
  readAdoptionForWindow,
  summarise,
  type DraftKind,
} from "../lib/draft-adoption";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const LABEL: Record<string, string> = {
  sent_ours: "sent ours",
  sent_edited: "sent ours, rewritten",
  sent_own: "wrote their own",
  not_sent: "not sent",
  unknown: "could not tell",
};

async function main(): Promise<void> {
  const days = Number(arg("--days") ?? 30);
  const kind = arg("--kind") as DraftKind | undefined;
  const tenantId = await resolveTenantId("magaya");

  const { rows, notJoinable, scanned } = await readAdoptionForWindow({
    tenantId,
    days,
    kinds: kind ? [kind] : DRAFT_KINDS,
  });

  console.log(`\nDrafts DealRipe wrote in the last ${days} days: ${scanned}`);
  if (notJoinable > 0) {
    console.log(
      `  ${notJoinable} carry no message id and cannot be joined at all. Written before the id was stored, or handed to the rep as an email rather than an Outlook draft.`,
    );
  }
  console.log(`  ${rows.length} joined to a message in the rep's mailbox\n`);

  const s = summarise(rows);
  for (const k of ["sent_ours", "sent_edited", "sent_own", "not_sent", "unknown"] as const) {
    console.log(`  ${LABEL[k].padEnd(24)} ${String(s[k]).padStart(3)}`);
  }

  const { adopted, decided, rate } = adoptionRate(rows);
  console.log(
    `\n  Adoption ${rate === null ? "not measurable" : `${Math.round(rate * 100)}%`} (${adopted} of ${decided} decided).` +
      ` "Could not tell" is excluded from both sides.\n`,
  );

  const byRep = new Map<string, { adopted: number; decided: number }>();
  for (const r of rows) {
    const e = byRep.get(r.mailbox) ?? { adopted: 0, decided: 0 };
    if (r.verdict !== "unknown") e.decided++;
    if (r.verdict === "sent_ours" || r.verdict === "sent_edited") e.adopted++;
    byRep.set(r.mailbox, e);
  }
  if (byRep.size > 0) {
    console.log("  By rep");
    for (const [mailbox, e] of [...byRep].sort((a, b) => b[1].decided - a[1].decided)) {
      console.log(
        `    ${mailbox.padEnd(28)} ${e.adopted}/${e.decided}${
          e.decided === 0 ? "  (nothing decidable)" : ""
        }`,
      );
    }
    console.log("");
  }

  console.log("  Every draft");
  for (const r of rows) {
    console.log(
      `    ${r.draftedAt.slice(0, 10)}  ${r.account.padEnd(22).slice(0, 22)} ${r.kind.padEnd(15)} ${LABEL[r.verdict].padEnd(24)} ${r.reason}`,
    );
  }
  console.log("");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
