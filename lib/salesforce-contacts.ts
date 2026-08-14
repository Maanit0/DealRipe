/**
 * Write the people from a call back to Salesforce Contacts.
 *
 * Of 80 contacts across the accounts DealRipe is linked to, 62 carry no Title.
 * Every call names people and says what they do, and nobody is typing that in
 * afterwards. This closes that gap and makes sure a person who appeared on a
 * call has a record at all.
 *
 * Two sources, each used for what it is good at:
 *
 *   calls.participants   the calendar invite. Authoritative for identity,
 *                        because it carries real email addresses.
 *   extracted contacts   the transcript. Authoritative for role, because the
 *                        invite never says what anyone does.
 *
 * Deliberately NOT written:
 *
 *   Role on OpportunityContactRole. All nine records across these accounts have
 *   a blank Role. Populating it would invent a convention rather than continue
 *   one, and a field only DealRipe fills is a field a rep learns to distrust.
 *
 *   Any Title that already has a value. A rep's own entry is never overwritten,
 *   only blanks are filled. This is the difference between a system that helps
 *   and one that has to be watched.
 *
 * Account writes are refused by Record_Triggered_ACCOUNT_Before_Save. Contact
 * writes are not: verified 2026-08-13 by scripts/salesforce-write-probe.ts with
 * a real value and a restore, after a no-op probe wrongly reported the Account
 * flow as clear.
 */

import { getSalesforceClient } from "./salesforce";
import { assertScopedAccountWrite, runWithAuthorizedAccounts } from "./salesforce-scope";
import { recordWrite } from "./crm-scope";

/**
 * The minimum this needs from a known person: a name to match on and a role to
 * write. Deliberately not ExtractedContact, so the caller can pass rows from
 * the contacts table the pipeline already populated instead of paying for a
 * second extraction of the same transcript.
 */
export type KnownPerson = { name: string; role: string | null };

const API = "v61.0";

/** Anyone at the vendor is not a contact on the vendor's own deal. */
const INTERNAL_DOMAIN = "magaya.com";

/**
 * Invite entries that are not people: rooms, resources, and the shared
 * mailboxes meeting invites collect. Writing one of these as a Contact puts a
 * fake person in a customer's CRM, which is worse than leaving a gap.
 */
const NOT_A_PERSON = /(^|[.@_-])(room|rooms|resource|conf|conference|zoom|teams|meet|calendar|noreply|no-reply|donotreply|info|sales|support|billing|admin|accounts?|hello|contact)([.@_-]|$)/i;

export type ContactSyncResult = {
  created: number;
  titlesFilled: number;
  /**
   * Matched a Salesforce contact who already has a Title. Nothing to do, and
   * the right outcome.
   */
  titleAlreadySet: number;
  /**
   * Matched a Salesforce contact with a blank Title, and the transcript gave us
   * no job for them. This is the gap the feature exists to close, so counting it
   * separately from titleAlreadySet is the difference between "working" and
   * "doing nothing". The first version reported both as "unchanged" and looked
   * like a success.
   */
  noTitleAvailable: number;
  skipped: number;
  /** Why each skip happened, so an empty result is explainable. */
  notes: string[];
};

type SfContact = {
  Id: string;
  FirstName: string | null;
  LastName: string | null;
  Name: string | null;
  Email: string | null;
  Title: string | null;
};

type Participant = { name?: string | null; email?: string | null };

/**
 * A real human name from a calendar invite, or null.
 *
 * Outlook fills the display name with the address itself when the organiser
 * typed an address rather than picking a person. Passing that through created
 * nineteen contacts on TQL literally named "BEary@tql.com", visible to their
 * reps and attributed to the integration user. A record named after an email is
 * worse than no record: the gap is obvious, the junk looks deliberate.
 *
 * So this requires something that looks like a person: no "@", and at least two
 * words. One-word display names are rejected too, because a lone "Bill" on a
 * customer account is not a contact anyone can use.
 */
export function realName(display: string | null): { first: string | null; last: string } | null {
  const full = (display ?? "").trim();
  if (full.length === 0 || full.includes("@")) return null;
  const parts = full.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1] };
}

/** Customer-side humans from a calendar invite. */
export function customerPeople(participants: unknown): Array<{ name: string | null; email: string }> {
  if (!Array.isArray(participants)) return [];
  const out: Array<{ name: string | null; email: string }> = [];
  const seen = new Set<string>();
  for (const raw of participants as Participant[]) {
    const email = (raw?.email ?? "").trim().toLowerCase();
    if (!email || !email.includes("@")) continue;
    if (email.endsWith(`@${INTERNAL_DOMAIN}`)) continue;
    if (NOT_A_PERSON.test(email)) continue;
    if (seen.has(email)) continue;
    seen.add(email);
    const name = (raw?.name ?? "").trim();
    out.push({ name: name.length > 0 ? name : null, email });
  }
  return out;
}

/**
 * Best title for a person, from the transcript.
 *
 * Matched on name, because the transcript has no addresses. A loose match is
 * worse than none here: putting the wrong job on the wrong person is a mistake
 * a rep sees immediately and never forgets, so this requires the extracted name
 * to contain, or be contained by, the invite name.
 */
export function titleFor(
  person: { name: string | null; email: string },
  extracted: KnownPerson[],
): string | null {
  const inviteName = (person.name ?? person.email.split("@")[0]).toLowerCase();
  for (const c of extracted) {
    const role = (c.role ?? "").trim();
    if (role.length === 0) continue;
    const n = c.name.trim().toLowerCase();
    if (n.length < 3) continue;
    if (inviteName.includes(n) || n.includes(inviteName)) return role.slice(0, 128);
  }
  return null;
}

/**
 * Create missing contacts and fill blank titles on an account.
 *
 * Fails soft: a Salesforce problem here must never affect the ingest pipeline,
 * because the transcript, the recap and the field write-back are all worth more
 * than a contact record.
 */
export async function syncContactsToSalesforce(args: {
  tenantSlug: string;
  accountId: string;
  participants: unknown;
  extracted: KnownPerson[];
  apply: boolean;
}): Promise<ContactSyncResult> {
  try {
    return await syncContactsInner(args);
  } catch (err) {
    // The docstring promises this cannot affect the pipeline, so it has to
    // actually catch. A scope violation throws, and the first version let it
    // escape and halt a backfill mid-run.
    return {
      created: 0,
      titlesFilled: 0,
      titleAlreadySet: 0,
      noTitleAvailable: 0,
      skipped: 0,
      notes: [`contact sync failed: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}

async function syncContactsInner(args: {
  tenantSlug: string;
  accountId: string;
  participants: unknown;
  extracted: KnownPerson[];
  apply: boolean;
}): Promise<ContactSyncResult> {
  const res: ContactSyncResult = {
    created: 0, titlesFilled: 0, titleAlreadySet: 0, noTitleAvailable: 0, skipped: 0, notes: [],
  };
  if (args.extracted.length === 0) {
    // Not fatal: identity comes from the invite, so people can still be created.
    // But no titles can be filled, and saying so beats reporting zero as if the
    // records were already complete.
    res.notes.push("no extracted people for this deal, so no titles could be sourced");
  }

  const people = customerPeople(args.participants);
  if (people.length === 0) {
    res.notes.push("no customer-side people on the invite");
    return res;
  }

  const { token, instanceUrl } = await getSalesforceClient();
  const auth = { authorization: `Bearer ${token}` };
  const jsonAuth = { ...auth, "content-type": "application/json" };

  // Existing contacts on the account, plus any contact anywhere matching one of
  // these addresses. The second query matters: a person already in Salesforce
  // under a different account must not be duplicated onto this one.
  const emails = people.map((p) => `'${p.email.replace(/'/g, "\\'")}'`).join(",");
  const soql =
    `SELECT Id, FirstName, LastName, Name, Email, Title FROM Contact ` +
    `WHERE AccountId = '${args.accountId}' OR Email IN (${emails})`;
  const qres = await fetch(`${instanceUrl}/services/data/${API}/query?q=${encodeURIComponent(soql)}`, {
    headers: auth,
  });
  if (!qres.ok) {
    // Could not read. Creating now would duplicate people who already exist, so
    // this stops rather than guessing. Absence of a result is not absence of a
    // contact.
    res.skipped = people.length;
    res.notes.push(`could not read existing contacts (${qres.status}), so nothing was written`);
    return res;
  }
  const existing = (((await qres.json()) as { records?: SfContact[] }).records ?? []) as SfContact[];
  const byEmail = new Map<string, SfContact>();
  for (const c of existing) {
    if (c.Email) byEmail.set(c.Email.toLowerCase(), c);
  }
  const byName = new Map<string, SfContact>();
  for (const c of existing) {
    if (c.Name) byName.set(c.Name.trim().toLowerCase(), c);
  }

  for (const p of people) {
    const title = titleFor(p, args.extracted);
    const match = byEmail.get(p.email) ?? (p.name ? byName.get(p.name.toLowerCase()) : undefined);

    if (match) {
      // Fill a blank Title, never replace one.
      if (match.Title && match.Title.trim().length > 0) {
        res.titleAlreadySet += 1;
        continue;
      }
      if (!title) {
        res.noTitleAvailable += 1;
        res.notes.push(`${match.Name ?? p.email} has no Title and the transcript gave no job for them`);
        continue;
      }
      if (!args.apply) {
        res.titlesFilled += 1;
        res.notes.push(`would set Title "${title}" on ${match.Name ?? p.email}`);
        continue;
      }
      // Authorization is granted by the same runtime route the field write-back
      // and the call activity use: the deal's domain-verified confirmed link,
      // asserted inside the scope rather than outside it. Calling the assert on
      // its own refuses every write, which is what the first version did.
      const upd = await runWithAuthorizedAccounts([args.accountId], async () =>
        recordWrite([{ label: "Contact title", value: `${match.Name ?? p.email}: ${title}`, mode: "update" }], async () => {
          assertScopedAccountWrite(args.tenantSlug, args.accountId, ["contacts"]);
          return fetch(`${instanceUrl}/services/data/${API}/sobjects/Contact/${match.Id}`, {
            method: "PATCH",
            headers: jsonAuth,
            body: JSON.stringify({ Title: title }),
          });
        }),
      );
      if (upd.status === 204) {
        res.titlesFilled += 1;
      } else {
        res.skipped += 1;
        res.notes.push(`Title update failed for ${match.Name ?? p.email}: ${(await upd.text().catch(() => "")).slice(0, 160)}`);
      }
      continue;
    }

    // No match anywhere: create, but only if the invite gave us a real name.
    // Without one we know an address attended and nothing else, and a contact
    // named after an address is junk a rep has to clean up.
    const named = realName(p.name);
    if (!named) {
      res.skipped += 1;
      res.notes.push(`${p.email} has no record and the invite gave no usable name, so none was created`);
      continue;
    }
    const body: Record<string, unknown> = {
      AccountId: args.accountId,
      LastName: named.last,
      Email: p.email,
    };
    if (named.first) body.FirstName = named.first;
    if (title) body.Title = title;

    if (!args.apply) {
      res.created += 1;
      res.notes.push(`would create ${p.name ?? p.email}${title ? ` (${title})` : ""}`);
      continue;
    }
    const ins = await runWithAuthorizedAccounts([args.accountId], async () =>
      recordWrite([{ label: "Contact", value: `${p.name ?? p.email}${title ? ` (${title})` : ""}`, mode: "create" }], async () => {
        assertScopedAccountWrite(args.tenantSlug, args.accountId, ["contacts"]);
        return fetch(`${instanceUrl}/services/data/${API}/sobjects/Contact`, {
          method: "POST",
          headers: jsonAuth,
          body: JSON.stringify(body),
        });
      }),
    );
    if (ins.status === 201) {
      res.created += 1;
      const created = (await ins.json().catch(() => ({}))) as { id?: string };
      if (created.id) byEmail.set(p.email, { Id: created.id, FirstName: named.first, LastName: named.last, Name: p.name, Email: p.email, Title: title });
    } else {
      res.skipped += 1;
      res.notes.push(`create failed for ${p.name ?? p.email}: ${(await ins.text().catch(() => "")).slice(0, 160)}`);
    }
  }

  return res;
}

/**
 * The Salesforce contact id to hang a call activity off, so the Task appears on
 * a person's timeline and not only the account's.
 *
 * Returns null when no customer person on the invite resolves to a contact.
 * Null means "no one to attach it to", which is why the Task still writes with
 * WhatId alone rather than being skipped.
 */
export async function primaryContactId(args: {
  accountId: string;
  participants: unknown;
}): Promise<string | null> {
  const people = customerPeople(args.participants);
  if (people.length === 0) return null;
  const { token, instanceUrl } = await getSalesforceClient();
  const emails = people.map((p) => `'${p.email.replace(/'/g, "\\'")}'`).join(",");
  const soql = `SELECT Id, Email FROM Contact WHERE AccountId = '${args.accountId}' AND Email IN (${emails}) LIMIT 5`;
  const r = await fetch(`${instanceUrl}/services/data/${API}/query?q=${encodeURIComponent(soql)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const rows = ((await r.json()) as { records?: Array<{ Id: string; Email: string | null }> }).records ?? [];
  if (rows.length === 0) return null;
  // Prefer the first invitee's own record, so the activity lands on whoever the
  // meeting was actually with rather than whoever Salesforce returned first.
  for (const p of people) {
    const hit = rows.find((c) => (c.Email ?? "").toLowerCase() === p.email);
    if (hit) return hit.Id;
  }
  return rows[0].Id;
}
