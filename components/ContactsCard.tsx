import { isMeaningfulContact } from "@/lib/contacts-extract";
import type { Contact } from "@/lib/seed-data";

type Props = {
  contacts: Contact[];
};

const RELATIONSHIP_LABEL: Record<Contact["relationship"], string> = {
  champion: "Champion",
  economic_buyer: "Economic Buyer",
  influencer: "Influencer",
  user: "User",
  unknown: "Unknown",
};

const RELATIONSHIP_STYLE: Record<Contact["relationship"], string> = {
  champion: "bg-accentSoft text-accent",
  economic_buyer: "bg-ink text-white",
  influencer: "bg-line text-ink",
  user: "bg-line text-muted",
  unknown: "bg-warnSoft text-warn",
};

export function ContactsCard({ contacts }: Props) {
  // Hide scheduling/logistics noise ("Unknown internal stakeholder") that the
  // extractor may have stored before the filter existed.
  const shown = contacts.filter((c) => isMeaningfulContact(c));
  return (
    <div className="bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
      <div className="px-5 py-4 border-b border-line">
        <h2 className="text-[15px] font-semibold text-ink">Contacts</h2>
        <p className="text-[12px] text-muted mt-0.5">
          {shown.length} people on the account
        </p>
      </div>
      <div className="divide-y divide-line">
        {shown.map((c) => (
          <div key={c.id} className="px-5 py-3.5 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[13px] font-semibold text-ink leading-snug truncate">
                {c.name}
              </div>
              <div className="text-[12px] text-muted mt-0.5">{c.role}</div>
              <div className="mt-1.5">
                {c.lastContactedAt ? (
                  <span className="text-[11px] text-muted">
                    Last contacted {formatDate(c.lastContactedAt)}
                  </span>
                ) : (
                  <span className="text-[11px] font-semibold text-danger">
                    Never contacted
                  </span>
                )}
              </div>
            </div>
            <span
              className={`shrink-0 inline-block text-[10px] uppercase tracking-wide font-semibold px-2 py-0.5 rounded-full ${RELATIONSHIP_STYLE[c.relationship]}`}
            >
              {RELATIONSHIP_LABEL[c.relationship]}
            </span>
          </div>
        ))}
      </div>
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
