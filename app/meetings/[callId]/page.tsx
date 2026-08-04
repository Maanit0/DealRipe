import Link from "next/link";
import { notFound } from "next/navigation";

import { AppShell } from "@/components/AppShell";
import { MeetingInspect } from "@/components/MeetingInspect";
import { getDealAttendanceHistory, type CallAttendance } from "@/lib/attendance";
import { getMeetingDetail } from "@/lib/meetings";
import { getSentMessages, type SentMessage } from "@/lib/sent-messages";
import { getDealForTenant } from "@/lib/supabase-queries";
import { resolveTenantId } from "@/lib/tenant-deal-lookup";
import { DEFAULT_TENANT_SLUG, withTenant } from "@/lib/tenant-nav";
import type { Contact } from "@/lib/seed-data";

export const dynamic = "force-dynamic";

export default async function MeetingPage({
  params,
  searchParams,
}: {
  params: { callId: string };
  searchParams: { tenant?: string };
}) {
  const tenant = searchParams.tenant ?? DEFAULT_TENANT_SLUG;
  let tenantId: string;
  try {
    tenantId = await resolveTenantId(tenant);
  } catch {
    notFound();
  }

  const meeting = await getMeetingDetail(tenantId, params.callId).catch(() => null);
  if (!meeting) notFound();

  const [deal, attendanceHist, sent] = await Promise.all([
    getDealForTenant(tenantId, meeting.dealId).catch(() => null),
    getDealAttendanceHistory(tenantId, meeting.dealId).catch(() => [] as CallAttendance[]),
    getSentMessages(meeting.dealId).catch(() => [] as SentMessage[]),
  ]);

  const attendance = attendanceHist.find((a) => a.callId === meeting.callId) ?? null;
  const contacts: Contact[] = deal?.contacts ?? [];
  // Future call: show the pre-call briefing for THIS call. Past call: show the
  // recap, preferring the one recorded against this exact call.
  const isUpcoming = !!meeting.date && Date.parse(meeting.date) > Date.now();
  const forThisCall = sent.filter((m) => m.callId === meeting.callId);
  const message = isUpcoming
    ? (forThisCall.find((m) => m.kind === "briefing") ?? sent.find((m) => m.kind === "briefing") ?? null)
    : (forThisCall.find((m) => m.kind === "recap") ?? sent.find((m) => m.kind === "recap") ?? null);

  return (
    <AppShell active="meetings" tenant={tenant}>
      <div className="max-w-[1100px] mx-auto px-6 py-7">
        <Link
          href={withTenant("/meetings", tenant)}
          className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink transition mb-5"
        >
          <span className="text-base leading-none">←</span> All meetings
        </Link>
        <MeetingInspect
          meeting={meeting}
          attendance={attendance}
          contacts={contacts}
          recapHtml={message?.bodyHtml ?? null}
          panelKind={isUpcoming ? "briefing" : "recap"}
        />
      </div>
    </AppShell>
  );
}
