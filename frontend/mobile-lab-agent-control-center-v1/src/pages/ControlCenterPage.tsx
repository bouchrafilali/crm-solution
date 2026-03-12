import { motion } from "framer-motion";
import { useMemo, useState } from "react";
import { HeaderSection } from "../components/control-center/HeaderSection.js";
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
        label: "OPERATIONS",
        items: [
          {
            id: "agent-control-center",
            icon: "agent",
            title: "Agent Control Center V1",
            subtitle: "AI operations cockpit for runs, validations, leads and system supervision.",
            status: "active",
            onOpen: () => onOpenPage("dashboard")
          },
          {
            id: "mobile-app",
            icon: "mobile",
            title: "Mobile App",
            subtitle: "Operational workspace for fast execution and operator workflows.",
            status: "in_progress",
            onOpen: () => {
              if (typeof window !== "undefined") window.location.href = "/whatsapp-intelligence/mobile-lab";
            }
          }
        ]
      },
      {
        id: "intelligence",
        label: "INTELLIGENCE",
        items: [
          {
            id: "insights",
            icon: "insights",
            title: "Insights",
            subtitle: "Business intelligence and analytics for strategic signals.",
            status: "active",
            onOpen: () => {
              if (typeof window !== "undefined") window.location.href = "/admin/insights";
            }
          },
          {
            id: "forecast",
            icon: "forecast",
            title: "Forecast",
            subtitle: "Revenue, demand and operational projections.",
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
          },
          {
            id: "blueprint",
            icon: "blueprint",
            title: "Blueprint",
            subtitle: "System architecture view and application flow mapping.",
            status: "active",
            onOpen: () => {
              if (typeof window !== "undefined") window.location.href = "/blueprint";
            }
          }
        ]
      },
      {
        id: "business",
        label: "BUSINESS",
        items: [
          {
            id: "create-invoice",
            icon: "invoice",
            title: "Create Invoice",
            subtitle: "Direct access to invoice generator and PDF preview.",
            status: "active",
            onOpen: () => {
              if (typeof window !== "undefined") window.location.href = "/admin/invoices";
            }
          },
          {
            id: "orders-payments",
            icon: "orders",
            title: "Orders & Payments",
            subtitle: "Visibility on orders, deposits, balances and payment status.",
            status: "active",
            onOpen: () => {
              if (typeof window !== "undefined") window.location.href = "/admin/invoices";
            }
          },
          {
            id: "appointments",
            icon: "appointments",
            title: "Appointments",
            subtitle: "Showroom scheduling, confirmations and reminders.",
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
      className="mx-auto w-full max-w-4xl space-y-5"
    >
      <HeaderSection />

      <div className="flex flex-wrap items-center gap-3">
        <SearchBar value={query} onChange={setQuery} placeholder="Search modules..." />
      </div>

      <div className="space-y-3">
        {filteredSections.map((section) => (
          <ModuleSection key={section.id} section={section} />
        ))}
      </div>
    </motion.div>
  );
}
