type Props = {
  avatar?: string;
  authorName: string;
  authorRole?: string;
  time: string;
  children: React.ReactNode;
};

export function SlackMessage({
  avatar = "DR",
  authorName,
  authorRole,
  time,
  children,
}: Props) {
  return (
    <div className="flex gap-3 items-start">
      <div className="w-9 h-9 rounded-md bg-accent flex items-center justify-center text-white font-bold text-[12px] tracking-tight shrink-0">
        {avatar}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-[14px] font-bold text-ink">{authorName}</span>
          {authorRole && (
            <span className="text-[10px] uppercase tracking-wider font-bold text-muted bg-bg border border-line rounded px-1 py-0.5">
              {authorRole}
            </span>
          )}
          <span className="text-[11px] text-muted">{time}</span>
        </div>
        <div className="mt-1.5 text-[14px] text-ink leading-relaxed">
          {children}
        </div>
      </div>
    </div>
  );
}
