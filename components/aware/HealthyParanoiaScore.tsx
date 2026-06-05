type Props = {
  score: number; // 0..100
  size?: "sm" | "lg";
};

export function HealthyParanoiaScore({ score, size = "lg" }: Props) {
  const tone =
    score >= 75 ? "text-accent" : score >= 50 ? "text-warn" : "text-danger";
  const numCls = size === "lg" ? "text-[44px]" : "text-[24px]";
  const labelCls = size === "lg" ? "text-[11px]" : "text-[10px]";

  return (
    <div className="flex items-baseline gap-2">
      <span className={`${numCls} font-bold tracking-tight ${tone} leading-none`}>
        {score}
      </span>
      <span className={`text-muted ${labelCls} font-semibold uppercase tracking-wider`}>
        / 100
      </span>
    </div>
  );
}
