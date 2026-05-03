import type { Config } from "tailwindcss";
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        navy: "#1a1f2e",
        navy2: "#252b3d",
        accent: "#22c55e",
        accentSoft: "#dcfce7",
        danger: "#ef4444",
        dangerSoft: "#fee2e2",
        warn: "#f59e0b",
        warnSoft: "#fef3c7",
        bg: "#f8fafc",
        line: "#e5e7eb",
        muted: "#64748b",
        ink: "#0f172a",
      },
      boxShadow: {
        card: "0 1px 2px rgba(15,23,42,0.04), 0 1px 3px rgba(15,23,42,0.06)",
        cardHover: "0 4px 12px rgba(15,23,42,0.08), 0 2px 4px rgba(15,23,42,0.06)",
      },
      borderRadius: {
        xl2: "14px",
      },
      fontFamily: {
        sans: ["-apple-system", "BlinkMacSystemFont", "Inter", "Segoe UI", "sans-serif"],
      },
    },
  },
  plugins: [],
};
export default config;
