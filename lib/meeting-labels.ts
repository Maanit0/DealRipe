/**
 * Pure display helpers for meeting types and subtypes. No I/O, no SDK, no
 * Node built-ins.
 *
 * WHY THIS IS ITS OWN FILE
 *
 * components/MeetingInspect.tsx is a client component and imported exactly one
 * function from lib/meeting-classify.ts: callSubtypeLabel, which maps a string
 * to a nicer string. That import pulled the whole of meeting-classify into the
 * browser bundle, and with it lib/model-run.ts and the Anthropic SDK.
 *
 * It was already wrong and it was invisible, because a bundler will happily
 * tree-shake most of it and ship the rest. It only became a build failure when
 * model-run started importing node:async_hooks, which webpack cannot resolve
 * for a client target at all. The failure was the useful part: it named a
 * dependency edge that should never have existed.
 *
 * The rule this encodes: a module that talks to a model, a CRM or a mailbox is
 * not importable from a client component, so anything a client component
 * legitimately needs lives somewhere with no such dependencies.
 */

export type CallSubtype = "discovery" | "demo" | "proposal" | "follow_up" | "customer" | "internal";

const SUBTYPE_LABEL: Record<CallSubtype, string> = {
  discovery: "Discovery",
  demo: "Demo",
  proposal: "Proposal",
  follow_up: "Follow-up",
  customer: "Customer",
  internal: "Internal",
};

export function callSubtypeLabel(s: string | null | undefined): string | null {
  if (!s) return null;
  return SUBTYPE_LABEL[s as CallSubtype] ?? null;
}
