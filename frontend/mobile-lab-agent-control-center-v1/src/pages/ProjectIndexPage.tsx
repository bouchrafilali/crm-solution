import { motion } from "framer-motion";
import { useMemo, useState } from "react";
import { HeroSection } from "../components/control-center/HeroSection.js";
import { ModuleCard } from "../components/control-center/ModuleCard.js";
import { OrientationCard } from "../components/control-center/OrientationCard.js";
import { SearchBar } from "../components/control-center/SearchBar.js";

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
        ctaLabel: "Open Forecast",
        onOpen: () => {
          if (typeof window !== "undefined") window.location.href = "/admin/forecast-v4";
        }
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
        onOpen: () => {
          if (typeof window !== "undefined") window.location.href = "/admin/insights";
        }
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
        onOpen: () => {
          if (typeof window !== "undefined") window.location.href = "/admin";
        }
      },
      {
        id: "appointments",
        title: "Appointments",
        subtitle: "Showroom and client scheduling",
        description:
          "Manage showroom visits, fitting flow, confirmations, and related operational coordination.",
        features: ["Rendez-vous", "Showroom Flow", "Reminders", "Availability"],
        status: "active",
        ctaLabel: "Open Appointments",
        onOpen: () => {
          if (typeof window !== "undefined") window.location.href = "/admin/appointments-v2";
        }
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
    <motion.div
      key="project-index"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.26, ease: "easeOut" }}
      className="space-y-6 pb-4"
    >
      <HeroSection moduleCount={modules.length} />

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-slate-400">Quick Orientation</h2>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <OrientationCard
            label="Recommended Start"
            value="Insights"
            description="Best place to understand the business situation and what needs attention first."
            onClick={() => {
              if (typeof window !== "undefined") window.location.href = "/admin/insights";
            }}
          />
          <OrientationCard
            label="Decision Area"
            value="Forecast"
            description="Use for projections, planning, expected revenue, and scenario thinking."
            onClick={() => {
              if (typeof window !== "undefined") window.location.href = "/admin/forecast-v4";
            }}
          />
          <OrientationCard
            label="Execution Area"
            value="Mobile App"
            description="Use for action, operator activity, approvals, and daily execution."
            onClick={() => onOpenPage("leads")}
          />
        </div>
      </section>

      <section className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <p className="text-sm font-semibold tracking-tight text-slate-100">Modules Overview</p>
            <p className="mt-1 text-xs text-slate-400">Select a module to continue. Designed for fast, low-friction entry.</p>
          </div>
          <SearchBar value={query} onChange={setQuery} placeholder="Search modules, features, or purpose" />
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
