import { cn } from "../utils.js";

interface StatusBadgeProps {
  value: string;
  className?: string;
}

const palette: Record<string, string> = {
  running: "border-emerald-300/35 bg-emerald-500/12 text-emerald-100",
  idle: "border-slate-300/20 bg-slate-500/10 text-slate-200",
  degraded: "border-amber-300/35 bg-amber-500/14 text-amber-100",
  paused: "border-slate-300/26 bg-slate-500/12 text-slate-200",
  success: "border-emerald-300/35 bg-emerald-500/12 text-emerald-100",
  waiting_human_input: "border-sky-300/35 bg-sky-500/14 text-sky-100",
  waiting_human_approval: "border-cyan-300/35 bg-cyan-500/14 text-cyan-100",
  blocked: "border-amber-300/35 bg-amber-500/14 text-amber-100",
  error: "border-rose-300/35 bg-rose-500/14 text-rose-100",
  skipped: "border-slate-300/22 bg-slate-500/10 text-slate-200",
  pending: "border-amber-300/35 bg-amber-500/14 text-amber-100",
  approved: "border-emerald-300/35 bg-emerald-500/14 text-emerald-100",
  rejected: "border-rose-300/35 bg-rose-500/14 text-rose-100",
  high: "border-rose-300/35 bg-rose-500/14 text-rose-100",
  medium: "border-amber-300/35 bg-amber-500/14 text-amber-100",
  low: "border-slate-300/20 bg-slate-500/10 text-slate-200"
};

function toLabel(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function StatusBadge({ value, className }: StatusBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.11em]",
        palette[value] ?? "border-slate-300/25 bg-slate-700/30 text-slate-100",
        className
      )}
    >
      {toLabel(value)}
    </span>
  );
}
