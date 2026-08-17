/**
 * Matching a meeting to its Salesforce account, Eduardo's way.
 *
 * Eduardo, 2026-08-14, on the call where he walked through Dunavant:
 *
 *   "there's always an activity when that [discovery call] is going to happen,
 *    so that's the most accurate way to match it: the calendar is [a date] and
 *    in Salesforce there is an activity with Debra on that day, this is the
 *    account."
 *
 * And his own edge case, in the same breath:
 *
 *   "here's the edge case: I was the one that created the call with the
 *    prospect, and typically I won't put an activity here... so if you come
 *    look for it you might not find it... the only thing you could do is if you
 *    don't find it, send an automated email to the owner."
 *
 * WHY THIS IS A LIBRARY AND NOT A SCRIPT
 *
 * This ladder already existed in scripts/auto-link-salesforce.ts and had never
 * run in production once. The relink cron calls resolveAccountForDeal, which
 * resolves by DOMAIN and NAME, which is what put Dunavant on a stale 2021
 * record for a week and left ten of Eduardo's deals unlinked. Both of those are
 * fixed by the rungs below, and neither was fixed by having them in a script a
 * human runs by hand.
 *
 * THE RUNGS, strongest first. Each says which one it used, because a link found
 * by exact address and a link found by company name are not the same claim and
 * only the strong ones may write:
 *
 *   contact_email  an attendee's exact address is a Contact on an account.
 *                  Immune to the free-mail problem: we match the address, never
 *                  '%@gmail.com', which once returned a stranger's company.
 *   activity       a Task or Event on the meeting's own date whose attendee is
 *                  one of ours. Eduardo's rung.
 *   contact_recent the attendee is a Contact but there was no activity, so the
 *                  person answers it even though the calendar did not.
 *   domain         a company web domain, never a free-mail one.
 *   name           the account name. Weakest, and never confirmed.
 *
 * Only contact_email and activity produce 'confirmed'. Everything else records
 * the id at 'review', which is a deal that is correctly linked and correctly
 * refuses to write until a person confirms it: salesforce_link_confidence fails
 * closed below confirmed, deliberately.
 */

import { getSalesforceClient } from "./salesforce";

const API = "v61.0";
const HOME_DOMAIN = "magaya.com";

/** Never resolved by domain, only by exact address. */
const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com",
  "live.com", "aol.com", "icloud.com", "me.com", "msn.com", "protonmail.com",
  "yandex.com", "qq.com", "163.com", "126.com",
]);

export type MatchRung =
  | "contact_email"
  | "activity"
  | "contact_recent"
  | "domain"
  | "name";

export type AccountMatch = {
  accountId: string;
  accountName: string;
  rung: MatchRung;
  /** 'confirmed' only from the two strong rungs. */
  confidence: "confirmed" | "review";
  /** What actually matched, for a human reading a diagnostic. */
  via: string;
  /**
   * The parent account, when this one has a parent.
   *
   * Magaya deploys per office, so one customer is several accounts and Medov
   * Logistics is the parent of Medov Europe. Eduardo is relaxed about landing
   * on the wrong one and is not relaxed about not knowing which was used, so
   * this is reported rather than silently followed.
   */
  parent: { id: string; name: string } | null;
  /** Set when a current 001RN twin was chosen over a legacy 0013j record. */
  preferredOverLegacy: string | null;
};

export type AccountMatchResult =
  | { status: "matched"; match: AccountMatch }
  /** Several accounts fit and a person has to choose. Names them. */
  | { status: "ambiguous"; why: string; candidates: Array<{ id: string; name: string }> }
  /** We looked properly and nothing matched. Says which rungs were tried. */
  | { status: "none"; why: string; triedRungs: MatchRung[] }
  /** A query failed. NOT the same as nothing matching, and never written. */
  | { status: "unavailable"; why: string };

function esc(s: string): string {
  return s.replace(/'/g, "\\'");
}

function domainOf(email: string): string | null {
  const at = email.lastIndexOf("@");
  return at > 0 ? email.slice(at + 1).toLowerCase() : null;
}

/**
 * Account ids beginning 0013j are legacy records and 001RN are current;
 * characters four to six encode the instance the record was created on.
 * Salesforce's own duplicate rule does not catch the twins.
 */
export function isLegacyAccountId(id: string): boolean {
  return id.startsWith("0013j");
}

/**
 * Account names that are not a company.
 *
 * "Tbd" is a real account in Magaya's org and two separate deals matched it
 * through a contact on it. Storing that as a confirmed link would point two
 * customers at one placeholder and then write both their qualification data
 * into it. A placeholder is a strong signal that somebody has not finished
 * setting the record up, so it is never confirmed no matter which rung found
 * it: a person should look.
 */
export function isPlaceholderAccountName(name: string): boolean {
  const n = name.trim().toLowerCase();
  if (n.length === 0) return true;
  return (
    /^(tbd|tba|test|unknown|n\/?a|none|new account|placeholder|do not use)$/.test(n) ||
    /^\[.*\]$/.test(n) ||
    /not provided/.test(n)
  );
}

export async function matchAccountForMeeting(args: {
  /** Every attendee address on the invite, internal ones included. */
  attendeeEmails: ReadonlyArray<string>;
  /** The meeting date, YYYY-MM-DD, for the activity rung. */
  meetingDate?: string | null;
  /** The deal's account name, for the weakest rung. */
  accountName?: string | null;
}): Promise<AccountMatchResult> {
  let token: string;
  let instanceUrl: string;
  try {
    ({ token, instanceUrl } = await getSalesforceClient());
  } catch (e) {
    return {
      status: "unavailable",
      why: `Salesforce auth failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const auth = { authorization: `Bearer ${token}` };

  /** Null means the query FAILED. Callers must not read it as "nothing found". */
  const q = async <T>(soql: string): Promise<T[] | null> => {
    try {
      const r = await fetch(
        `${instanceUrl}/services/data/${API}/query?q=${encodeURIComponent(soql)}`,
        { headers: auth },
      );
      if (!r.ok) return null;
      return ((await r.json()) as { records?: T[] }).records ?? [];
    } catch {
      return null;
    }
  };

  const tried: MatchRung[] = [];

  const external = args.attendeeEmails
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.includes("@") && domainOf(e) !== HOME_DOMAIN);
  if (external.length === 0 && !args.accountName) {
    return { status: "none", why: "no external attendee on the invite", triedRungs: [] };
  }

  /** Account name, parent, and the legacy-twin preference, in one read. */
  const finish = async (
    accountId: string,
    rung: MatchRung,
    confidence: "confirmed" | "review",
    via: string,
  ): Promise<AccountMatchResult> => {
    const rows = await q<{ Id: string; Name: string; ParentId: string | null; Parent: { Name: string } | null }>(
      `SELECT Id, Name, ParentId, Parent.Name FROM Account WHERE Id = '${esc(accountId)}' LIMIT 1`,
    );
    if (rows === null) {
      return { status: "unavailable", why: `matched ${accountId} but the account read failed` };
    }
    const a = rows[0];
    if (!a) return { status: "unavailable", why: `matched ${accountId} but no such account came back` };

    let finalId = a.Id;
    let finalName = a.Name;
    let preferredOverLegacy: string | null = null;

    // A legacy 0013j record with a current 001RN twin of the same name is
    // almost always the wrong one to write to: two deals were pointed at 3j
    // accounts with zero activity while the live opportunity sat on the twin.
    if (isLegacyAccountId(a.Id)) {
      // Match the twin on name OR website. An exact-name search alone misses
      // it whenever the legacy record carries a typo, and the legacy records
      // are exactly where the typos are: this org holds
      // "UNITED CUSOTMHOUSE BROKERS INC".
      const head = a.Name.trim().split(/\s+/).slice(0, 2).join(" ");
      const twins = await q<{ Id: string; Name: string }>(
        `SELECT Id, Name FROM Account WHERE Id != '${esc(a.Id)}' AND ` +
          `(Name = '${esc(a.Name)}'${head.length >= 4 ? ` OR Name LIKE '${esc(head)}%'` : ""}) LIMIT 5`,
      );
      const current = (twins ?? []).find((t) => !isLegacyAccountId(t.Id));
      if (current) {
        preferredOverLegacy = a.Id;
        finalId = current.Id;
        finalName = current.Name;
      }
    }

    // Two demotions to review, both of which produce a link that is stored and
    // refuses to write until a person confirms it.
    let effective = confidence;
    const notes: string[] = [];
    if (isPlaceholderAccountName(finalName)) {
      effective = "review";
      notes.push(`account name "${finalName}" is a placeholder, not a company`);
    }
    if (isLegacyAccountId(finalId) && !preferredOverLegacy) {
      effective = "review";
      notes.push(`legacy 0013j record with no current 001RN twin found`);
    }

    return {
      status: "matched",
      match: {
        accountId: finalId,
        accountName: finalName,
        rung,
        confidence: effective,
        via: notes.length ? `${via} (${notes.join("; ")})` : via,
        parent: a.ParentId ? { id: a.ParentId, name: a.Parent?.Name ?? "(unread)" } : null,
        preferredOverLegacy,
      },
    };
  };

  const inList = external.map((e) => `'${esc(e)}'`).join(",");

  // ---- Rung 1: exact address against Contact.
  if (external.length > 0) {
    tried.push("contact_email");
    const contacts = await q<{ Id: string; Email: string; AccountId: string | null }>(
      `SELECT Id, Email, AccountId FROM Contact WHERE Email IN (${inList}) AND AccountId != null LIMIT 20`,
    );
    if (contacts === null) {
      return { status: "unavailable", why: "the Contact query failed, so this is unknown rather than unmatched" };
    }
    if (contacts.length > 0) {
      const ids = [...new Set(contacts.map((c) => c.AccountId as string))];
      if (ids.length === 1) {
        return finish(ids[0], "contact_email", "confirmed", `contact ${contacts[0].Email}`);
      }
      // Eduardo raised exactly this: "if this person is connected to multiple
      // accounts, which could happen easily". Name them rather than guessing.
      const named = await q<{ Id: string; Name: string }>(
        `SELECT Id, Name FROM Account WHERE Id IN (${ids.map((i) => `'${esc(i)}'`).join(",")})`,
      );
      return {
        status: "ambiguous",
        why: `the attendees are contacts on ${ids.length} different accounts`,
        candidates: (named ?? []).map((n) => ({ id: n.Id, name: n.Name })),
      };
    }
  }

  // ---- Rung 2: Eduardo's rung. An activity on the meeting's own date.
  //
  // Both Task AND Event. The earlier version queried Task only, and a BDR who
  // books a discovery call usually creates an Event, which is the single most
  // common shape of the thing this rung exists to find.
  if (external.length > 0 && args.meetingDate) {
    tried.push("activity");
    const d = args.meetingDate.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      return { status: "unavailable", why: `meeting date "${args.meetingDate}" is not a date` };
    }
    const [tasks, events] = await Promise.all([
      q<{ WhatId: string | null; Subject: string; Who: { Email: string | null } | null }>(
        `SELECT WhatId, Subject, Who.Email FROM Task ` +
          `WHERE ActivityDate = ${d} AND Who.Email IN (${inList}) AND WhatId != null LIMIT 10`,
      ),
      q<{ WhatId: string | null; Subject: string; Who: { Email: string | null } | null }>(
        `SELECT WhatId, Subject, Who.Email FROM Event ` +
          `WHERE ActivityDate = ${d} AND Who.Email IN (${inList}) AND WhatId != null LIMIT 10`,
      ),
    ]);
    if (tasks === null && events === null) {
      return { status: "unavailable", why: "both activity queries failed; unknown, not unmatched" };
    }
    const hit = [...(tasks ?? []), ...(events ?? [])].find((a) => (a.WhatId ?? "").startsWith("001"));
    if (hit?.WhatId) {
      return finish(hit.WhatId, "activity", "confirmed", `"${hit.Subject}" on ${d}`);
    }
  }

  // ---- Rung 3: the person exists but nothing was logged on the day.
  //
  // This is Eduardo's own edge case: he books the meeting himself and logs the
  // activity after the fact or never. The contact is still the strongest thing
  // available, but without the date corroborating it this is 'review'.
  if (external.length > 0) {
    tried.push("contact_recent");
    const domains = [...new Set(external.map(domainOf).filter((d): d is string => Boolean(d)))].filter(
      (d) => !FREE_MAIL.has(d),
    );
    if (domains.length > 0) {
      const like = domains.map((d) => `Email LIKE '%@${esc(d)}'`).join(" OR ");
      const byDomain = await q<{ AccountId: string | null; Email: string }>(
        `SELECT AccountId, Email FROM Contact WHERE (${like}) AND AccountId != null LIMIT 20`,
      );
      if (byDomain === null) {
        return { status: "unavailable", why: "the contact-by-domain query failed" };
      }
      const ids = [...new Set(byDomain.map((c) => c.AccountId as string))];
      if (ids.length === 1) {
        return finish(ids[0], "contact_recent", "review", `a contact at ${domains[0]}`);
      }
      if (ids.length > 1) {
        const named = await q<{ Id: string; Name: string }>(
          `SELECT Id, Name FROM Account WHERE Id IN (${ids.map((i) => `'${esc(i)}'`).join(",")})`,
        );
        return {
          status: "ambiguous",
          why: `${ids.length} accounts have contacts at ${domains.join(", ")}`,
          candidates: (named ?? []).map((n) => ({ id: n.Id, name: n.Name })),
        };
      }
    }
  }

  // ---- Rung 4: the company web domain. Never a free-mail one.
  const domains = [...new Set(external.map(domainOf).filter((d): d is string => Boolean(d)))].filter(
    (d) => !FREE_MAIL.has(d),
  );
  for (const d of domains) {
    tried.push("domain");
    const rows = await q<{ Id: string; Name: string }>(
      `SELECT Id, Name FROM Account WHERE Website LIKE '%${esc(d)}%' LIMIT 5`,
    );
    if (rows === null) return { status: "unavailable", why: `the account-by-domain query failed for ${d}` };
    if (rows.length === 1) return finish(rows[0].Id, "domain", "review", `website contains ${d}`);
    if (rows.length > 1) {
      return {
        status: "ambiguous",
        why: `${rows.length} accounts share the domain ${d}`,
        candidates: rows.map((r) => ({ id: r.Id, name: r.Name })),
      };
    }
  }

  // ---- Rung 5: the name. Weakest, review only.
  const name = (args.accountName ?? "").trim();
  if (name.length >= 4) {
    tried.push("name");
    const rows = await q<{ Id: string; Name: string }>(
      `SELECT Id, Name FROM Account WHERE Name LIKE '%${esc(name)}%' LIMIT 5`,
    );
    if (rows === null) return { status: "unavailable", why: "the account-by-name query failed" };
    if (rows.length === 1) return finish(rows[0].Id, "name", "review", `name matches "${rows[0].Name}"`);
    if (rows.length > 1) {
      return {
        status: "ambiguous",
        why: `${rows.length} accounts match the name "${name}"`,
        candidates: rows.map((r) => ({ id: r.Id, name: r.Name })),
      };
    }
  }

  return {
    status: "none",
    why:
      domains.length === 0
        ? "only free-mail attendees, and none of them is a Contact"
        : "no contact, activity, domain or name matched",
    triedRungs: tried,
  };
}

/** One line for a diagnostic or an email to the account owner. */
export function describeMatch(r: AccountMatchResult): string {
  switch (r.status) {
    case "matched": {
      const m = r.match;
      const bits = [`${m.accountName} (${m.accountId}) via ${m.rung}: ${m.via}`];
      if (m.confidence === "review") bits.push("confidence review, will not write until confirmed");
      if (m.parent) bits.push(`child of ${m.parent.name} (${m.parent.id})`);
      if (m.preferredOverLegacy) bits.push(`chosen over legacy record ${m.preferredOverLegacy}`);
      return bits.join("; ");
    }
    case "ambiguous":
      return `${r.why}: ${r.candidates.map((c) => `${c.name} (${c.id})`).join(", ")}`;
    case "none":
      return `${r.why} (tried ${r.triedRungs.join(", ") || "nothing"})`;
    case "unavailable":
      return r.why;
  }
}
