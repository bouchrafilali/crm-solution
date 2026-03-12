import { motion } from "framer-motion";

interface OrientationCardProps {
  label: string;
  value: string;
  description: string;
  onClick?: () => void;
}

export function OrientationCard({ label, value, description, onClick }: OrientationCardProps) {
  return (
    <motion.article
      whileHover={{ y: -2, scale: 1.005 }}
      transition={{ duration: 0.22, ease: "easeOut" }}
      className="group relative overflow-hidden rounded-3xl border border-white/10 bg-white/[0.04] p-4 backdrop-blur-xl"
    >
      <div className="absolute inset-0 bg-gradient-to-br from-white/[0.08] via-transparent to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
      <p className="relative text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">{label}</p>
      <p className="relative mt-2 text-base font-semibold tracking-tight text-slate-100">{value}</p>
      <p className="relative mt-2 text-sm leading-relaxed text-slate-300">{description}</p>
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          className="relative mt-3 inline-flex rounded-full border border-white/15 bg-white/[0.04] px-3 py-1.5 text-[11px] font-semibold text-slate-200 transition hover:border-cyan-300/45 hover:text-cyan-100"
        >
          Open
        </button>
      ) : null}
    </motion.article>
  );
}
