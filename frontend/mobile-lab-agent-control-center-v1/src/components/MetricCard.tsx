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
      transition={{ duration: 0.18 }}
      className="ml-panel ml-interactive rounded-2xl p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">{label}</p>
        <span className="h-1.5 w-1.5 rounded-full bg-slate-600" />
      </div>
      <div className="mt-4 flex items-end justify-between gap-2">
        <p className="text-[1.8rem] font-semibold tracking-tight text-slate-50">{value}</p>
        {delta ? <p className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${toneClasses[tone]}`}>{delta}</p> : null}
      </div>
    </motion.article>
  );
}
