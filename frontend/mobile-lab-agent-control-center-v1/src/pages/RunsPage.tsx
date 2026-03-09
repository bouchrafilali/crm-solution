import { AnimatePresence, motion } from "framer-motion";
import { useMemo, useState } from "react";
import { Agent, Lead, RunRecord, RunStatus } from "../types.js";
import { FilterBar, FilterField } from "../components/FilterBar.js";
import { RunTable } from "../components/RunTable.js";
import { SectionHeader } from "../components/SectionHeader.js";
import { TraceTimeline } from "../components/TraceTimeline.js";
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
      <FilterBar
        fields={fields}
        onChange={(id, value) => setFilters((prev) => ({ ...prev, [id]: value }))}
        query={query}
        onQueryChange={setQuery}
        queryPlaceholder="Search decision summary or next step"
      />

      <RunTable runs={filteredRuns} onSelect={setSelectedRunId} />

      <AnimatePresence>
        {selectedRun ? (
          <motion.section
            key={selectedRun.id}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900/80 p-4"
          >
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold text-zinc-100">Execution Trace: {selectedRun.id}</h3>
                <p className="mt-1 text-xs text-zinc-400">
                  {selectedRun.timestamp} • {byId.agent[selectedRun.triggeredAgentId]?.name} • {byId.lead[selectedRun.leadId]?.name}
                </p>
              </div>
              <button
                type="button"
                onClick={() => onOpenLead(selectedRun.leadId)}
                className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200"
              >
                Open Lead
              </button>
            </div>

            <div className="grid gap-3 xl:grid-cols-[1.2fr_1fr]">
              <div className="space-y-3">
                <details open className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-3">
                  <summary className="cursor-pointer text-sm font-medium text-zinc-100">1. Event Context</summary>
                  <p className="mt-2 text-sm text-zinc-300">{selectedRun.trace.eventContext}</p>
                </details>

                <details open className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-3">
                  <summary className="cursor-pointer text-sm font-medium text-zinc-100">2. Input Snapshot</summary>
                  <ul className="mt-2 space-y-1 text-sm text-zinc-300">
                    {selectedRun.trace.inputSnapshot.map((item) => (
                      <li key={item} className="rounded-lg border border-zinc-800 bg-zinc-900/70 px-2 py-1.5">
                        {item}
                      </li>
                    ))}
                  </ul>
                </details>

                <details open className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-3">
                  <summary className="cursor-pointer text-sm font-medium text-zinc-100">3. Decision Summary</summary>
                  <p className="mt-2 text-sm text-zinc-300">{selectedRun.trace.decisionSummary}</p>
                </details>

                <details open className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-3">
                  <summary className="cursor-pointer text-sm font-medium text-zinc-100">4. Agents Invoked</summary>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {selectedRun.trace.agentsInvoked.map((agentName) => (
                      <span key={agentName} className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-300">
                        {agentName}
                      </span>
                    ))}
                  </div>
                </details>

                <details open className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-3">
                  <summary className="cursor-pointer text-sm font-medium text-zinc-100">5. Output</summary>
                  <p className="mt-2 text-sm text-zinc-300">{selectedRun.trace.output}</p>
                </details>
              </div>

              <div>
                <div className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-3">
                  <h4 className="mb-3 text-sm font-medium text-zinc-100">6. Trace Timeline</h4>
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
