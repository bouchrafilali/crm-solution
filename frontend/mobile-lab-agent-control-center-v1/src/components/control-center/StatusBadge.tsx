interface StatusBadgeProps {
  status: "active" | "in_progress";
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const label = status === "active" ? "Active" : "In Progress";
  const tone =
    status === "active"
      ? "border-emerald-300/25 bg-emerald-500/10 text-emerald-100"
      : "border-amber-300/25 bg-amber-500/10 text-amber-100";
  return (
    <span
      className={`inline-flex rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.11em] ${tone}`}
    >
      {label}
    </span>
  );
}
