import Link from "next/link";
import { ProgressIndicator } from "./ProgressIndicator";

type Props = {
  step: 1 | 2 | 3 | 4;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
};

export function OnboardingShell({
  step,
  title,
  subtitle,
  children,
  footer,
}: Props) {
  return (
    <div className="min-h-screen bg-bg font-sans text-ink antialiased flex flex-col">
      <header className="border-b border-line bg-white">
        <div className="max-w-[1080px] mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/" className="text-[14px] font-semibold tracking-tight text-ink hover:opacity-80 transition">
            DealRipe
          </Link>
          <Link
            href="/pipeline"
            className="text-[12px] font-semibold text-muted hover:text-ink transition"
          >
            Skip to demo
          </Link>
        </div>
      </header>

      <main className="flex-1 max-w-[1080px] w-full mx-auto px-6 py-10">
        <ProgressIndicator step={step} />
        <div className="mt-10">
          <h1 className="text-[28px] sm:text-[32px] font-semibold tracking-tight text-ink leading-tight">
            {title}
          </h1>
          {subtitle && (
            <p className="mt-3 text-[15px] text-muted leading-relaxed max-w-[680px]">
              {subtitle}
            </p>
          )}
          <div className="mt-10">{children}</div>
        </div>
      </main>

      {footer && (
        <footer className="border-t border-line bg-white">
          <div className="max-w-[1080px] mx-auto px-6 py-5 flex items-center justify-end gap-3">
            {footer}
          </div>
        </footer>
      )}
    </div>
  );
}
