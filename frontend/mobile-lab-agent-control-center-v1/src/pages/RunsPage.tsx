import { AnimatePresence, motion } from "framer-motion";
import { useMemo, useState } from "react";
import { Agent, Lead, RunRecord, RunStatus } from "../types.js";
import { FilterBar, FilterField } from "../components/FilterBar.js";
import { RunTable } from "../components/RunTable.js";
import { SectionHeader } from "../components/SectionHeader.js";
import { TraceTimeline } from "../components/TraceTimeline.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { byId } from "../mock-data.js";

interface RunsPageProps {
  runs: RunRecord[];
  leads: Lead[];
  agents: Agent[];
  onOpenLead: (leadId: string) => void;
}

interface FiltersState {
  agent: string;
  status: string;
  lead: string;
  priority: string;
  date: string;
  eventType: string;
}

const allStatus: RunStatus[] = [
  "success",
  "waiting_human_input",
  "waiting_human_approval",
  "blocked",
  "error",
  "skipped"
];

export function RunsPage({ runs, leads, agents, onOpenLead }: RunsPageProps) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(runs[0]?.id ?? null);
  const [filters, setFilters] = useState<FiltersState>({
    agent: "all",
    status: "all",
    lead: "all",
    priority: "all",
    date: "all",
    eventType: "all"
  });
  const [query, setQuery] = useState("");

  const filteredRuns = useMemo(() => {
    return runs.filter((run) => {
      if (filters.agent !== "all" && run.triggeredAgentId !== filters.agent) return false;
      if (filters.status !== "all" && run.status !== filters.status) return false;
      if (filters.lead !== "all" && run.leadId !== filters.lead) return false;
      if (filters.priority !== "all" && run.priority !== filters.priority) return false;
      if (filters.eventType !== "all" && run.eventType !== filters.eventType) return false;
      if (filters.date !== "all" && !run.timestamp.startsWith(filters.date)) return false;
      if (query.trim()) {
        const source = `${run.decisionSummary} ${run.nextStep} ${run.eventType}`.toLowerCase();
        if (!source.includes(query.trim().toLowerCase())) return false;
      }
      return true;
    });
  }, [filters, query, runs]);

  const selectedRun = useMemo(() => filteredRuns.find((run) => run.id === selectedRunId) ?? filteredRuns[0] ?? null, [filteredRuns, selectedRunId]);

  const statusCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const run of filteredRuns) {
      map.set(run.status, (map.get(run.status) ?? 0) + 1);
    }
    return map;
  }, [filteredRuns]);

  const healthKpis = useMemo(() => {
    const success = statusCounts.get("success") ?? 0;
    const total = filteredRuns.length || 1;
    const waiting = (statusCounts.get("waiting_human_input") ?? 0) + (statusCounts.get("waiting_human_approval") ?? 0);
    const blocked = (statusCounts.get("blocked") ?? 0) + (statusCounts.get("error") ?? 0);
    const avgDuration = Math.round(filteredRuns.reduce((sum, run) => sum + run.durationMs, 0) / total);

    return [
      { label: "Success Rate", value: `${Math.round((success / total) * 100)}%`, tone: "success" as const },
      { label: "Waiting Human", value: String(waiting), tone: "waiting_human_input" as const },
      { label: "Blocked / Error", value: String(blocked), tone: blocked > 0 ? ("error" as const) : ("success" as const) },
      { label: "Avg Runtime", value: `${(avgDuration / 1000).toFixed(1)}s`, tone: "skipped" as const }
    ];
  }, [filteredRuns, statusCounts]);

  const fields: FilterField[] = [
    {
      id: "agent",
      label: "Agent",
      value: filters.agent,
      options: [{ label: "All", value: "all" }, ...agents.map((agent) => ({ label: agent.name, value: agent.id }))]
    },
    {
      id: "status",
      label: "Status",
      value: filters.status,
      options: [{ label: "All", value: "all" }, ...allStatus.map((status) => ({ label: status, value: status }))]
    },
    {
      id: "lead",
      label: "Lead",
      value: filters.lead,
      options: [{ label: "All", value: "all" }, ...leads.map((lead) => ({ label: lead.name, value: lead.id }))]
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
      id: "date",
      label: "Date",
      value: filters.date,
      options: [
        { label: "All", value: "all" },
        ...Array.from(new Set(runs.map((run) => run.timestamp.slice(0, 10)))).map((date) => ({ label: date, value: date }))
      ]
    },
    {
      id: "eventType",
      label: "Event",
      value: filters.eventType,
      options: [
        { label: "All", value: "all" },
        ...Array.from(new Set(runs.map((run) => run.eventType))).map((eventType) => ({ label: eventType, value: eventType }))
      ]
    }
  ];

  return (
    <motion.div key="runs" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <SectionHeader title="Runs" subtitle="Inspect execution runs, decision traces, and intervention bottlenecks." />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {healthKpis.map((item) => (
          <div key={item.label} className="ml-panel rounded-2xl px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">{item.label}</p>
            <div className="mt-2 flex items-center justify-between">
              <p className="text-xl font-semibold text-slate-100">{item.value}</p>
              <StatusBadge value={item.tone} />
            </div>
          </div>
        ))}
      </div>

      <FilterBar
        fields={fields}
        onChange={(id, value) => setFilters((prev) => ({ ...prev, [id]: value }))}
        query={query}
        onQueryChange={setQuery}
        queryPlaceholder="Search decision summary or next step"
      />

      <RunTable runs={filteredRuns} onSelect={setSelectedRunId} selectedRunId={selectedRun?.id ?? null} />

      <AnimatePresence>
        {selectedRun ? (
          <motion.section
            key={selectedRun.id}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            className="ml-panel mt-4 rounded-2xl p-4"
          >
            <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold text-slate-100">Execution Trace {selectedRun.id}</h3>
                <p className="mt-1 text-xs text-slate-400">
                  {selectedRun.timestamp} • {byId.agent[selectedRun.triggeredAgentId]?.name} • {byId.lead[selectedRun.leadId]?.name}
                </p>
              </div>
              <button type="button" onClick={() => onOpenLead(selectedRun.leadId)} className="ml-button rounded-lg px-3 py-1.5 text-xs font-medium">
                Open Lead
              </button>
            </div>

            <div className="grid gap-3 xl:grid-cols-[1.2fr_1fr]">
              <div className="space-y-3">
                <details open className="ml-panel-soft rounded-xl p-3">
                  <summary className="cursor-pointer text-sm font-semibold text-slate-100">1. Event Context</summary>
                  <p className="mt-2 text-sm leading-relaxed text-slate-300">{selectedRun.trace.eventContext}</p>
                </details>

                <details open className="ml-panel-soft rounded-xl p-3">
                  <summary className="cursor-pointer text-sm font-semibold text-slate-100">2. Input Snapshot</summary>
                  <ul className="mt-2 space-y-1 text-sm text-slate-300">
                    {selectedRun.trace.inputSnapshot.map((item) => (
                      <li key={item} className="ml-panel-soft ml-code rounded-lg px-2 py-1.5 text-[12px] text-slate-300">
                        {item}
                      </li>
                    ))}
                  </ul>
                </details>

                <details open className="ml-panel-soft rounded-xl p-3">
                  <summary className="cursor-pointer text-sm font-semibold text-slate-100">3. Decision Summary</summary>
                  <p className="mt-2 text-sm leading-relaxed text-slate-300">{selectedRun.trace.decisionSummary}</p>
                </details>

                <details open className="ml-panel-soft rounded-xl p-3">
                  <summary className="cursor-pointer text-sm font-semibold text-slate-100">4. Agents Invoked</summary>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {selectedRun.trace.agentsInvoked.map((agentName) => (
                      <span key={agentName} className="ml-chip rounded-md px-2 py-1 text-xs text-slate-300">
                        {agentName}
                      </span>
                    ))}
                  </div>
                </details>

                <details open className="ml-panel-soft rounded-xl p-3">
                  <summary className="cursor-pointer text-sm font-semibold text-slate-100">5. Output</summary>
                  <p className="ml-code mt-2 rounded-lg border border-slate-600/30 bg-slate-900/60 px-2 py-2 text-[12px] text-slate-300">
                    {selectedRun.trace.output}
                  </p>
                </details>
              </div>

              <div>
                <div className="ml-panel-soft rounded-xl p-3">
                  <h4 className="mb-3 text-sm font-semibold text-slate-100">6. Trace Timeline</h4>
                  <TraceTimeline timeline={selectedRun.trace.timeline} />
                </div>
              </div>
            </div>
          </motion.section>
        ) : null}
      </AnimatePresence>
    </motion.div>
  );
}
