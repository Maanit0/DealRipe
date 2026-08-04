/**
 * Verify that a CUSTOMER tenant (e.g. Magaya) has actually admin-consented our
 * app-only Microsoft Graph mail permissions.
 *
 * Why this script exists: the Azure "API permissions" blade in OUR tenant only
 * shows consent status for OUR directory. A customer's admin consent is recorded
 * in THEIR tenant, which we cannot see. The only reliable check is to mint an
 * app-only token against their tenant and read the `roles` claim.
 *
 *   npx tsx scripts/verify-graph-mail.ts --tenant <magaya-tenant-id-or-domain>
 *   npx tsx scripts/verify-graph-mail.ts --tenant magaya.com --probe jlopez@magaya.com
 *
 * --probe additionally does a single read against that mailbox to prove the
 * permission works end to end (reads one message header, nothing is written).
 *
 * Needs MS_CLIENT_ID and MS_CLIENT_SECRET in .env.local. Read-only. Sends nothing.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Decode a JWT payload without verifying (we only inspect our own token). */
function decodeClaims(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) return {};
  const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Resolve a domain (magaya.com) to its tenant GUID via the public discovery doc. */
async function resolveTenantId(tenantOrDomain: string): Promise<string> {
  if (/^[0-9a-f-]{36}$/i.test(tenantOrDomain)) return tenantOrDomain;
  const res = await fetch(`https://login.microsoftonline.com/${tenantOrDomain}/v2.0/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`Could not resolve tenant for "${tenantOrDomain}" (HTTP ${res.status})`);
  const doc = (await res.json()) as { issuer?: string };
  const m = /([0-9a-f-]{36})/i.exec(String(doc.issuer ?? ""));
  if (!m) throw new Error(`No tenant id in discovery document for "${tenantOrDomain}"`);
  return m[1];
}

async function main(): Promise<void> {
  const tenantArg = arg("--tenant");
  const probe = arg("--probe") ?? null;
  const clientId = process.env.MS_CLIENT_ID ?? process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET ?? process.env.MICROSOFT_CLIENT_SECRET;

  if (!tenantArg) {
    console.error('Usage: --tenant <tenant-id-or-domain> [--probe user@customer.com]');
    process.exit(1);
  }
  if (!clientId || !clientSecret) {
    console.error("MS_CLIENT_ID / MS_CLIENT_SECRET (or MICROSOFT_*) must be set in .env.local");
    process.exit(1);
  }

  const tenantId = await resolveTenantId(tenantArg);
  console.log(`\ntenant:   ${tenantArg}${tenantArg === tenantId ? "" : ` -> ${tenantId}`}`);
  console.log(`app:      ${clientId}\n`);

  // App-only token: this is the flow Application permissions require.
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "https://graph.microsoft.com/.default",
  });
  const tokenRes = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: string; error_description?: string };

  if (!tokenRes.ok || !tokenJson.access_token) {
    console.error(`TOKEN FAILED (HTTP ${tokenRes.status}): ${tokenJson.error ?? ""}`);
    // Never print the full description blindly; it can echo config. Trim it.
    console.error(String(tokenJson.error_description ?? "").split("\n")[0].slice(0, 200));
    if (String(tokenJson.error) === "invalid_client") {
      console.error("\n-> The app is not consented in this tenant, or the secret is wrong.");
    }
    process.exit(1);
  }

  const claims = decodeClaims(tokenJson.access_token);
  const roles = Array.isArray(claims.roles) ? (claims.roles as string[]) : [];
  console.log("app-only token acquired.");
  console.log(`roles granted in this tenant (${roles.length}):`);
  for (const r of roles.sort()) console.log(`  - ${r}`);

  const want = ["Mail.Read", "Mail.ReadWrite"];
  console.log("");
  for (const w of want) {
    console.log(`  ${roles.includes(w) ? "OK  " : "MISS"}  ${w}`);
  }
  if (!want.some((w) => roles.includes(w))) {
    console.log("\n-> No mail roles present. Admin consent has not landed in this tenant yet.");
  }

  if (probe) {
    console.log(`\nprobing mailbox: ${probe} (read-only, one message header)`);
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(probe)}/messages?$top=1&$select=id,receivedDateTime`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${tokenJson.access_token}` } });
    if (res.ok) {
      const j = (await res.json()) as { value?: unknown[] };
      console.log(`  OK    mailbox readable (${j.value?.length ?? 0} message header returned)`);
    } else {
      const t = await res.text();
      console.log(`  FAIL  HTTP ${res.status}`);
      // ErrorAccessDenied here usually means an Application Access Policy is
      // scoping the app away from this mailbox, which is the desired end state
      // once the policy is set to allow only the pilot reps.
      console.log(`  ${t.slice(0, 220)}`);
    }
  }
  console.log("");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
