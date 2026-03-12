import { motion } from "framer-motion";

interface ModuleCardProps {
  title: string;
  subtitle: string;
  description: string;
  features: string[];
  status: "active" | "in_progress";
  ctaLabel: string;
  onOpen?: () => void;
}

export function ModuleCard({
  title,
  subtitle,
  description,
  features,
  status,
  ctaLabel,
  onOpen
}: ModuleCardProps) {
  return (
    <motion.article
      whileHover={{ y: -3 }}
      transition={{ duration: 0.24, ease: "easeOut" }}
      className="group relative flex h-full flex-col overflow-hidden rounded-[26px] border border-white/12 bg-white/[0.045] p-5 backdrop-blur-2xl"
    >
      <div className="pointer-events-none absolute -right-16 -top-16 h-32 w-32 rounded-full bg-cyan-400/10 blur-3xl opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-xl font-semibold tracking-tight text-slate-100">{title}</h3>
          <p className="mt-1.5 text-xs text-slate-400">{subtitle}</p>
        </div>
        <span
          className={[
            "inline-flex rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.11em]",
            status === "active"
              ? "border-emerald-300/25 bg-emerald-500/12 text-emerald-100"
              : "border-amber-300/25 bg-amber-500/12 text-amber-100"
          ].join(" ")}
        >
          {status === "active" ? "Active" : "In Progress"}
        </span>
      </div>

      <p className="mt-3 text-sm leading-relaxed text-slate-300">{description}</p>

      <ul className="mt-4 grid grid-cols-2 gap-2 text-xs text-slate-300">
        {features.map((feature) => (
          <li key={feature} className="rounded-xl border border-white/8 bg-white/[0.03] px-2.5 py-2">
            {feature}
          </li>
        ))}
      </ul>

      <div className="mt-auto pt-4">
        <button
          type="button"
          onClick={onOpen}
          className="w-full rounded-xl border border-white/15 bg-white/[0.06] px-3 py-2 text-xs font-semibold text-slate-100 transition hover:border-cyan-300/45 hover:bg-cyan-400/10"
        >
          {ctaLabel}
        </button>
      </div>
    </motion.article>
  );
}
