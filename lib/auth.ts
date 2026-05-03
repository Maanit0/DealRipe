// Fake auth — no real backend. Stores a session in a cookie + localStorage.
export type Role = "CRO" | "AE";

export type SessionUser = {
  email: string;
  name: string;
  firstName: string;
  role: Role;
  aeName?: string; // when role === "AE", filter dashboard to this AE's deals
};

export const USERS: Record<string, { password: string; user: SessionUser }> = {
  "paul@topsort.com": {
    password: "demo123",
    user: {
      email: "paul@topsort.com",
      name: "Paul Foreman",
      firstName: "Paul",
      role: "CRO",
    },
  },
  "regina@topsort.com": {
    password: "demo123",
    user: {
      email: "regina@topsort.com",
      name: "Regina Alvarez",
      firstName: "Regina",
      role: "AE",
      aeName: "Regina",
    },
  },
};

const COOKIE = "dealripe_session";
const ONBOARDED_KEY = "dealripe_onboarded";

export function login(email: string, password: string): SessionUser | null {
  const entry = USERS[email.toLowerCase().trim()];
  if (!entry || entry.password !== password) return null;
  if (typeof document !== "undefined") {
    document.cookie = `${COOKIE}=${encodeURIComponent(JSON.stringify(entry.user))}; path=/; max-age=86400`;
  }
  return entry.user;
}

export function logout() {
  if (typeof document !== "undefined") {
    document.cookie = `${COOKIE}=; path=/; max-age=0`;
  }
}

export function getSession(): SessionUser | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.split("; ").find(c => c.startsWith(`${COOKIE}=`));
  if (!match) return null;
  try {
    return JSON.parse(decodeURIComponent(match.split("=")[1]));
  } catch {
    return null;
  }
}

export function isOnboarded(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(ONBOARDED_KEY) === "true";
}

export function markOnboarded() {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(ONBOARDED_KEY, "true");
}

export function resetOnboarding() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(ONBOARDED_KEY);
}
