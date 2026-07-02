import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Sign in | DealRipe",
};

export default function LoginPage({
  searchParams,
}: {
  searchParams: { next?: string; sent?: string };
}) {
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
          maxWidth: 420,
          width: "100%",
          padding: 32,
          border: "1px solid #E2E8F0",
          borderRadius: 12,
          background: "#FFFFFF",
        }}
      >
        <h1
          style={{
            fontSize: 22,
            margin: 0,
            marginBottom: 8,
            color: "#0F172A",
            fontWeight: 600,
          }}
        >
          Sign in to DealRipe
        </h1>
        <p
          style={{
            margin: 0,
            marginBottom: 24,
            color: "#64748B",
            fontSize: 14,
            lineHeight: 1.5,
          }}
        >
          Enter your work email. We send a sign-in link. No passwords.
        </p>
        <LoginForm next={searchParams.next} />
      </div>
    </div>
  );
}
