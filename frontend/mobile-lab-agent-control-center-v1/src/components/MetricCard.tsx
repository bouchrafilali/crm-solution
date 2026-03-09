import { motion } from "framer-motion";

interface MetricCardProps {
  label: string;
  value: string | number;
  delta?: string;
  tone?: "neutral" | "good" | "attention";
}

const toneClasses: Record<NonNullable<MetricCardProps["tone"]>, string> = {
  neutral: "text-zinc-300",
  good: "text-emerald-300",
  attention: "text-amber-300"
};

export function MetricCard({ label, value, delta, tone = "neutral" }: MetricCardProps) {
  return (
    <motion.article
      layout
      whileHover={{ y: -2 }}
      transition={{ duration: 0.2 }}
      className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-4 shadow-[0_8px_24px_-14px_rgba(0,0,0,0.8)]"
    >
      <p className="text-[11px] uppercase tracking-[0.16em] text-zinc-500">{label}</p>
      <div className="mt-3 flex items-end justify-between gap-2">
        <p className="text-2xl font-semibold tracking-tight text-zinc-100">{value}</p>
        {delta ? <p className={`text-xs font-medium ${toneClasses[tone]}`}>{delta}</p> : null}
      </div>
    </motion.article>
  );
}
