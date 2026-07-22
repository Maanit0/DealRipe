/**
 * Daily deal-hygiene audit.
 *
 * Walks every deal DealRipe has captured a call on and checks that the UI, the
 * transcripts, who was actually on the call, and the stored stakeholders agree.
 * Safe issues are auto-fixed (no CRM writes, no Rolldog contact); anything
 * ambiguous or touching Rolldog is surfaced for review. Designed to run headless
 * on a cron (apply = true) and also to power a read-only /audit page
 * (apply = false, a dry run that changes nothing).
 *
 * Auto-fixes, all local to DealRipe's own Postgres:
 *  - Backfill a deal's rep_email from the pilot rep map when it is missing.
 *  - Re-extract contacts for a deal whose latest call has a customer stakeholder
 *    who spoke but was never captured as a contact.
 */

import { getDealAttendanceHistory } from "./attendance";
import { extractContactsFromTranscript, upsertDealContacts } from "./contacts-extract";
import { repEmailForDeal, rolldogOppIdForDeal } from "./pilot-config";
import { supabaseAdmin } from "./supabase";

const NO_CONTENT = new Set(["no_conversation", "no_show", "rescheduled", "placeholder", "capture_failed"]);

export type AuditSeverity = "info" | "warn" | "error";

export type AuditFinding = {
  dealId: string;
  account: string;
  severity: AuditSeverity;
  type: string; // machine key, e.g. "missing_rep"
  message: string; // plain-language description
  fixed: boolean; // auto-fixed this run
  action?: string; // what to do if not auto-fixed
};

export type AuditReport = {
  ranAt: string;
  applied: boolean;
  dealsChecked: number;
  fixedCount: number;
  findings: AuditFinding[];
};

type DealRow = {
  id: string;
  account: string;
  external_id: string | null;
  rep_email: string | null;
  rolldog_opportunity_id: string | null;
  framework_id: string | null;
};

type CallRow = {
  id: string;
  scheduled_start: string | null;
  call_date: string | null;
  outcome: string | null;
  has_been_extracted: boolean;
  meeting_type: string | null;
};

function norm(name: string): string {
  return name.toLowerCase().replace(/[^a-záéíóúñü ]+/gi, " ").trim();
}

export async function runDailyAudit(
  tenantId: string,
  opts: { apply?: boolean } = {},
): Promise<AuditReport> {
  const apply = opts.apply ?? false;
  const db = supabaseAdmin();
  const findings: AuditFinding[] = [];
  let fixedCount = 0;

  const dealsRes = await db
    .from("deals")
    .select("id, account, external_id, rep_email, rolldog_opportunity_id, framework_id")
    .eq("tenant_id", tenantId);
  const deals = (dealsRes.data ?? []) as DealRow[];

  const now = Date.now();
  let dealsChecked = 0;

  for (const deal of deals) {
    const callsRes = await db
      .from("calls")
      .select("id, scheduled_start, call_date, outcome, has_been_extracted, meeting_type")
      .eq("tenant_id", tenantId)
      .eq("deal_id", deal.id)
      .order("scheduled_start", { ascending: false });
    const calls = (callsRes.data ?? []) as CallRow[];

    // Skip non-opportunity deals (every classified call is existing-customer or
    // internal), the same exclusion the pipeline and digest apply. A deal stays
    // in scope if any call is a new opportunity or is still unclassified.
    const classified = calls.map((c) => c.meeting_type).filter((t): t is string => !!t);
    if (classified.length > 0 && classified.every((t) => t !== "new_opportunity")) continue;

    const captured = calls.filter((c) => {
      if (!c.has_been_extracted) return false;
      if (c.outcome && NO_CONTENT.has(c.outcome)) return false;
      const t = Date.parse(c.scheduled_start ?? c.call_date ?? "");
      return !(Number.isFinite(t) && t > now); // exclude future
    });
    // Only deals DealRipe has actually captured a call on are in scope.
    if (captured.length === 0) continue;
    dealsChecked += 1;

    const push = (f: Omit<AuditFinding, "dealId" | "account">) =>
      findings.push({ dealId: deal.id, account: deal.account, ...f });

    // --- Check: framework present (else no gates can be extracted) ---
    if (!deal.framework_id) {
      push({
        severity: "error",
        type: "no_framework",
        message: `${deal.account} has captured calls but no qualification framework attached, so no gates are being extracted.`,
        fixed: false,
        action: "Attach the Magaya Rolldog framework to this deal.",
      });
    }

    // --- Check: rep assigned ---
    if (!deal.rep_email) {
      const mapped = deal.external_id ? repEmailForDeal(deal.external_id) : null;
      if (mapped && apply) {
        const upd = await db.from("deals").update({ rep_email: mapped }).eq("id", deal.id);
        if (!upd.error) {
          fixedCount += 1;
          push({
            severity: "info",
            type: "missing_rep",
            message: `${deal.account} had no rep assigned; set to ${mapped} from the pilot rep map.`,
            fixed: true,
          });
        } else {
          push({
            severity: "warn",
            type: "missing_rep",
            message: `${deal.account} has no rep assigned and the backfill failed: ${upd.error.message}`,
            fixed: false,
            action: "Set rep_email manually.",
          });
        }
      } else if (mapped) {
        push({
          severity: "info",
          type: "missing_rep",
          message: `${deal.account} has no rep assigned; would set ${mapped} from the pilot rep map.`,
          fixed: false,
          action: "Run the audit with apply to backfill.",
        });
      } else {
        push({
          severity: "warn",
          type: "missing_rep",
          message: `${deal.account} has no rep assigned and no pilot mapping to backfill from.`,
          fixed: false,
          action: "Assign the rep (Eduardo or Juan) on this deal.",
        });
      }
    }

    // --- Check: Rolldog link (surface only; never auto-write routing) ---
    const mappedOpp = deal.external_id ? rolldogOppIdForDeal(deal.external_id) : null;
    if (!deal.rolldog_opportunity_id && !mappedOpp) {
      push({
        severity: "info",
        type: "no_rolldog_link",
        message: `${deal.account} is not linked to a Rolldog opportunity, so write-back can't run for it.`,
        fixed: false,
        action: "Add the Rolldog opportunity id once the rep confirms it.",
      });
    }

    // --- Attendance / stakeholder consistency ---
    const history = await getDealAttendanceHistory(tenantId, deal.id, 1).catch(() => []);
    const latest = history[0] ?? null;

    const contactsRes = await db
      .from("contacts")
      .select("name")
      .eq("tenant_id", tenantId)
      .eq("deal_id", deal.id);
    const contactNames = ((contactsRes.data ?? []) as Array<{ name: unknown }>)
      .map((c) => (typeof c.name === "string" ? norm(c.name) : ""))
      .filter(Boolean);

    if (latest) {
      // No customer spoke on a call we captured a transcript for: likely a
      // parsing/attendance issue or a genuinely one-sided call. Flag for review.
      const anySpoke = latest.invitees.some((i) => i.spoke);
      if (!anySpoke) {
        push({
          severity: "warn",
          type: "no_customer_spoke",
          message: `${deal.account}'s last call shows no customer stakeholder speaking. Check the transcript and attendee matching.`,
          fixed: false,
          action: "Open the deal and verify who was on the call.",
        });
      }

      // A stakeholder joined and spoke but was never captured as a contact.
      const missing = latest.invitees.filter(
        (i) => !i.onInvite && i.name && !contactNames.includes(norm(i.name)),
      );
      if (missing.length > 0) {
        const who = missing.map((m) => m.name).join(", ");
        if (apply) {
          const fixedNow = await reextractContacts(tenantId, deal, captured).catch(() => false);
          if (fixedNow) fixedCount += 1;
          push({
            severity: fixedNow ? "info" : "warn",
            type: "missing_stakeholder",
            message: fixedNow
              ? `${deal.account}: ${who} spoke but was not a contact; re-extracted contacts from the latest call.`
              : `${deal.account}: ${who} spoke but is not a stored contact, and re-extraction did not add them.`,
            fixed: fixedNow,
            action: fixedNow ? undefined : "Add the contact manually or check the transcript.",
          });
        } else {
          push({
            severity: "warn",
            type: "missing_stakeholder",
            message: `${deal.account}: ${who} spoke on the last call but is not a stored contact.`,
            fixed: false,
            action: "Run the audit with apply to re-extract contacts.",
          });
        }
      }
    } else if (calls.some((c) => c.has_been_extracted)) {
      // Captured a call but no attendance data: the calendar invite (participants)
      // was never stored, so invited-vs-attended can't be computed.
      push({
        severity: "info",
        type: "no_attendance_data",
        message: `${deal.account} has a captured call but no attendee list, so meeting attendance can't be shown.`,
        fixed: false,
        action: "Confirm the calendar sync stored participants for this call.",
      });
    }
  }

  // Order: errors first, then warnings, then info.
  const rank: Record<AuditSeverity, number> = { error: 0, warn: 1, info: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity]);

  return {
    ranAt: new Date().toISOString(),
    applied: apply,
    dealsChecked,
    fixedCount,
    findings,
  };
}

/** Re-extract contacts from the deal's most recent captured transcript. */
async function reextractContacts(
  tenantId: string,
  deal: DealRow,
  captured: CallRow[],
): Promise<boolean> {
  const db = supabaseAdmin();
  const latestCall = captured[0];
  if (!latestCall) return false;
  const tr = await db
    .from("transcripts")
    .select("body")
    .eq("call_id", latestCall.id)
    .maybeSingle();
  const body = tr.data?.body ?? "";
  if (body.trim().length < 50) return false;
  const contacts = await extractContactsFromTranscript({ transcript: body, account: deal.account });
  if (contacts.length === 0) return false;
  const res = await upsertDealContacts({
    tenantId,
    dealId: deal.id,
    contacts,
    callDate: latestCall.scheduled_start ?? latestCall.call_date ?? null,
  });
  return res.inserted > 0;
}
