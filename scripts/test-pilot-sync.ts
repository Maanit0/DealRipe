/**
 * Local end-to-end exerciser for the pilot sync pipeline.
 *
 * Usage:
 *   npm run test:pilot-sync -- --domains example.com:TEST_DEAL_1
 *   npm run test:pilot-sync -- --domains example.com:TEST_DEAL_1 --ensure-deal
 *   npm run test:pilot-sync -- --domains example.com:TEST_DEAL_1 --transcripts
 *
 * Flags:
 *   --domains "<domain>:<dealExternalId>"   (repeatable)
 *       Injects the allowlist via __setPilotDomainsForTesting. Production
 *       PILOT_CUSTOMER_DOMAINS is empty; this is the only way to exercise
 *       calendar-sync before kickoff.
 *
 *   --ensure-deal
 *       Upserts a deals row in tenant 'magaya' for every (dealExternalId)
 *       in --domains so calendar-sync can resolve them.
 *
 *   --transcripts
 *       Runs runTranscriptSync() instead of runCalendarSync(). Useful for
 *       polling bots from previous calendar-sync runs.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import {
  runCalendarSync,
  type CalendarSyncDecision,
} from "../lib/calendar-sync";
import {
  __setPilotDomainsForTesting,
  type PilotDomainEntry,
} from "../lib/pilot-config";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";
import {
  runTranscriptSync,
  type TranscriptSyncDecision,
} from "../lib/transcript-sync";
import { extractAndStore } from "../lib/transcript-ingest";

const PILOT_TENANT_SLUG = "magaya";

type Mode = "calendar" | "transcripts" | "retry-ingest";

type Args = {
  domains: PilotDomainEntry[];
  ensureDeal: boolean;
  mode: Mode;
};

function parseArgs(argv: string[]): Args {
  const domains: PilotDomainEntry[] = [];
  let ensureDeal = false;
  let mode: Mode = "calendar";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--domains") {
      const v = argv[i + 1];
      if (!v || !v.includes(":")) {
        console.error(
          `--domains requires "<domain>:<dealExternalId>", got: ${v ?? "(missing)"}`,
        );
        process.exit(1);
      }
      const idx = v.indexOf(":");
      const domain = v.slice(0, idx).trim();
      const dealExternalId = v.slice(idx + 1).trim();
      if (!domain || !dealExternalId) {
        console.error(`--domains "${v}" parsed to empty parts`);
        process.exit(1);
      }
      domains.push({ domain, dealExternalId });
      i++;
    } else if (a === "--ensure-deal") {
      ensureDeal = true;
    } else if (a === "--transcripts") {
      mode = "transcripts";
    } else if (a === "--retry-ingest") {
      mode = "retry-ingest";
    } else {
      console.error(`unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return { domains, ensureDeal, mode };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // --retry-ingest is a tenant-scoped operation that does not consult
  // the domain allowlist; the input set comes from calls.ingest_error.
  // For calendar and transcripts modes, at least one --domains entry
  // is required.
  if (args.mode !== "retry-ingest" && args.domains.length === 0) {
    console.error(
      "no --domains entries provided; at least one is required.\n" +
        "  example: npm run test:pilot-sync -- --domains example.com:TEST_DEAL_1",
    );
    process.exit(1);
  }

  if (args.domains.length > 0) {
    __setPilotDomainsForTesting(args.domains);
  }

  console.log("");
  console.log("=".repeat(80));
  console.log("Pilot sync test");
  console.log("=".repeat(80));
  console.log(`Mode:             ${args.mode}`);
  if (args.domains.length > 0) {
    console.log(`Pilot domains:`);
    for (const d of args.domains) {
      console.log(`  ${d.domain}  ->  ${d.dealExternalId}`);
    }
  }
  console.log("");

  let tenantId: string;
  try {
    tenantId = await resolveTenantId(PILOT_TENANT_SLUG);
  } catch (err) {
    console.error(
      `tenant '${PILOT_TENANT_SLUG}' not found. Run \`npm run seed:magaya\` first.`,
    );
    process.exit(1);
  }

  if (args.ensureDeal) {
    await ensureTestDeals(tenantId, args.domains);
  }

  if (args.mode === "transcripts") {
    await runTranscripts();
  } else if (args.mode === "retry-ingest") {
    await runRetryIngest(tenantId);
  } else {
    await runCalendar();
  }
}

async function ensureTestDeals(
  tenantId: string,
  domains: PilotDomainEntry[],
): Promise<void> {
  const db = supabaseAdmin();
  console.log("--ensure-deal: upserting placeholder deals in tenant magaya");
  for (const d of domains) {
    const up = await db
      .from("deals")
      .upsert(
        {
          tenant_id: tenantId,
          external_id: d.dealExternalId,
          account: "Pilot Test Account",
          stage_key: "test",
        },
        { onConflict: "tenant_id,external_id" },
      )
      .select("id, external_id")
      .single();
    if (up.error) {
      console.error(
        `  FAILED ${d.dealExternalId}: ${up.error.message}`,
      );
      continue;
    }
    console.log(`  ok    ${up.data.external_id} (uuid=${up.data.id})`);
  }
  console.log("");
}

async function runCalendar(): Promise<void> {
  console.log("Running runCalendarSync()...");
  console.log("");

  const counts = await runCalendarSync({
    onDecision: (d) => printCalendarDecision(d),
  });

  console.log("");
  console.log("=".repeat(80));
  console.log("Calendar sync counts:");
  console.log("=".repeat(80));
  for (const [k, v] of Object.entries(counts)) {
    console.log(`  ${k.padEnd(16)} ${v}`);
  }
  console.log("");
}

function printCalendarDecision(d: CalendarSyncDecision): void {
  const subj = d.subject ? `"${d.subject}"` : "(no subject)";
  const head = `[${d.kind}] ${d.eventId} ${subj}`;
  switch (d.kind) {
    case "no-join-url":
    case "no-attendees":
    case "no-change":
      console.log(head);
      return;
    case "no-pilot-match":
      console.log(`${head}  attendees: ${d.attendeeEmails.join(", ")}`);
      return;
    case "no-deal":
      console.log(`${head}  deal '${d.dealExternalId}' not in tenant magaya`);
      return;
    case "created":
      console.log(`${head}  botId=${d.recallBotId}`);
      return;
    case "rescheduled":
      console.log(
        `${head}  oldBot=${d.oldBotId ?? "(none)"} -> newBot=${d.newBotId}`,
      );
      return;
    case "cancelled":
      console.log(`${head}  oldBot=${d.oldBotId}`);
      return;
    case "error":
      console.log(`${head}  ERROR phase=${d.phase} message=${d.message}`);
      return;
  }
}

async function runTranscripts(): Promise<void> {
  console.log("Running runTranscriptSync()...");
  console.log("");

  const counts = await runTranscriptSync({
    onDecision: (d) => printTranscriptDecision(d),
  });

  console.log("");
  console.log("=".repeat(80));
  console.log("Transcript sync counts:");
  console.log("=".repeat(80));
  for (const [k, v] of Object.entries(counts)) {
    console.log(`  ${k.padEnd(16)} ${v}`);
  }
  console.log("");
}

function printTranscriptDecision(d: TranscriptSyncDecision): void {
  const head = `[${d.kind}] callId=${d.callId} botId=${d.recallBotId}`;
  switch (d.kind) {
    case "in-progress":
      console.log(`${head}  status=${d.rawStatus}`);
      return;
    case "fatal":
      console.log(`${head}  rawStatus=${d.rawStatus}`);
      return;
    case "extracted":
    case "media-deleted":
      console.log(head);
      return;
    case "ingest-error":
      console.log(`${head}  phase=${d.phase} message=${d.message}`);
      return;
  }
}

/**
 * --retry-ingest: re-extract from the stored transcript body for any
 * call whose ingest_error is set. Clears ingest_error only when the
 * re-extraction AND (best-effort) media delete both succeed.
 */
/**
 * --retry-ingest: re-run extraction ALONE for any call with a persisted
 * transcript body and a non-null ingest_error.
 *
 * Production rehearsal change: this no longer touches deleteSourceRecording.
 * The new transcript-sync ordering deletes Recall media as soon as the
 * body is persisted, regardless of extraction outcome — so by the time a
 * row reaches retry-ingest, deletion is already settled. Retrying delete
 * here would just re-trigger a Recall 4xx for media that no longer
 * exists and re-set ingest_error.
 *
 * On success, ingest_error is cleared. On failure, ingest_error is
 * updated with the new reason.
 */
async function runRetryIngest(tenantId: string): Promise<void> {
  console.log("Running --retry-ingest for tenant magaya...");
  console.log("");

  const db = supabaseAdmin();

  const rows = await db
    .from("calls")
    .select("id, external_id, deal_id, source")
    .eq("tenant_id", tenantId)
    .not("ingest_error", "is", null);
  if (rows.error) {
    console.error(`failed to list calls with ingest_error: ${rows.error.message}`);
    process.exit(1);
  }

  const counts = {
    candidates: 0,
    missingBody: 0,
    extracted: 0,
    cleared: 0,
    extractFailures: 0,
  };

  for (const row of rows.data ?? []) {
    counts.candidates += 1;
    const callId = row.id;
    const externalCallId = row.external_id ?? "";
    if (!externalCallId) {
      console.log(`[skip] callId=${callId} no external_id`);
      continue;
    }

    // Look up the deal external_id.
    const dealRow = await db
      .from("deals")
      .select("external_id")
      .eq("id", row.deal_id)
      .maybeSingle();
    if (dealRow.error || !dealRow.data?.external_id) {
      console.log(
        `[skip] callId=${callId} cannot resolve deal external_id` +
          (dealRow.error ? ` (${dealRow.error.message})` : ""),
      );
      continue;
    }
    const dealExternalId = dealRow.data.external_id;

    // Look up the stored transcript body.
    const transcriptRow = await db
      .from("transcripts")
      .select("body")
      .eq("call_id", callId)
      .maybeSingle();
    if (transcriptRow.error || !transcriptRow.data?.body) {
      counts.missingBody += 1;
      console.log(
        `[missing-body] callId=${callId} external=${externalCallId}` +
          (transcriptRow.error ? ` (${transcriptRow.error.message})` : ""),
      );
      continue;
    }
    const body = transcriptRow.data.body;

    // Re-run extraction alone (no delete step). The body is durable; if
    // extraction succeeds we clear ingest_error and the row is healthy.
    try {
      await extractAndStore({
        transcript: body,
        dealExternalId,
        callExternalId: externalCallId,
      });
      counts.extracted += 1;
      console.log(
        `[extracted] callId=${callId} dealExternalId=${dealExternalId}`,
      );
    } catch (err) {
      counts.extractFailures += 1;
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[extract-failed] callId=${callId} message=${message}`);
      await db
        .from("calls")
        .update({ ingest_error: `retry extract failed: ${message}` })
        .eq("id", callId);
      continue;
    }

    const clear = await db
      .from("calls")
      .update({ ingest_error: null })
      .eq("id", callId);
    if (clear.error) {
      console.log(
        `[clear-failed] callId=${callId} message=${clear.error.message}`,
      );
    } else {
      counts.cleared += 1;
      console.log(`[cleared] callId=${callId}`);
    }
  }

  console.log("");
  console.log("=".repeat(80));
  console.log("Retry-ingest counts:");
  console.log("=".repeat(80));
  for (const [k, v] of Object.entries(counts)) {
    console.log(`  ${k.padEnd(18)} ${v}`);
  }
  console.log("");
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
