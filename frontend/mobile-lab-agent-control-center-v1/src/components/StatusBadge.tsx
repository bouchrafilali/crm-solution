import { cn } from "../utils.js";

interface StatusBadgeProps {
  value: string;
  className?: string;
}

const palette: Record<string, string> = {
  running: "border-emerald-400/40 bg-emerald-500/12 text-emerald-200",
  idle: "border-zinc-500/40 bg-zinc-500/12 text-zinc-200",
  degraded: "border-amber-400/40 bg-amber-500/12 text-amber-200",
  paused: "border-slate-400/40 bg-slate-500/12 text-slate-200",
  success: "border-emerald-400/40 bg-emerald-500/12 text-emerald-200",
  waiting_human_input: "border-sky-400/40 bg-sky-500/12 text-sky-200",
  waiting_human_approval: "border-cyan-400/40 bg-cyan-500/12 text-cyan-200",
  blocked: "border-amber-400/40 bg-amber-500/12 text-amber-200",
  error: "border-rose-400/40 bg-rose-500/12 text-rose-200",
  skipped: "border-zinc-500/40 bg-zinc-500/12 text-zinc-200",
  pending: "border-amber-400/40 bg-amber-500/12 text-amber-200",
  approved: "border-emerald-400/40 bg-emerald-500/12 text-emerald-200",
  rejected: "border-rose-400/40 bg-rose-500/12 text-rose-200",
  high: "border-rose-400/40 bg-rose-500/12 text-rose-200",
  medium: "border-amber-400/40 bg-amber-500/12 text-amber-200",
  low: "border-zinc-500/40 bg-zinc-500/12 text-zinc-300"
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
        "inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium tracking-wide",
        palette[value] ?? "border-zinc-600/40 bg-zinc-800/60 text-zinc-200",
        className
      )}
    >
      {toLabel(value)}
    </span>
  );
}
