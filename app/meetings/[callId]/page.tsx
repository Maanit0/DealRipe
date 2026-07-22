import Link from "next/link";
import { notFound } from "next/navigation";

import { AppShell } from "@/components/AppShell";
import { MeetingInspect } from "@/components/MeetingInspect";
import { getDealAttendanceHistory, type CallAttendance } from "@/lib/attendance";
import { getMeetingDetail } from "@/lib/meetings";
import { getSentMessages, type SentMessage } from "@/lib/sent-messages";
import { getDealForTenant } from "@/lib/supabase-queries";
import { resolveTenantId } from "@/lib/tenant-deal-lookup";
import type { Contact } from "@/lib/seed-data";

export const dynamic = "force-dynamic";

export default async function MeetingPage({ params }: { params: { callId: string } }) {
  let tenantId: string;
  try {
    tenantId = await resolveTenantId("magaya");
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
  const recap = sent.find((m) => m.kind === "recap") ?? null;

  return (
    <AppShell active="meetings">
      <div className="max-w-[1100px] mx-auto px-6 py-7">
        <Link
          href="/meetings"
          className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink transition mb-5"
        >
          <span className="text-base leading-none">←</span> All meetings
        </Link>
        <MeetingInspect
          meeting={meeting}
          attendance={attendance}
          contacts={contacts}
          recapHtml={recap?.bodyHtml ?? null}
        />
      </div>
    </AppShell>
  );
}
