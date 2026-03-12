import { motion } from "framer-motion";

interface OrientationCardProps {
  label: string;
  value: string;
  description: string;
}

export function OrientationCard({ label, value, description }: OrientationCardProps) {
  return (
    <motion.article
      whileHover={{ y: -3 }}
      transition={{ duration: 0.2 }}
      className="ml-panel ml-interactive rounded-2xl p-4"
    >
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">{label}</p>
      <p className="mt-2 text-lg font-semibold tracking-tight text-slate-100">{value}</p>
      <p className="mt-2 text-sm leading-relaxed text-slate-400">{description}</p>
    </motion.article>
  );
}
