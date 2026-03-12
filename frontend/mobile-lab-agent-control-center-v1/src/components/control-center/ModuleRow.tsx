import { motion } from "framer-motion";
import {
  Brain,
  Calendar,
  ChevronRight,
  Cpu,
  FileText,
  Layers,
  LineChart,
  MessageCircle,
  Smartphone,
  Wallet
} from "lucide-react";
import { StatusBadge } from "./StatusBadge.js";

export interface ModuleRowItem {
  id: string;
  title: string;
  subtitle: string;
  status: "active" | "in_progress";
  icon: "agent" | "mobile" | "insights" | "forecast" | "whatsapp" | "blueprint" | "invoice" | "orders" | "appointments";
  onOpen?: () => void;
}

function ModuleIcon({ kind }: { kind: ModuleRowItem["icon"] }) {
  const props = { className: "h-[18px] w-[18px]", strokeWidth: 1.8 };
  if (kind === "agent") return <Cpu {...props} />;
  if (kind === "mobile") return <Smartphone {...props} />;
  if (kind === "insights") return <Brain {...props} />;
  if (kind === "forecast") return <LineChart {...props} />;
  if (kind === "whatsapp") return <MessageCircle {...props} />;
  if (kind === "blueprint") return <Layers {...props} />;
  if (kind === "invoice") return <FileText {...props} />;
  if (kind === "orders") return <Wallet {...props} />;
  return <Calendar {...props} />;
}

export function ModuleRow({ item }: { item: ModuleRowItem }) {
  return (
    <motion.button
      type="button"
      whileHover={{ y: -1.5 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      onClick={item.onOpen}
      className="group flex min-h-[80px] w-full items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.035] px-4 py-3.5 text-left backdrop-blur-xl transition hover:border-cyan-200/30 hover:bg-white/[0.06]"
    >
      <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-white/12 bg-white/[0.04] text-slate-200">
        <ModuleIcon kind={item.icon} />
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-[17px] font-semibold tracking-tight text-slate-100">{item.title}</span>
        <span className="mt-0.5 block text-sm text-slate-400">{item.subtitle}</span>
      </span>

      <StatusBadge status={item.status} />
      <ChevronRight className="ml-0.5 h-4 w-4 text-slate-500 transition duration-200 group-hover:translate-x-0.5 group-hover:text-cyan-200" />
    </motion.button>
  );
}
