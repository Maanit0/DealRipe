import { LocalTime } from "./LocalTime";
import type { SentMessage } from "@/lib/sent-messages";

/**
 * The exact briefings and recaps DealRipe emailed the rep for this deal,
 * newest first. Each row expands to render the real HTML body in a sandboxed
 * iframe, so what you see is byte-for-byte what was sent.
 */
export function SentCommsCard({ messages }: { messages: SentMessage[] }) {
  return (
    <div className="bg-white rounded-xl2 shadow-card border border-line px-5 py-4">
      <div className="text-[10px] uppercase tracking-wider font-semibold text-muted">
        Sent communications
      </div>

      {messages.length === 0 ? (
        <div className="text-[13px] text-muted mt-1.5">
          No briefings or recaps sent yet. They appear here the moment DealRipe emails the rep.
        </div>
      ) : (
        <div className="mt-2.5 space-y-2">
          {messages.map((m) => (
            <details key={m.id} className="group border border-line rounded-lg overflow-hidden">
              <summary className="cursor-pointer list-none px-3 py-2.5 flex items-center justify-between gap-3 hover:bg-bg/60 transition">
                <span className="flex items-center gap-2 min-w-0">
                  <span
                    className={`text-[9px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded ${
                      m.kind === "briefing"
                        ? "bg-accent/10 text-accent"
                        : "bg-ink/[0.06] text-ink"
                    }`}
                  >
                    {m.kind === "briefing" ? "Pre-call" : "Recap"}
                  </span>
                  <span className="text-[13px] text-ink truncate">{m.subject}</span>
                </span>
                <span className="text-[11px] text-muted whitespace-nowrap flex items-center gap-2">
                  <LocalTime iso={m.sentAt} />
                  <span className="text-muted/70 group-open:rotate-180 transition-transform">⌄</span>
                </span>
              </summary>
              <div className="border-t border-line">
                <div className="px-3 py-1.5 text-[11px] text-muted bg-bg/40">To: {m.toEmail}</div>
                <iframe
                  title={m.subject}
                  srcDoc={m.bodyHtml}
                  sandbox=""
                  className="w-full h-[440px] bg-white border-0 block"
                />
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
