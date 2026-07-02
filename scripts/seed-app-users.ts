/**
 * Idempotent seed for the magic-link auth roster.
 *
 * Inserts:
 *   maanits@berkeley.edu  -> operator, tenant=topsort
 *   mbuman@magaya.com     -> cro,      tenant=magaya
 *
 * Both tenants must already exist (run npm run seed:magaya and
 * npm run migrate:extractions first).
 *
 * On conflict (email): updates tenant_id + role. The unique constraint
 * is on email alone, so changing a user's tenant or role just by
 * re-running this script works as expected.
 *
 * Run: npm run seed:app-users
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const USERS = [
  {
    email: "maanits@berkeley.edu",
    role: "operator" as const,
    tenantSlug: "topsort",
  },
  {
    email: "mbuman@magaya.com",
    role: "cro" as const,
    tenantSlug: "magaya",
  },
];

async function main(): Promise<void> {
  const db = supabaseAdmin();

  console.log("seed:app-users starting...");

  for (const u of USERS) {
    let tenantId: string;
    try {
      tenantId = await resolveTenantId(u.tenantSlug);
    } catch (err) {
      console.error(
        `tenant '${u.tenantSlug}' not found. Run \`npm run seed:${u.tenantSlug}\` (or migrate:extractions for topsort) first.`,
      );
      process.exit(1);
    }

    const res = await db
      .from("app_users")
      .upsert(
        {
          email: u.email,
          tenant_id: tenantId,
          role: u.role,
        },
        { onConflict: "email" },
      )
      .select("id")
      .single();
    if (res.error || !res.data) {
      console.error(`upsert failed for ${u.email}: ${res.error?.message}`);
      process.exit(1);
    }
    console.log(
      `  ${u.email.padEnd(28)} -> ${u.role.padEnd(8)} tenant=${u.tenantSlug.padEnd(8)} id=${res.data.id}`,
    );
  }

  console.log("seed:app-users complete.");
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
