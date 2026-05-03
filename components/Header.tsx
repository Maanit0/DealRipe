"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { SessionUser, logout, resetOnboarding } from "@/lib/auth";

export default function Header({ user }: { user: SessionUser | null }) {
  const router = useRouter();

  function handleLogout() {
    logout();
    resetOnboarding();
    router.push("/login");
  }

  return (
    <header className="bg-navy text-white">
      <div className="max-w-[1200px] mx-auto px-6 h-14 flex items-center justify-between">
        <Link href="/dashboard" className="flex items-center gap-2 group">
          <div className="w-7 h-7 rounded-md bg-accent flex items-center justify-center text-navy font-black text-sm">
            D
          </div>
          <span className="font-semibold tracking-tight text-[15px]">DealRipe</span>
        </Link>
        {user && (
          <div className="flex items-center gap-4">
            <div className="text-right leading-tight">
              <div className="text-[13px] font-medium">{user.name}</div>
              <div className="text-[11px] text-white/60 uppercase tracking-wide">
                {user.role === "CRO" ? "Chief Revenue Officer" : "Account Executive"}
              </div>
            </div>
            <button
              onClick={handleLogout}
              className="text-[12px] text-white/60 hover:text-white transition"
            >
              Sign out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
