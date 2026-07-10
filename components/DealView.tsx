"use client";

import Link from "next/link";
import { ContactsCard } from "./ContactsCard";
import { DealHeaderCard } from "./DealHeaderCard";
import { useDemoState } from "./DemoStateProvider";
import { GongCallsCard } from "./GongCallsCard";
import { OpportunityControlSheet } from "./OpportunityControlSheet";
import { SimilarDealsCard } from "./SimilarDealsCard";
import type { Stage } from "@/lib/scotsman";
import type { CallRecord, Deal } from "@/lib/seed-data";

type Props = {
  deal: Deal;
  stage: Stage;
};

export function DealView({ deal, stage }: Props) {
  const { getDealState } = useDemoState();
  const session = getDealState(deal.id);
  const extraction = session?.extraction ?? deal.extraction;
  const currentCallId = session?.currentCallId;
  const currentCall = currentCallId
    ? deal.calls.find((c) => c.id === currentCallId)
    : undefined;
  const currentCallLabel = currentCall ? formatDate(currentCall.date) : undefined;

  const callsForDisplay: CallRecord[] = currentCallId
    ? deal.calls.map((c) =>
        c.id === currentCallId ? { ...c, hasBeenExtracted: true } : c,
      )
    : deal.calls;

  return (
    <div className="space-y-5">
      <DealHeaderCard
        deal={deal}
        stage={stage}
        extractionOverride={extraction}
      />
      <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-5 items-start">
        <OpportunityControlSheet
          extraction={extraction}
          stage={stage}
          currentCallId={currentCallId}
          currentCallLabel={currentCallLabel}
        />
        <div className="space-y-5">
          <ContactsCard contacts={deal.contacts} />
          <GongCallsCard dealId={deal.id} calls={callsForDisplay} />
          <Link
            href={`/deals/${deal.id}/prepare`}
            className="block w-full text-center px-4 py-3 rounded-xl2 bg-ink text-white text-[13px] font-semibold hover:bg-ink/90 transition"
          >
            Prepare next call
          </Link>
        </div>
      </div>
      <SimilarDealsCard dealId={deal.id} account={deal.account} />
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
