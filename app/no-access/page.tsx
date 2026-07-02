import { createSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "No access | DealRipe",
};

export default async function NoAccessPage({
  searchParams,
}: {
  searchParams: { reason?: string };
}) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const email = user?.email ?? "this account";

  const reasonNote = (() => {
    switch (searchParams.reason) {
      case "exchange-failed":
        return "The sign-in link was missing or expired. Try signing in again.";
      case "operator-only":
        return "Operator role is required for that page.";
      default:
        return null;
    }
  })();

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        background: "#FFFFFF",
        color: "#0F172A",
        fontFamily:
          'Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      }}
    >
      <div
        style={{
          maxWidth: 480,
          width: "100%",
          padding: 32,
          border: "1px solid #FECACA",
          borderRadius: 12,
        }}
      >
        <h1
          style={{
            fontSize: 22,
            margin: 0,
            marginBottom: 12,
            color: "#EF4444",
            fontWeight: 600,
          }}
        >
          Access not provisioned
        </h1>
        <p style={{ margin: 0, marginBottom: 12, color: "#475569", lineHeight: 1.5 }}>
          <strong>{email}</strong> is not yet provisioned for DealRipe. If you
          need access, reach out to the team and we will add you.
        </p>
        {reasonNote ? (
          <p style={{ margin: 0, marginBottom: 16, color: "#94A3B8", fontSize: 13 }}>
            {reasonNote}
          </p>
        ) : null}
        <a
          href="/login"
          style={{
            display: "inline-block",
            padding: "8px 14px",
            borderRadius: 8,
            background: "#0F172A",
            color: "#FFFFFF",
            textDecoration: "none",
            fontSize: 13,
            fontWeight: 500,
          }}
        >
          Try again
        </a>
      </div>
    </div>
  );
}
