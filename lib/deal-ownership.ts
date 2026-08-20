/**
 * Does the rep whose calendar carried the meeting actually own this account?
 *
 * WHY THIS EXISTS
 *
 * DealRipe attributes a deal to the rep whose calendar the meeting appeared
 * on. That is how calendar-sync finds work, and it is a reasonable default
 * that is often wrong. Eduardo Bencomo, 2026-08-19, unprompted:
 *
 *   "Please note that some accounts are no longer under my name. The meeting
 *    might be in my calendar because I'm invited to, or sometimes customers
 *    just decide to send me an invite out of the blue, like Starwood."
 *
 * He then sent three accounts and named the owners of two: CBX Global is
 * managed by Andrew Rubio's team, Starwood by Jeanette's. Both currently
 * attribute to Eduardo.
 *
 * Everything downstream inherits that error, and none of it is cosmetic:
 *
 *   - the weekly digest reports pipeline under the wrong rep, and Mark Buman
 *     reads it before Tuesday forecast calls
 *   - per-rep calibration, the thing the snapshot series exists to make
 *     possible, trains on deals the rep never worked
 *   - the briefing goes to someone who is attending, not selling
 *   - write-back lands under a rep who does not own the record
 *
 * WHAT THIS DOES NOT DO
 *
 * It does not decide anything. It answers one question with a distinguishable
 * result, and leaves the policy to callers, because the right response differs
 * per consumer: a digest should re-attribute, a briefing probably should still
 * go to the attendee (they are on the call), and a write should likely hold.
 * Encoding one answer here would force all three to share it.
 *
 * Every result distinguishes "no" from "did not check", per the standing rule.
 */

import { repName } from "./display-names";
import { getSalesforceClient } from "./salesforce";
import { supabaseAdmin } from "./supabase";

const API = "v60.0";

export type OwnershipStatus =
  /** The calendar rep IS the Salesforce account owner. */
  | "owner"
  /**
   * Owned by a BDR. NOT a misattribution.
   *
   * Magaya's motion is that a BDR sources the account and books the discovery
   * call, and an AE runs the deal. CLAUDE.md already records the consequence
   * ("there is always an activity on the account when a BDR books a discovery
   * call"); this is the same fact seen from the ownership side. The AE on the
   * call is the right rep, and re-attributing these to the BDR would be worse
   * than the bug it was meant to fix.
   */
  | "owned_by_bdr"
  /**
   * Owned by a DIFFERENT Account Executive or Manager. This is the real signal.
   *
   * Eduardo Bencomo, 2026-08-19: "some accounts are no longer under my name.
   * The meeting might be in my calendar because I'm invited to, or sometimes
   * customers just decide to send me an invite out of the blue, like Starwood."
   * These are the deals the digest reports under the wrong seller.
   */
  | "owned_by_other_ae"
  /**
   * Owned by an integration or marketing user, so no human is the seller of
   * record. Says nothing about which rep should carry it.
   */
  | "owned_by_integration"
  /** Owned by a human whose role we could not read. Undecidable, not "fine". */
  | "owner_role_unknown"
  /** The deal carries no rep email, so there is nobody to compare against. */
  | "no_rep"
  /** The rep has no matching Salesforce user, so the comparison cannot run. */
  | "rep_not_in_salesforce"
  /** No Salesforce account linked. */
  | "no_account"
  /** Linked below `confirmed`, so the account may not be this deal's at all. */
  | "unconfirmed_link"
  /** The read failed. Says nothing about who owns the account. */
  | "unavailable";

/**
 * Roles that mean "this person sources, they do not close".
 *
 * Read from UserRole.Name rather than guessed from the email domain. Magaya's
 * BDRs use firstname.lastname@magaya.com and its AEs use flastname@magaya.com,
 * which looks like a rule until it isn't.
 */
const SOURCING_ROLES = new Set(["BDR"]);

/** Roles that mean "this person carries the number". */
const SELLING_ROLES = new Set(["Account Executives", "Managers"]);

export type DealOwnership = {
  dealId: string;
  status: OwnershipStatus;
  repEmail: string | null;
  ownerId: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  ownerRole: string | null;
  /**
   * How the rep was matched to a Salesforce user.
   *
   * "email" is exact. "local_part" is a fallback that exists because Steven Johnson's
   * Salesforce user is sjohnson@acelynk.com while his calendar and deals carry
   * sjohnson@magaya.com, so an email-only match reported three of his own
   * accounts as belonging to someone else. The fallback is restricted to ACTIVE
   * users holding a selling role, because Salesforce also contains three other
   * users named "Juan Lopez" at customer domains and matching those would
   * attribute a Magaya deal to a customer's portal user.
   */
  repMatchedBy: "email" | "local_part" | null;
  /** Human-readable why, for a diagnostic that must not restate the rule. */
  reason: string;
};

type AccountRow = {
  Id: string;
  Name: string;
  OwnerId: string;
  Owner: {
    Name: string | null;
    Email: string | null;
    IsActive?: boolean;
    UserRole?: { Name: string | null } | null;
  } | null;
};

const CHUNK = 120;

/**
 * Resolve ownership for every deal asked about.
 *
 * Batched: one SOQL per 120 accounts. Returns an entry for every deal id given,
 * including ones it could not answer for, because an absent key would let a
 * caller conclude "owner" by default and silently keep the bug.
 */
export async function resolveDealOwnership(
  tenantId: string,
  dealIds: string[],
): Promise<Map<string, DealOwnership>> {
  const out = new Map<string, DealOwnership>();
  if (dealIds.length === 0) return out;

  const put = (
    dealId: string,
    status: OwnershipStatus,
    reason: string,
    extra: Partial<DealOwnership> = {},
  ) =>
    out.set(dealId, {
      dealId,
      status,
      repEmail: extra.repEmail ?? null,
      ownerId: extra.ownerId ?? null,
      ownerName: extra.ownerName ?? null,
      ownerEmail: extra.ownerEmail ?? null,
      ownerRole: extra.ownerRole ?? null,
      repMatchedBy: extra.repMatchedBy ?? null,
      reason,
    });

  const db = supabaseAdmin();
  const res = await db
    .from("deals")
    .select("id, rep_email, salesforce_account_id, salesforce_link_confidence")
    .eq("tenant_id", tenantId)
    .in("id", dealIds);

  if (res.error) {
    const reason = `deals lookup failed: ${res.error.message}`;
    console.error(`[ownership] ${reason}`);
    for (const id of dealIds) put(id, "unavailable", reason);
    return out;
  }

  const rows = (res.data ?? []) as Array<{
    id: string;
    rep_email: string | null;
    salesforce_account_id: string | null;
    salesforce_link_confidence: string | null;
  }>;
  const seen = new Set(rows.map((r) => r.id));
  for (const id of dealIds) {
    if (!seen.has(id)) put(id, "unavailable", "deal not found in tenant");
  }

  const wanted = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!r.salesforce_account_id) {
      put(r.id, "no_account", "no Salesforce account linked", { repEmail: r.rep_email });
      continue;
    }
    if (r.salesforce_link_confidence !== "confirmed") {
      put(
        r.id,
        "unconfirmed_link",
        `link confidence is '${r.salesforce_link_confidence ?? "none"}', so this account may not be this deal's`,
        { repEmail: r.rep_email },
      );
      continue;
    }
    if (!r.rep_email) {
      put(r.id, "no_rep", "deal carries no rep_email, so there is nobody to compare the owner against", {});
      continue;
    }
    const list = wanted.get(r.salesforce_account_id) ?? [];
    list.push(r);
    wanted.set(r.salesforce_account_id, list);
  }
  if (wanted.size === 0) return out;

  let client: { instanceUrl: string; token: string };
  try {
    client = await getSalesforceClient();
  } catch (err) {
    const reason = `Salesforce auth failed: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[ownership] ${reason}`);
    for (const list of wanted.values()) {
      for (const r of list) put(r.id, "unavailable", reason, { repEmail: r.rep_email });
    }
    return out;
  }

  // ------------------------------------------------------------------
  // Resolve each rep to a Salesforce user first.
  //
  // deals.rep_email is the rep's Magaya login. It is NOT reliably their
  // Salesforce user's Email: Steven Johnson's Salesforce user is
  // sjohnson@acelynk.com while his calendar and deals carry
  // sjohnson@magaya.com, so comparing the two directly reported three of his
  // own accounts as belonging to someone else.
  //
  // The name fallback is deliberately narrow. Salesforce holds three other
  // active users named "Juan Lopez", at solucioneslogisticasinc.com,
  // duniquetrading.com and itranstrade.com, so an unrestricted name match
  // would attribute a Magaya deal to a customer's portal user. Only ACTIVE
  // users holding a selling role are eligible, and only on an exact,
  // unambiguous name match.
  // ------------------------------------------------------------------
  const repEmails = [...new Set(rows.map((r) => r.rep_email).filter((e): e is string => !!e))];
  const repToUser = new Map<string, { id: string; email: string; via: "email" | "local_part" }>();
  if (repEmails.length > 0) {
    const emailIn = repEmails.map((e) => `'${e.replace(/'/g, "")}'`).join(",");
    const locals = [...new Set(repEmails.map((e) => e.split("@")[0].trim().toLowerCase()))];
    // Salesforce has no local-part function, so ask for anything starting with
    // the local part and filter exactly in code.
    const likeClauses = locals.map((l) => `Email LIKE '${l.replace(/[%_']/g, "")}@%'`).join(" OR ");
    const userSoql =
      `SELECT Id, Name, Email, IsActive, UserRole.Name FROM User ` +
      `WHERE Email IN (${emailIn})${likeClauses ? ` OR ${likeClauses}` : ""}`;
    const ur = await fetch(
      `${client.instanceUrl}/services/data/${API}/query?q=${encodeURIComponent(userSoql)}`,
      { headers: { Authorization: `Bearer ${client.token}` } },
    );
    if (ur.ok) {
      type UserRow = {
        Id: string;
        Name: string;
        Email: string;
        IsActive: boolean;
        UserRole: { Name: string | null } | null;
      };
      const users = ((await ur.json()) as { records?: UserRow[] }).records ?? [];
      const byEmail = new Map(users.map((u) => [u.Email.trim().toLowerCase(), u]));
      for (const email of repEmails) {
        // An exact email match is only trusted when the user is ACTIVE.
        //
        // Three Salesforce users share the local part "sjohnson": Steven
        // Johnson at sjohnson@acelynk.com (active, Account Executives),
        // Shardae Johnson at sjohnson@magaya.com (DEACTIVATED, Account
        // Managers), and Sherene Johnson at sjohnson@mailboatbahamas.com.
        // deals.rep_email for Steven is sjohnson@magaya.com, which is his
        // calendar identity and Shardae's Salesforce user, so the exact match
        // resolved confidently to the wrong human and reported three of
        // Steven's own accounts as owned by someone else.
        //
        // A deactivated user cannot be the rep who ran a call last week.
        const exact = byEmail.get(email.trim().toLowerCase());
        if (exact && exact.IsActive) {
          repToUser.set(email, { id: exact.Id, email: exact.Email, via: "email" });
          continue;
        }
        // Same local part on a different Magaya-owned domain. Steven Johnson's
        // Salesforce user is sjohnson@acelynk.com while his calendar and deals
        // carry sjohnson@magaya.com, and an email-only match reported three of
        // his own accounts as owned by someone else.
        //
        // Local part rather than display name, because repName() returns a
        // FIRST name ("Steven") and Salesforce holds full names, and because
        // Salesforce contains three other active users called "Juan Lopez" at
        // customer domains. Their local parts are juan.lopez, juanlopez and
        // jclopez, none of which is jlopez, so this rule separates them where a
        // name match would have merged them.
        const local = email.split("@")[0].trim().toLowerCase();
        const candidates = users.filter(
          (u) =>
            u.Email.split("@")[0].trim().toLowerCase() === local &&
            u.IsActive &&
            SELLING_ROLES.has(u.UserRole?.Name ?? ""),
        );
        // Exactly one, or decline. Two candidates is not a coin flip.
        if (candidates.length === 1) {
          repToUser.set(email, { id: candidates[0].Id, email: candidates[0].Email, via: "local_part" });
        }
      }
    } else {
      console.error(`[ownership] user lookup failed: ${ur.status}`);
    }
  }

  const accountIds = [...wanted.keys()];
  const byAccount = new Map<string, AccountRow>();

  for (let i = 0; i < accountIds.length; i += CHUNK) {
    const chunk = accountIds.slice(i, i + CHUNK);
    const inList = chunk.map((id) => `'${id.replace(/[^a-zA-Z0-9]/g, "")}'`).join(",");
    const soql =
      `SELECT Id, Name, OwnerId, Owner.Name, Owner.Email, Owner.IsActive, Owner.UserRole.Name ` +
      `FROM Account WHERE Id IN (${inList})`;
    const r = await fetch(
      `${client.instanceUrl}/services/data/${API}/query?q=${encodeURIComponent(soql)}`,
      { headers: { Authorization: `Bearer ${client.token}` } },
    );
    if (!r.ok) {
      // Scope the failure to this chunk. The other chunks may still answer.
      const reason = `SOQL ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`;
      console.error(`[ownership] ${reason}`);
      for (const acc of chunk) {
        for (const d of wanted.get(acc) ?? []) put(d.id, "unavailable", reason, { repEmail: d.rep_email });
      }
      continue;
    }
    for (const rec of ((await r.json()) as { records?: AccountRow[] }).records ?? []) {
      byAccount.set(rec.Id, rec);
    }
  }

  for (const [accountId, dealsOnAccount] of wanted) {
    const acc = byAccount.get(accountId);
    for (const d of dealsOnAccount) {
      if (out.has(d.id) && out.get(d.id)!.status === "unavailable") continue; // chunk failed
      if (!acc) {
        put(d.id, "unavailable", `account ${accountId} was asked about and not returned`, {
          repEmail: d.rep_email,
        });
        continue;
      }
      const ownerEmail = acc.Owner?.Email ?? null;
      const ownerName = acc.Owner?.Name ?? null;
      const ownerRole = acc.Owner?.UserRole?.Name ?? null;
      const repUser = d.rep_email ? repToUser.get(d.rep_email) : undefined;
      const base = {
        repEmail: d.rep_email,
        ownerId: acc.OwnerId,
        ownerName,
        ownerEmail,
        ownerRole,
        repMatchedBy: repUser?.via ?? null,
      };

      if (!repUser) {
        put(
          d.id,
          "rep_not_in_salesforce",
          `${d.rep_email} matches no active Salesforce user by email or name, so we cannot say whether they own ${acc.Name}`,
          base,
        );
        continue;
      }

      if (acc.OwnerId === repUser.id) {
        put(d.id, "owner", `${d.rep_email} owns ${acc.Name}`, base);
        continue;
      }

      // An owner with no role is usually an integration or marketing user.
      // Distinguish the two rather than folding both into "not the rep".
      if (ownerRole === null) {
        const looksAutomated = /integration|marketing|admin|system/i.test(ownerName ?? "");
        put(
          d.id,
          looksAutomated ? "owned_by_integration" : "owner_role_unknown",
          looksAutomated
            ? `${acc.Name} is owned by ${ownerName}, which is not a person, so no rep is the seller of record`
            : `${acc.Name} is owned by ${ownerName ?? acc.OwnerId}, whose role we could not read`,
          base,
        );
        continue;
      }

      if (SOURCING_ROLES.has(ownerRole)) {
        put(
          d.id,
          "owned_by_bdr",
          `${acc.Name} is owned by ${ownerName} (${ownerRole}) who sourced it; ${d.rep_email} works the deal, which is the normal motion`,
          base,
        );
        continue;
      }

      if (SELLING_ROLES.has(ownerRole)) {
        put(
          d.id,
          "owned_by_other_ae",
          `${acc.Name} is owned by ${ownerName} (${ownerRole}), a different seller, not by ${d.rep_email} who was on the call`,
          base,
        );
        continue;
      }

      put(
        d.id,
        "owner_role_unknown",
        `${acc.Name} is owned by ${ownerName} whose role '${ownerRole}' is neither a sourcing nor a selling role`,
        base,
      );
    }
  }

  return out;
}
