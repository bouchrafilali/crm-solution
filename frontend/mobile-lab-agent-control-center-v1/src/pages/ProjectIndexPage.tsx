import { motion } from "framer-motion";
import { useMemo, useState } from "react";
import { SectionHeader } from "../components/SectionHeader.js";
import { OrientationCard } from "../components/control-center/OrientationCard.js";
import { ModuleCard } from "../components/control-center/ModuleCard.js";

interface ProjectIndexPageProps {
  onOpenPage: (page: "dashboard" | "leads" | "runs") => void;
}

interface ModuleDefinition {
  id: string;
  title: string;
  subtitle: string;
  description: string;
  features: string[];
  status: "active" | "in_progress";
  ctaLabel: string;
  onOpen?: () => void;
}

export function ProjectIndexPage({ onOpenPage }: ProjectIndexPageProps) {
  const [query, setQuery] = useState("");

  const modules = useMemo<ModuleDefinition[]>(
    () => [
      {
        id: "forecast",
        title: "Forecast",
        subtitle: "Revenue, demand, and operational projections",
        description:
          "Access forecasting models, scenario views, and forward-looking signals to guide business decisions with clarity.",
        features: ["Revenue Forecast", "Order Projection", "Demand Signals", "Scenario View"],
        status: "active",
        ctaLabel: "Open Forecast"
      },
      {
        id: "insights",
        title: "Insights",
        subtitle: "Business intelligence and actionable analysis",
        description:
          "Surface the most important patterns across performance, client behavior, and operational efficiency.",
        features: ["Executive Overview", "Conversion Insights", "Lead Intelligence", "Performance Signals"],
        status: "active",
        ctaLabel: "Open Insights",
        onOpen: () => onOpenPage("dashboard")
      },
      {
        id: "mobile-app",
        title: "Mobile App",
        subtitle: "Operational experience for fast daily execution",
        description:
          "A clear mobile-first workspace for conversations, approvals, and rapid action across ongoing activity.",
        features: ["Conversations", "Approvals", "Operator Actions", "AI Suggestions"],
        status: "in_progress",
        ctaLabel: "Open Mobile App",
        onOpen: () => onOpenPage("leads")
      },
      {
        id: "whatsapp-intelligence",
        title: "WhatsApp Intelligence",
        subtitle: "Conversation analysis and operator guidance",
        description:
          "Review conversations, priorities, and reply suggestions in a structure designed for speed and control.",
        features: ["Priority Feed", "Suggested Replies", "Stage Detection", "Learning Loop"],
        status: "active",
        ctaLabel: "Open WhatsApp Intelligence",
        onOpen: () => {
          if (typeof window !== "undefined") window.location.href = "/whatsapp-intelligence/mobile-lab";
        }
      },
      {
        id: "orders-payments",
        title: "Orders & Payments",
        subtitle: "Commercial flow and payment visibility",
        description:
          "Track orders, deposits, balances, and payment progression with a more executive operational view.",
        features: ["Orders", "Deposits", "Balances", "Payment Status"],
        status: "active",
        ctaLabel: "Open Orders & Payments",
        onOpen: () => onOpenPage("runs")
      },
      {
        id: "appointments",
        title: "Appointments",
        subtitle: "Showroom and client scheduling",
        description:
          "Manage showroom visits, fitting flow, confirmations, and related operational coordination.",
        features: ["Rendez-vous", "Showroom Flow", "Reminders", "Availability"],
        status: "active",
        ctaLabel: "Open Appointments"
      }
    ],
    [onOpenPage]
  );

  const filteredModules = useMemo(() => {
    const source = query.trim().toLowerCase();
    if (!source) return modules;
    return modules.filter((item) => {
      const haystack = `${item.title} ${item.subtitle} ${item.description} ${item.features.join(" ")}`.toLowerCase();
      return haystack.includes(source);
    });
  }, [modules, query]);

  return (
    <motion.div key="project-index" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="grid gap-4 xl:grid-cols-[1.45fr_0.8fr]">
        <section className="ml-panel rounded-2xl p-5">
          <SectionHeader
            title="Central index for all project areas"
            subtitle="Structured entry point for every major module, designed to reduce confusion and make navigation immediate."
          />
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-cyan-300">Project Control Center</p>
        </section>

        <aside className="ml-panel rounded-2xl p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">Overview</p>
          <div className="mt-3 grid grid-cols-3 gap-2 text-center">
            <div className="ml-panel-soft rounded-xl px-2 py-3">
              <p className="text-xl font-semibold text-slate-100">6</p>
              <p className="mt-1 text-[10px] uppercase tracking-[0.1em] text-slate-500">Modules</p>
            </div>
            <div className="ml-panel-soft rounded-xl px-2 py-3">
              <p className="text-xl font-semibold text-emerald-200">Structured</p>
              <p className="mt-1 text-[10px] uppercase tracking-[0.1em] text-slate-500">State</p>
            </div>
            <div className="ml-panel-soft rounded-xl px-2 py-3">
              <p className="text-xl font-semibold text-slate-100">Center</p>
              <p className="mt-1 text-[10px] uppercase tracking-[0.1em] text-slate-500">Mode</p>
            </div>
          </div>
        </aside>
      </div>

      <section className="mt-5">
        <SectionHeader
          title="Quick Orientation"
          subtitle="Use this pathing layer to choose the most useful starting point before entering the full module grid."
        />
        <div className="grid gap-3 md:grid-cols-3">
          <OrientationCard
            label="Recommended Start"
            value="Insights"
            description="Best place to understand the business situation and what needs attention first."
          />
          <OrientationCard
            label="Decision Area"
            value="Forecast"
            description="Use for projections, planning, expected revenue, and scenario thinking."
          />
          <OrientationCard
            label="Execution Area"
            value="Mobile App"
            description="Use for action, operator activity, approvals, and daily execution."
          />
        </div>
      </section>

      <section className="mt-5">
        <div className="ml-panel mb-4 flex flex-wrap items-center gap-3 rounded-2xl p-3.5">
          <SectionHeader
            title="Main Modules"
            subtitle="All major project areas in one coherent, executive-grade index."
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search modules"
            className="ml-panel-soft ml-auto min-w-56 rounded-xl px-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 outline-none"
          />
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filteredModules.map((module) => (
            <ModuleCard
              key={module.id}
              title={module.title}
              subtitle={module.subtitle}
              description={module.description}
              features={module.features}
              status={module.status}
              ctaLabel={module.ctaLabel}
              onOpen={module.onOpen}
            />
          ))}
        </div>
      </section>
    </motion.div>
  );
}
