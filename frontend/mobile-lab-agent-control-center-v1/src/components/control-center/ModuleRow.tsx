import { motion } from "framer-motion";
import { StatusBadge } from "./StatusBadge.js";

export interface ModuleRowItem {
  id: string;
  title: string;
  subtitle: string;
  status: "active" | "in_progress";
  icon: "agent" | "mobile" | "insights" | "forecast" | "whatsapp" | "orders" | "appointments";
  onOpen?: () => void;
}

function ModuleIcon({ kind }: { kind: ModuleRowItem["icon"] }) {
  const stroke = "currentColor";
  const cls = "h-[18px] w-[18px]";
  if (kind === "agent") {
    return (
      <svg viewBox="0 0 24 24" className={cls} fill="none" aria-hidden>
        <path d="M8 10V7a4 4 0 1 1 8 0v3" stroke={stroke} strokeWidth="1.8" strokeLinecap="round" />
        <rect x="4.5" y="10" width="15" height="10" rx="3" stroke={stroke} strokeWidth="1.8" />
      </svg>
    );
  }
  if (kind === "mobile") {
    return (
      <svg viewBox="0 0 24 24" className={cls} fill="none" aria-hidden>
        <rect x="7" y="3.5" width="10" height="17" rx="2.6" stroke={stroke} strokeWidth="1.8" />
        <path d="M10 6.6h4" stroke={stroke} strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }
  if (kind === "insights") {
    return (
      <svg viewBox="0 0 24 24" className={cls} fill="none" aria-hidden>
        <path d="M4.8 15.2 9.2 10l3.7 3.3 6.3-7.1" stroke={stroke} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M4.8 19h14.4" stroke={stroke} strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }
  if (kind === "forecast") {
    return (
      <svg viewBox="0 0 24 24" className={cls} fill="none" aria-hidden>
        <path d="M4.5 18.5h15" stroke={stroke} strokeWidth="1.8" strokeLinecap="round" />
        <path d="M7.5 15.5 12 9.5l2.8 3 3.2-4" stroke={stroke} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (kind === "whatsapp") {
    return (
      <svg viewBox="0 0 24 24" className={cls} fill="none" aria-hidden>
        <path d="M6 18.4 6.8 15A7.8 7.8 0 1 1 12 19.8a7.7 7.7 0 0 1-3.5-.8L6 18.4Z" stroke={stroke} strokeWidth="1.8" strokeLinejoin="round" />
      </svg>
    );
  }
  if (kind === "orders") {
    return (
      <svg viewBox="0 0 24 24" className={cls} fill="none" aria-hidden>
        <path d="M4.5 7.5h15v11h-15z" stroke={stroke} strokeWidth="1.8" />
        <path d="M9 12h6" stroke={stroke} strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className={cls} fill="none" aria-hidden>
      <path d="M6 8.5h12M6 12h12M6 15.5h8" stroke={stroke} strokeWidth="1.8" strokeLinecap="round" />
      <rect x="4.5" y="4.5" width="15" height="15" rx="3" stroke={stroke} strokeWidth="1.8" />
    </svg>
  );
}

export function ModuleRow({ item }: { item: ModuleRowItem }) {
  return (
    <motion.button
      type="button"
      whileHover={{ y: -1 }}
      transition={{ duration: 0.2 }}
      onClick={item.onOpen}
      className="group flex w-full items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.035] px-3.5 py-3 text-left backdrop-blur-xl transition hover:border-white/20 hover:bg-white/[0.055]"
    >
      <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/12 bg-white/[0.04] text-slate-200">
        <ModuleIcon kind={item.icon} />
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-[17px] font-semibold tracking-tight text-slate-100">{item.title}</span>
        <span className="mt-0.5 block truncate text-sm text-slate-400">{item.subtitle}</span>
      </span>

      <StatusBadge status={item.status} />
      <span className="ml-1 text-slate-500 transition group-hover:text-cyan-200">›</span>
    </motion.button>
  );
}
