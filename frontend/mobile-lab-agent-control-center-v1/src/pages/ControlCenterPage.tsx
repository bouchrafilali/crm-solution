import { motion } from "framer-motion";
import { useMemo, useState } from "react";
import { HeaderSection } from "../components/control-center/HeaderSection.js";
import { ModuleSection, ModuleSectionData } from "../components/control-center/ModuleSection.js";
import { SearchBar } from "../components/control-center/SearchBar.js";
import { DevelopmentSuggestionsPanel } from "../components/DevelopmentSuggestionsPanel.js";
import { AppMockData, NavPage } from "../types.js";

interface ControlCenterPageProps {
  onOpenPage: (page: NavPage) => void;
  data?: AppMockData;
}

export function ControlCenterPage({ onOpenPage, data }: ControlCenterPageProps) {
  const [query, setQuery] = useState("");
  const [mobileSection, setMobileSection] = useState<"operations" | "intelligence" | "business">("operations");
  const safeData: AppMockData = {
    agents: data?.agents ?? [],
    leads: data?.leads ?? [],
    runs: data?.runs ?? [],
    activityFeed: data?.activityFeed ?? [],
    approvals: data?.approvals ?? [],
    learningEvents: data?.learningEvents ?? [],
    suggestedReplies: data?.suggestedReplies ?? [],
    strategicAnalyses: data?.strategicAnalyses ?? [],
    conversations: data?.conversations ?? []
  };

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
            onOpen: () => onOpenPage("agent-control-center")
          },
          {
            id: "mobile-app",
            icon: "mobile",
            title: "Mobile App",
            subtitle: "Operational workspace for fast execution and operator workflows.",
            status: "in_progress",
            onOpen: () => onOpenPage("mobile-app")
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
            onOpen: () => onOpenPage("insights")
          },
          {
            id: "forecast",
            icon: "forecast",
            title: "Forecast",
            subtitle: "Revenue, demand and operational projections.",
            status: "active",
            onOpen: () => onOpenPage("forecast")
          },
          {
            id: "whatsapp-intelligence",
            icon: "whatsapp",
            title: "WhatsApp Intelligence",
            subtitle: "Conversation analysis and operator guidance.",
            status: "active",
            onOpen: () => onOpenPage("whatsapp-intelligence")
          },
          {
            id: "blueprint",
            icon: "blueprint",
            title: "Blueprint",
            subtitle: "System architecture view and application flow mapping.",
            status: "active",
            onOpen: () => onOpenPage("blueprint")
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
            onOpen: () => onOpenPage("create-invoice")
          },
          {
            id: "orders-payments",
            icon: "orders",
            title: "Orders & Payments",
            subtitle: "Visibility on orders, deposits, balances and payment status.",
            status: "active",
            onOpen: () => onOpenPage("orders-payments")
          },
          {
            id: "appointments",
            icon: "appointments",
            title: "Appointments",
            subtitle: "Showroom scheduling, confirmations and reminders.",
            status: "active",
            onOpen: () => onOpenPage("appointments")
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
  const mobileSections = useMemo(() => {
    if (query.trim()) return filteredSections;
    return filteredSections.filter((section) => section.id === mobileSection);
  }, [query, filteredSections, mobileSection]);

  return (
    <motion.div
      key="control-center-page"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.24, ease: "easeOut" }}
      className="mx-auto w-full max-w-4xl space-y-4 md:space-y-5"
    >
      <HeaderSection />

      <div className="flex flex-wrap items-center gap-3">
        <SearchBar value={query} onChange={setQuery} placeholder="Search modules..." />
      </div>

      <div className="md:hidden">
        <div className="grid grid-cols-3 gap-2 rounded-2xl border border-white/10 bg-white/[0.03] p-1">
          {[
            { id: "operations", label: "Operations" },
            { id: "intelligence", label: "Intelligence" },
            { id: "business", label: "Business" }
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setMobileSection(tab.id as "operations" | "intelligence" | "business")}
              className={`rounded-xl px-2 py-2 text-xs font-medium transition ${
                mobileSection === tab.id
                  ? "bg-cyan-400/15 text-cyan-100"
                  : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-3 md:hidden">
        {mobileSections.map((section) => (
          <ModuleSection key={section.id} section={section} />
        ))}
      </div>

      <div className="hidden space-y-3 md:block">
        {filteredSections.map((section) => (
          <ModuleSection key={section.id} section={section} />
        ))}
      </div>

      <DevelopmentSuggestionsPanel
        input={{
          runs: safeData.runs,
          agents: safeData.agents,
          approvals: safeData.approvals,
          learningEvents: safeData.learningEvents,
          strategicAnalyses: safeData.strategicAnalyses
        }}
      />
    </motion.div>
  );
}
