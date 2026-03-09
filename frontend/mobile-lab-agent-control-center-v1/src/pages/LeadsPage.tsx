import { motion } from "framer-motion";
import { useMemo, useState } from "react";
import { Lead } from "../types.js";
import { FilterBar, FilterField } from "../components/FilterBar.js";
import { LeadTable } from "../components/LeadTable.js";
import { SectionHeader } from "../components/SectionHeader.js";

interface LeadsPageProps {
  leads: Lead[];
  onOpenLead: (leadId: string) => void;
}

interface LeadsFilters {
  stage: string;
  country: string;
  language: string;
  priority: string;
  paymentIntent: string;
  highValue: string;
  waitingReply: string;
  eventSoon: string;
  sort: string;
}

export function LeadsPage({ leads, onOpenLead }: LeadsPageProps) {
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<LeadsFilters>({
    stage: "all",
    country: "all",
    language: "all",
    priority: "all",
    paymentIntent: "all",
    highValue: "all",
    waitingReply: "all",
    eventSoon: "all",
    sort: "highest_priority"
  });

  const fields: FilterField[] = [
    {
      id: "stage",
      label: "Stage",
      value: filters.stage,
      options: [
        { label: "All", value: "all" },
        ...Array.from(new Set(leads.map((lead) => lead.currentStage))).map((stage) => ({ label: stage, value: stage }))
      ]
    },
    {
      id: "country",
      label: "Country",
      value: filters.country,
      options: [
        { label: "All", value: "all" },
        ...Array.from(new Set(leads.map((lead) => lead.country))).map((country) => ({ label: country, value: country }))
      ]
    },
    {
      id: "language",
      label: "Language",
      value: filters.language,
      options: [
        { label: "All", value: "all" },
        ...Array.from(new Set(leads.map((lead) => lead.language))).map((language) => ({ label: language, value: language }))
      ]
    },
    {
      id: "priority",
      label: "Priority",
      value: filters.priority,
      options: [
        { label: "All", value: "all" },
        { label: "High", value: "high" },
        { label: "Medium", value: "medium" },
        { label: "Low", value: "low" }
      ]
    },
    {
      id: "paymentIntent",
      label: "Payment Intent",
      value: filters.paymentIntent,
      options: [
        { label: "All", value: "all" },
        { label: "High", value: "high" },
        { label: "Medium", value: "medium" },
        { label: "Low", value: "low" }
      ]
    },
    {
      id: "highValue",
      label: "High Value",
      value: filters.highValue,
      options: [
        { label: "All", value: "all" },
        { label: "Yes", value: "yes" },
        { label: "No", value: "no" }
      ]
    },
    {
      id: "waitingReply",
      label: "Waiting Reply",
      value: filters.waitingReply,
      options: [
        { label: "All", value: "all" },
        { label: "Yes", value: "yes" },
        { label: "No", value: "no" }
      ]
    },
    {
      id: "eventSoon",
      label: "Event Soon",
      value: filters.eventSoon,
      options: [
        { label: "All", value: "all" },
        { label: "Within 60 days", value: "yes" },
        { label: "Later", value: "no" }
      ]
    },
    {
      id: "sort",
      label: "Sort",
      value: filters.sort,
      options: [
        { label: "Highest Priority", value: "highest_priority" },
        { label: "Closest Event Date", value: "closest_event" },
        { label: "Highest Estimated Value", value: "highest_value" },
        { label: "Oldest Unanswered", value: "oldest_unanswered" }
      ]
    }
  ];

  const filteredLeads = useMemo(() => {
    const now = new Date("2026-03-09T00:00:00Z");

    const result = leads.filter((lead) => {
      if (filters.stage !== "all" && lead.currentStage !== filters.stage) return false;
      if (filters.country !== "all" && lead.country !== filters.country) return false;
      if (filters.language !== "all" && lead.language !== filters.language) return false;
      if (filters.priority !== "all") {
        const range = lead.priorityScore >= 85 ? "high" : lead.priorityScore >= 70 ? "medium" : "low";
        if (range !== filters.priority) return false;
      }
      if (filters.paymentIntent !== "all" && lead.paymentIntent !== filters.paymentIntent) return false;
      if (filters.highValue !== "all" && String(lead.highValue ? "yes" : "no") !== filters.highValue) return false;
      if (filters.waitingReply !== "all" && String(lead.waitingReply ? "yes" : "no") !== filters.waitingReply) return false;
      if (filters.eventSoon !== "all") {
        const days = Math.round((new Date(lead.eventDate).getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
        const isSoon = days <= 60;
        if (String(isSoon ? "yes" : "no") !== filters.eventSoon) return false;
      }
      if (query.trim()) {
        const source = `${lead.name} ${lead.nextBestAction} ${lead.lastMessage}`.toLowerCase();
        if (!source.includes(query.toLowerCase().trim())) return false;
      }
      return true;
    });

    const sorters: Record<string, (a: Lead, b: Lead) => number> = {
      highest_priority: (a, b) => b.priorityScore - a.priorityScore,
      closest_event: (a, b) => new Date(a.eventDate).getTime() - new Date(b.eventDate).getTime(),
      highest_value: (a, b) => b.estimatedValue - a.estimatedValue,
      oldest_unanswered: (a, b) => Number(b.waitingReply) - Number(a.waitingReply)
    };

    return result.sort(sorters[filters.sort] ?? sorters.highest_priority);
  }, [filters, leads, query]);

  return (
    <motion.div key="leads" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <SectionHeader title="Leads" subtitle="Portfolio-level view for AI-assisted WhatsApp lead management." />
      <FilterBar
        fields={fields}
        onChange={(id, value) => setFilters((prev) => ({ ...prev, [id]: value }))}
        query={query}
        onQueryChange={setQuery}
        queryPlaceholder="Search lead or recent message"
      />
      <LeadTable leads={filteredLeads} onOpenLead={onOpenLead} />
    </motion.div>
  );
}
