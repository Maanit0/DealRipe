/**
 * crm-writer: push stored field_extractions to Rolldog.
 *
 * Reads:
 *   - framework_fields.write_target (jsonb, may be null) to know
 *     {method, attr, parser} for each field
 *   - field_extractions for the deal (status / answer / evidence)
 *
 * Writes via lib/rolldog.ts methods, which enforce scope + audit via
 * lib/crm-scope.ts. ScopeViolationError is NEVER caught here — it
 * propagates loudly so the operator sees the misconfiguration.
 *
 * Pilot rules (intentional simplifications):
 *   1. ONE call per Rolldog sub-resource per deal. Budget, timeline,
 *      competition, participant: free-text only. Multiple Yes fields
 *      that target the same sub-resource are COMBINED into one notes
 *      payload before the single write — so we never overwrite the
 *      same notes column three times in a row.
 *   2. Situation has structured params (why-looking, why-looking-now,
 *      existing-systems, business-status), one per field. They land in
 *      a single writeSituation call.
 *   3. Timeline carries one structured signal (is-close-date-validated,
 *      derived from the close_date_validated field's Yes status) and
 *      a combined notes string for any timeline_notes field text.
 *
 * Deferred to v2 (TODOs below):
 *   - Structured budget ranges (low-range / high-range integers parsed
 *     from the answer). Today the budget answer + evidence go to
 *     budget.notes as free text.
 *   - Structured competitor rows (POST /opportunity-competitors with
 *     per-competitor name/is-incumbent/strengths). Today everything
 *     competition goes to competition.notes as free text.
 *   - Structured participant-contact rows (POST
 *     /opportunity-participant-contacts). Today key_decision_maker
 *     details go to participant.notes as free text.
 *   - Parser-hint application (write_target.parser: "currency-range",
 *     "enum-fit", "bool"). Today only "bool" is consulted, for the
 *     close_date_validated -> is-close-date-validated derivation.
 *
 * Briefing-only fields (write_target null) are intentionally NOT synced
 * to Rolldog here. They feed the pre-call briefing and forecast view:
 *   - next_step_confirmed
 *   - champion_internal_action
 *   - decision_process_mapped
 */

import { ScopeViolationError } from "./crm-scope";
import {
  getFrameworkForDeal,
  loadFramework,
  type Framework,
} from "./framework";
import {
  createActivity,
  writeBudget,
  writeCompetitionNotes,
  writeParticipantNotes,
  writeSituation,
  writeTimeline,
  type SituationWrite,
  type TimelineWrite,
} from "./rolldog";
import { supabaseAdmin } from "./supabase";
import { resolveTenantId } from "./tenant-deal-lookup";

// ====================================================================
// Public API
// ====================================================================

export type SyncResult = {
  /** rolldog method name, e.g. "writeBudget" */
  method: string;
  /** "ok": method called and 2xx. "skipped": no Yes fields contributed.
   *  "error": method called and threw (non-ScopeViolation).
   *  "preview": dry-run; payload composed but NOT sent. */
  status: "ok" | "skipped" | "error" | "preview";
  /** field_keys whose extractions contributed to this call */
  fieldsWritten: string[];
  /** For a dry-run preview: the payload that would have been written. */
  payload?: string;
  /** present only when status === "error". Never contains credential values. */
  error?: string;
};

export type SyncDealToRolldogOpts = {
  tenantSlug: string;
  /** Supabase uuid for the deal (deals.id) */
  dealId: string;
  /** External Rolldog opportunity id (deals.external_id, or the id you allowlisted) */
  rolldogOpportunityId: string;
  /** When true, compose payloads and return status="preview" WITHOUT writing
   *  to Rolldog. Use to validate the mapping before enabling live writes. */
  dryRun?: boolean;
  /** The recap's recommended next action to write to the opportunity's next
   *  step. Composed always; the LIVE write is additionally gated behind the
   *  ROLLDOG_WRITE_NEXT_STEP env flag (default off) until the Rolldog target is
   *  confirmed, so it previews without touching the CRM. */
  nextAction?: string;
};

/**
 * Push every Yes field_extraction for the deal to Rolldog, grouped by
 * target sub-resource so each sub-resource gets one PATCH.
 *
 * Returns one SyncResult per sub-resource method. Methods that received
 * no Yes-field input return status="skipped". Methods that errored
 * return status="error" with the message; other methods continue
 * (per-method error isolation).
 *
 * ScopeViolationError thrown by lib/rolldog.ts is RE-THROWN, never
 * captured into SyncResult — the operator must see a scope misconfiguration
 * immediately.
 */
export async function syncDealToRolldog(
  opts: SyncDealToRolldogOpts,
): Promise<SyncResult[]> {
  const tenantId = await resolveTenantId(opts.tenantSlug);

  // Framework: prefer the deal's pointer, fall back to tenant default.
  const framework: Framework | null =
    (await getFrameworkForDeal(opts.dealId)) ??
    (await loadFramework(tenantId));
  if (!framework) {
    throw new Error(
      `no qualification framework registered for tenant '${opts.tenantSlug}' (dealId=${opts.dealId})`,
    );
  }

  // Load this deal's field_extractions in one shot.
  const db = supabaseAdmin();
  const fxRes = await db
    .from("field_extractions")
    .select("framework_field_key, status, answer, evidence, confidence")
    .eq("deal_id", opts.dealId);
  if (fxRes.error) {
    throw new Error(
      `field_extractions read failed for deal ${opts.dealId}: ${fxRes.error.message}`,
    );
  }
  const byKey = new Map(
    (fxRes.data ?? []).map((r) => [r.framework_field_key, r] as const),
  );

  // Latest captured call date, for the write's [DealRipe · call date] stamp.
  const callRow = await db
    .from("calls")
    .select("scheduled_start, call_date")
    .eq("deal_id", opts.dealId)
    .order("scheduled_start", { ascending: false })
    .limit(1)
    .maybeSingle();
  const stamp = buildDealRipeStamp(
    callRow.data?.scheduled_start ?? callRow.data?.call_date ?? null,
  );

  // ---- Pass 1: accumulate per-method payloads. ----

  type NotesPart = { fieldKey: string; line: string };
  const budgetParts: NotesPart[] = [];
  const timelineParts: NotesPart[] = [];
  const competitionParts: NotesPart[] = [];
  const participantParts: NotesPart[] = [];
  const situationPayload: SituationWrite = {};
  const situationFields: string[] = [];
  let timelineCloseDateValidated: boolean | undefined = undefined;
  const timelineFields = new Set<string>(); // tracks which fields fed timeline

  for (const f of framework.fields) {
    if (!f.writeTarget) continue; // briefing-only: skip
    if (f.writeTarget.system !== "rolldog") continue;

    const ex = byKey.get(f.fieldKey);
    // Skip No/Unknown/missing. Also defensively guard answer/evidence
    // since the field_extractions_yes_payload_chk constraint already
    // enforces both are non-null on Yes rows, but a null here would
    // surface as "undefined" in the template string otherwise.
    if (!ex || ex.status !== "Yes" || !ex.answer || !ex.evidence) continue;

    const composed = composeNote(ex.answer);
    const method = String(f.writeTarget.method ?? "");
    const attr = String(f.writeTarget.attr ?? "");

    switch (method) {
      case "writeBudget": {
        // All budget fields collapse to one combined notes payload.
        budgetParts.push({
          fieldKey: f.fieldKey,
          line: composed,
        });
        break;
      }
      case "writeTimeline": {
        // Combine into one notes payload. close_date_validated also
        // flips the structured boolean (Yes status = customer confirmed).
        timelineParts.push({
          fieldKey: f.fieldKey,
          line: composed,
        });
        timelineFields.add(f.fieldKey);
        // Deliberately NOT flipping is-close-date-validated: Rolldog returns 422
        // when that boolean is set true without a close-date-validator. The
        // validation is captured in the timeline note instead. Revisit once the
        // validator field's expected shape is confirmed.
        break;
      }
      case "writeSituation": {
        // Structured params, one per field. attr is the kebab-case
        // Rolldog attribute; map back to the SituationWrite camelCase
        // param. Unknown attrs are ignored so a future write_target
        // mistake fails loudly via "no fields written" rather than
        // silently sending to the wrong attribute.
        const param = situationParamFromAttr(attr);
        if (param) {
          assignSituationField(situationPayload, param, capNote(`${stamp} ${composed}`));
          situationFields.push(f.fieldKey);
        }
        break;
      }
      case "writeCompetitionNotes": {
        competitionParts.push({
          fieldKey: f.fieldKey,
          line: composed,
        });
        break;
      }
      case "writeParticipantNotes": {
        participantParts.push({
          fieldKey: f.fieldKey,
          line: composed,
        });
        break;
      }
      // Unknown method: silently skip. A future framework_field with
      // an unrecognized write_target.method won't crash sync; the
      // operator just won't see it surface in any SyncResult, which is
      // the signal that a new dispatch case is needed here.
    }
  }

  // ---- Pass 2: dispatch one call per non-empty payload. ----

  const dryRun = opts.dryRun ?? false;
  const results: SyncResult[] = [];

  // writeBudget
  if (budgetParts.length > 0) {
    const notes = capNote(`${stamp} ${budgetParts.map((p) => p.line).join(" · ")}`);
    const fields = budgetParts.map((p) => p.fieldKey);
    if (dryRun) {
      results.push({ method: "writeBudget", status: "preview", fieldsWritten: fields, payload: `notes:\n${notes}` });
    } else {
    try {
      await writeBudget(opts.rolldogOpportunityId, { notes });
      results.push({ method: "writeBudget", status: "ok", fieldsWritten: fields });
    } catch (err) {
      if (err instanceof ScopeViolationError) throw err;
      results.push({
        method: "writeBudget",
        status: "error",
        fieldsWritten: fields,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    }
  } else {
    results.push({ method: "writeBudget", status: "skipped", fieldsWritten: [] });
  }

  // writeTimeline (notes + optional isCloseDateValidated)
  if (timelineParts.length > 0 || timelineCloseDateValidated !== undefined) {
    const payload: TimelineWrite = {};
    if (timelineParts.length > 0) {
      payload.notes = capNote(`${stamp} ${timelineParts.map((p) => p.line).join(" · ")}`);
    }
    if (timelineCloseDateValidated !== undefined) {
      payload.isCloseDateValidated = timelineCloseDateValidated;
    }
    const fields = Array.from(timelineFields);
    if (dryRun) {
      results.push({ method: "writeTimeline", status: "preview", fieldsWritten: fields, payload: JSON.stringify(payload, null, 2) });
    } else {
    try {
      await writeTimeline(opts.rolldogOpportunityId, payload);
      results.push({ method: "writeTimeline", status: "ok", fieldsWritten: fields });
    } catch (err) {
      if (err instanceof ScopeViolationError) throw err;
      results.push({
        method: "writeTimeline",
        status: "error",
        fieldsWritten: fields,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    }
  } else {
    results.push({ method: "writeTimeline", status: "skipped", fieldsWritten: [] });
  }

  // writeSituation
  if (situationFields.length > 0) {
    if (dryRun) {
      results.push({ method: "writeSituation", status: "preview", fieldsWritten: situationFields, payload: JSON.stringify(situationPayload, null, 2) });
    } else {
    try {
      await writeSituation(opts.rolldogOpportunityId, situationPayload);
      results.push({
        method: "writeSituation",
        status: "ok",
        fieldsWritten: situationFields,
      });
    } catch (err) {
      if (err instanceof ScopeViolationError) throw err;
      results.push({
        method: "writeSituation",
        status: "error",
        fieldsWritten: situationFields,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    }
  } else {
    results.push({ method: "writeSituation", status: "skipped", fieldsWritten: [] });
  }

  // writeCompetitionNotes
  if (competitionParts.length > 0) {
    const notes = capNote(`${stamp} ${competitionParts.map((p) => p.line).join(" · ")}`);
    const fields = competitionParts.map((p) => p.fieldKey);
    if (dryRun) {
      results.push({ method: "writeCompetitionNotes", status: "preview", fieldsWritten: fields, payload: `notes:\n${notes}` });
    } else {
    try {
      await writeCompetitionNotes(opts.rolldogOpportunityId, notes);
      results.push({
        method: "writeCompetitionNotes",
        status: "ok",
        fieldsWritten: fields,
      });
    } catch (err) {
      if (err instanceof ScopeViolationError) throw err;
      results.push({
        method: "writeCompetitionNotes",
        status: "error",
        fieldsWritten: fields,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    }
  } else {
    results.push({
      method: "writeCompetitionNotes",
      status: "skipped",
      fieldsWritten: [],
    });
  }

  // writeParticipantNotes
  if (participantParts.length > 0) {
    const notes = capNote(`${stamp} ${participantParts.map((p) => p.line).join(" · ")}`);
    const fields = participantParts.map((p) => p.fieldKey);
    if (dryRun) {
      results.push({ method: "writeParticipantNotes", status: "preview", fieldsWritten: fields, payload: `notes:\n${notes}` });
    } else {
    try {
      await writeParticipantNotes(opts.rolldogOpportunityId, { notes });
      results.push({
        method: "writeParticipantNotes",
        status: "ok",
        fieldsWritten: fields,
      });
    } catch (err) {
      if (err instanceof ScopeViolationError) throw err;
      results.push({
        method: "writeParticipantNotes",
        status: "error",
        fieldsWritten: fields,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    }
  } else {
    results.push({
      method: "writeParticipantNotes",
      status: "skipped",
      fieldsWritten: [],
    });
  }

  // writeNextStep: the recap's recommended next action -> a to-do in the
  // opportunity's interactions tab (an `activities` record, is-complete false).
  // LIVE by default now that the IFF demo confirmed it renders correctly in the
  // interactions tab. Kill switch: set ROLLDOG_WRITE_NEXT_STEP=0 to fall back to
  // preview-only without a code change. Still scope-gated (activities field +
  // PILOT_OPPORTUNITY_IDS), so it only ever writes to allowlisted pilot opps.
  const action = opts.nextAction?.trim();
  if (action) {
    const title = capNote(`Next step: ${action}`);
    const notes = `${stamp} DealRipe next-step recommendation from the call.`;
    const liveAllowed = process.env.ROLLDOG_WRITE_NEXT_STEP !== "0";
    if (dryRun || !liveAllowed) {
      results.push({
        method: "writeNextStep",
        status: "preview",
        fieldsWritten: ["suggested_next_step"],
        payload: `activity (-> interactions tab):\n  [DealRipe] ${title}\n  notes: ${notes}${dryRun ? "" : "\n(live create disabled: ROLLDOG_WRITE_NEXT_STEP=0)"}`,
      });
    } else {
      try {
        await createActivity(opts.rolldogOpportunityId, { title, notes });
        results.push({ method: "writeNextStep", status: "ok", fieldsWritten: ["suggested_next_step"] });
      } catch (err) {
        if (err instanceof ScopeViolationError) throw err;
        results.push({
          method: "writeNextStep",
          status: "error",
          fieldsWritten: ["suggested_next_step"],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } else {
    results.push({ method: "writeNextStep", status: "skipped", fieldsWritten: [] });
  }

  return results;
}

// ====================================================================
// Internals
// ====================================================================

// CRM notes stay concise: just the answer. The dated [DealRipe] stamp is added
// at assembly time, and the verbatim evidence quote lives in DealRipe (clickable
// from the deal page), not in the CRM, which keeps notes under Rolldog's field
// length cap and reads cleanly for a human.
function composeNote(answer: string): string {
  return answer.trim();
}

function fmtStampDate(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  } catch {
    return "";
  }
}

// Attribution stamp so a Rolldog reader sees the source and date at a glance:
// "[DealRipe · Jul 16 call]". One date, the call date, since write-back fires
// right after the call (same day in normal operation). Falls back to the write
// date only if the call date is unknown.
function buildDealRipeStamp(callDate: string | null): string {
  const d = fmtStampDate(callDate) || fmtStampDate(new Date().toISOString());
  return d ? `[DealRipe · ${d} call]` : "[DealRipe]";
}

const MAX_NOTE = 280; // Rolldog note fields cap around 300; leave headroom.
function capNote(s: string): string {
  const t = s.trim();
  return t.length <= MAX_NOTE ? t : `${t.slice(0, MAX_NOTE - 1).trimEnd()}…`;
}

type SituationParam =
  | "whyLooking"
  | "whyLookingNow"
  | "existingSystems"
  | "businessStatus"
  | "notes";

function situationParamFromAttr(attr: string): SituationParam | null {
  switch (attr) {
    case "why-looking":
      return "whyLooking";
    case "why-looking-now":
      return "whyLookingNow";
    case "existing-systems":
      return "existingSystems";
    case "business-status":
      return "businessStatus";
    case "notes":
      return "notes";
    default:
      return null;
  }
}

function assignSituationField(
  payload: SituationWrite,
  param: SituationParam,
  value: string,
): void {
  switch (param) {
    case "whyLooking":
      payload.whyLooking = value;
      return;
    case "whyLookingNow":
      payload.whyLookingNow = value;
      return;
    case "existingSystems":
      payload.existingSystems = value;
      return;
    case "businessStatus":
      payload.businessStatus = value;
      return;
    case "notes":
      payload.notes = value;
      return;
  }
}
