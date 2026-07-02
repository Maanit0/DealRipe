import { redirect } from "next/navigation";

import { decodeAccessTokenClaims } from "@/lib/jwt-claims";
import { supabaseAdmin } from "@/lib/supabase";
import { createSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Operator | DealRipe",
};

/**
 * Operator landing page.
 *
 * Middleware already gates this route to authenticated users with
 * app_role=operator, so by the time we render here we can trust the
 * session. We re-check the claim defensively in case the middleware
 * is ever bypassed.
 *
 * Operators can use the service role to fetch the tenant list (the
 * cross-tenant view). This is the one place in the app where service
 * role is reached from a request handler; future tenant-switching
 * server actions also live under /operator so the bypass surface
 * stays small and inspectable.
 */
export default async function OperatorPage() {
  const supabase = createSupabaseServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) redirect("/login");

  const claims = decodeAccessTokenClaims(session.access_token);
  if (claims?.app_role !== "operator") {
    redirect("/no-access?reason=operator-only");
  }

  const admin = supabaseAdmin();
  const { data: tenants } = await admin
    .from("tenants")
    .select("id, slug, name, created_at")
    .order("slug", { ascending: true });

  return (
    <div
      style={{
        minHeight: "100vh",
        padding: "48px 32px",
        background: "#FFFFFF",
        color: "#0F172A",
        fontFamily:
          'Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      }}
    >
      <div style={{ maxWidth: 720, margin: "0 auto" }}>
        <div
          style={{
            marginBottom: 32,
            paddingBottom: 16,
            borderBottom: "1px solid #E2E8F0",
          }}
        >
          <div
            style={{
              display: "inline-block",
              padding: "2px 10px",
              borderRadius: 999,
              background: "#F59E0B",
              color: "#FFFFFF",
              fontSize: 12,
              fontWeight: 600,
              marginBottom: 12,
            }}
          >
            Operator mode
          </div>
          <h1 style={{ fontSize: 24, margin: 0, marginBottom: 6, fontWeight: 600 }}>
            Tenants
          </h1>
          <p style={{ margin: 0, color: "#64748B", fontSize: 14 }}>
            Signed in as {session.user.email}. Cross-tenant view uses the
            service role server-side.
          </p>
        </div>

        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: 14,
          }}
        >
          <thead>
            <tr style={{ textAlign: "left", color: "#64748B", fontSize: 12 }}>
              <th style={{ padding: "8px 12px", borderBottom: "1px solid #E2E8F0" }}>
                Slug
              </th>
              <th style={{ padding: "8px 12px", borderBottom: "1px solid #E2E8F0" }}>
                Name
              </th>
              <th style={{ padding: "8px 12px", borderBottom: "1px solid #E2E8F0" }}>
                Created
              </th>
            </tr>
          </thead>
          <tbody>
            {(tenants ?? []).map((t) => (
              <tr key={t.id}>
                <td style={{ padding: "10px 12px", borderBottom: "1px solid #F1F5F9" }}>
                  <code style={{ fontSize: 13 }}>{t.slug}</code>
                </td>
                <td style={{ padding: "10px 12px", borderBottom: "1px solid #F1F5F9" }}>
                  {t.name}
                </td>
                <td
                  style={{
                    padding: "10px 12px",
                    borderBottom: "1px solid #F1F5F9",
                    color: "#94A3B8",
                    fontSize: 13,
                  }}
                >
                  {t.created_at.slice(0, 10)}
                </td>
              </tr>
            ))}
            {!tenants?.length && (
              <tr>
                <td colSpan={3} style={{ padding: 16, color: "#94A3B8" }}>
                  No tenants yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
