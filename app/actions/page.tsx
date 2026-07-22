import { AppShell } from "@/components/AppShell";

export const dynamic = "force-dynamic";

export default function ActionsPage() {
  return (
    <AppShell active="actions">
      <div className="max-w-[1100px] mx-auto px-6 py-7">
        <h1 className="text-[24px] font-semibold tracking-tight text-ink">Actions</h1>
        <p className="text-[13px] text-muted mt-1">
          Everything DealRipe did and everything needing a look: recaps and briefings sent to reps,
          next-step tasks written to Rolldog, and drafts (follow-ups, no-shows).
        </p>
        <div className="mt-6 bg-white rounded-xl2 shadow-card border border-line px-5 py-5 text-[13px] text-muted">
          This view is being built next. It will pull together, per deal and per meeting, exactly
          what DealRipe sent the AE and wrote to the CRM after each call.
        </div>
      </div>
    </AppShell>
  );
}
