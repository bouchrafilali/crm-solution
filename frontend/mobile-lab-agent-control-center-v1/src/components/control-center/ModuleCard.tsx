import { motion } from "framer-motion";
import { StatusBadge } from "../StatusBadge.js";

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
      whileHover={{ y: -4 }}
      transition={{ duration: 0.2 }}
      className="ml-panel ml-interactive flex h-full flex-col rounded-2xl p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold tracking-tight text-slate-100">{title}</h3>
          <p className="mt-1 text-xs text-slate-500">{subtitle}</p>
        </div>
        <StatusBadge value={status === "active" ? "success" : "pending"} />
      </div>

      <p className="mt-3 text-sm leading-relaxed text-slate-300">{description}</p>

      <ul className="mt-4 grid gap-2 text-xs text-slate-300">
        {features.map((feature) => (
          <li key={feature} className="ml-panel-soft rounded-lg px-2.5 py-2">
            {feature}
          </li>
        ))}
      </ul>

      <div className="mt-auto pt-4">
        <button
          type="button"
          onClick={onOpen}
          className="ml-button ml-button-primary w-full rounded-xl px-3 py-2 text-xs font-semibold"
        >
          {ctaLabel}
        </button>
      </div>
    </motion.article>
  );
}
