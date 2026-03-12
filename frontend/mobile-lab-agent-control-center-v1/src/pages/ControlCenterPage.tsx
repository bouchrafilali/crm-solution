import { motion } from "framer-motion";
import { useMemo, useState } from "react";
import { ModuleSection, ModuleSectionData } from "../components/control-center/ModuleSection.js";
import { SearchBar } from "../components/control-center/SearchBar.js";

interface ControlCenterPageProps {
  onOpenPage: (page: "dashboard" | "leads" | "runs") => void;
}

export function ControlCenterPage({ onOpenPage }: ControlCenterPageProps) {
  const [query, setQuery] = useState("");

  const sections = useMemo<ModuleSectionData[]>(
    () => [
      {
        id: "operations",
        label: "Operations",
        items: [
          {
            id: "agent-control-center",
            icon: "agent",
            title: "Agent Control Center",
            subtitle: "Operational command surface for runs, approvals, and lead execution.",
            status: "active",
            onOpen: () => onOpenPage("dashboard")
          },
          {
            id: "mobile-app",
            icon: "mobile",
            title: "Mobile App",
            subtitle: "Fast operator workflow for conversations and daily actions.",
            status: "in_progress",
            onOpen: () => {
              if (typeof window !== "undefined") window.location.href = "/whatsapp-intelligence/mobile-lab";
            }
          }
        ]
      },
      {
        id: "intelligence",
        label: "Intelligence",
        items: [
          {
            id: "insights",
            icon: "insights",
            title: "Insights",
            subtitle: "Business intelligence and actionable analysis.",
            status: "active",
            onOpen: () => {
              if (typeof window !== "undefined") window.location.href = "/admin/insights";
            }
          },
          {
            id: "forecast",
            icon: "forecast",
            title: "Forecast",
            subtitle: "Revenue, demand, and operational projections.",
            status: "active",
            onOpen: () => {
              if (typeof window !== "undefined") window.location.href = "/admin/forecast-v4";
            }
          },
          {
            id: "whatsapp-intelligence",
            icon: "whatsapp",
            title: "WhatsApp Intelligence",
            subtitle: "Conversation analysis and operator guidance.",
            status: "active",
            onOpen: () => {
              if (typeof window !== "undefined") window.location.href = "/whatsapp-intelligence";
            }
          }
        ]
      },
      {
        id: "business",
        label: "Business",
        items: [
          {
            id: "orders-payments",
            icon: "orders",
            title: "Orders & Payments",
            subtitle: "Commercial flow tracking with payment visibility.",
            status: "active",
            onOpen: () => {
              if (typeof window !== "undefined") window.location.href = "/admin/invoices";
            }
          },
          {
            id: "appointments",
            icon: "appointments",
            title: "Appointments",
            subtitle: "Showroom scheduling and confirmation coordination.",
            status: "active",
            onOpen: () => {
              if (typeof window !== "undefined") window.location.href = "/admin/appointments-v2";
            }
          }
        ]
      }
    ],
    [onOpenPage]
  );

  const filteredSections = useMemo(() => {
    const source = query.trim().toLowerCase();
    if (!source) return sections;
    return sections
      .map((section) => ({
        ...section,
        items: section.items.filter((item) => `${item.title} ${item.subtitle}`.toLowerCase().includes(source))
      }))
      .filter((section) => section.items.length > 0);
  }, [query, sections]);

  return (
    <motion.div
      key="control-center-page"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.24, ease: "easeOut" }}
      className="space-y-5"
    >
      <section className="rounded-[28px] border border-white/12 bg-white/[0.045] p-5 backdrop-blur-2xl md:p-6">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-cyan-200">Project Control Center</p>
        <h1 className="mt-2 text-[34px] font-semibold tracking-tight text-slate-100 md:text-[40px]">
          Central index for all project areas
        </h1>
        <p className="mt-2 text-base text-slate-300">A simple, structured entry point to the platform.</p>
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <SearchBar value={query} onChange={setQuery} placeholder="Search modules" />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        {filteredSections.map((section) => (
          <ModuleSection key={section.id} section={section} />
        ))}
      </div>
    </motion.div>
  );
}
