import { motion } from "framer-motion";
import { SystemBrainKpi } from "../../system-brain-types.js";

const toneMap: Record<SystemBrainKpi["tone"], string> = {
  neutral: "text-slate-300",
  good: "text-emerald-300",
  attention: "text-amber-300"
};

export function BrainKpiCard({ item }: { item: SystemBrainKpi }) {
  return (
    <motion.article
      layout
      whileHover={{ y: -2 }}
      transition={{ duration: 0.18 }}
      className="ml-panel ml-interactive rounded-2xl p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">{item.label}</p>
        <span className="h-1.5 w-1.5 rounded-full bg-slate-600" />
      </div>
      <p className="mt-3 text-[1.5rem] font-semibold tracking-tight text-slate-50">{item.value}</p>
      <p className={`mt-1 text-xs ${toneMap[item.tone]}`}>{item.delta}</p>
    </motion.article>
  );
}
