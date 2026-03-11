import { motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { Agent, Lead, RunRecord, RunStatus, StrategicAnalysis } from "../types.js";
import { formatDurationMs } from "../utils.js";
import { DetailDrawer } from "../components/DetailDrawer.js";
import { EmptyState } from "../components/EmptyState.js";
import { FilterBar, FilterField } from "../components/FilterBar.js";
import { MetricCard } from "../components/MetricCard.js";
import { RunTable } from "../components/RunTable.js";
import { SectionHeader } from "../components/SectionHeader.js";
import { SignalTag } from "../components/SignalTag.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { TraceTimeline } from "../components/TraceTimeline.js";

interface RunsPageProps {
  runs: RunRecord[];
  leads: Lead[];
  agents: Agent[];
  strategicAnalyses?: StrategicAnalysis[];
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
  "skipped",
  "pending",
  "unknown"
];

const preferredEventTypes = [
  "new_inbound_message",
  "human_edit",
  "approval_resolved",
  "scheduled_reactivation",
  "payment_detected",
  "stage_changed",
  "task_due"
];

function toLabel(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function inferEventSource(eventType: string): string {
  if (eventType.includes("approval")) return "Human approval resolution";
  if (eventType.includes("payment")) return "Business payment event";
  if (eventType.includes("stage")) return "State transition event";
  if (eventType.includes("task")) return "Task scheduler";
  if (eventType.includes("reactivation")) return "Scheduled reactivation";
  if (eventType.includes("human")) return "Operator action";
  return "WhatsApp / Zoko webhook";
}

function runNeedsHumanGate(run: RunRecord): boolean {
  return run.status === "waiting_human_approval" || run.trace.agentsInvoked.some((agent) => agent.toLowerCase().includes("human"));
}

export function RunsPage({ runs, leads, agents, strategicAnalyses = [], onOpenLead }: RunsPageProps) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(runs[0]?.id ?? null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [filters, setFilters] = useState<FiltersState>({
    agent: "all",
    status: "all",
    lead: "all",
    priority: "all",
    date: "all",
    eventType: "all"
  });
  const [query, setQuery] = useState("");
  const [isFiltering, setIsFiltering] = useState(false);
  const isFirstFilter = useRef(true);

  useEffect(() => {
    if (isFirstFilter.current) {
      isFirstFilter.current = false;
      return;
    }
    setIsFiltering(true);
    const timer = window.setTimeout(() => setIsFiltering(false), 160);
    return () => window.clearTimeout(timer);
  }, [filters.agent, filters.date, filters.eventType, filters.lead, filters.priority, filters.status, query]);

  const filteredRuns = useMemo(() => {
    const leadById = new Map(leads.map((lead) => [lead.id, lead]));
    const agentById = new Map(agents.map((agent) => [agent.id, agent]));
    return runs.filter((run) => {
      if (filters.agent !== "all" && run.triggeredAgentId !== filters.agent) return false;
      if (filters.status !== "all" && run.status !== filters.status) return false;
      if (filters.lead !== "all" && run.leadId !== filters.lead) return false;
      if (filters.priority !== "all" && run.priority !== filters.priority) return false;
      if (filters.eventType !== "all" && run.eventType !== filters.eventType) return false;
      if (filters.date !== "all" && !run.timestamp.startsWith(filters.date)) return false;
      if (query.trim()) {
        const leadName = leadById.get(run.leadId)?.name ?? run.leadId;
        const agentName = agentById.get(run.triggeredAgentId)?.name ?? run.triggeredAgentId;
        const source = `${run.id} ${run.decisionSummary} ${run.nextStep} ${run.eventType} ${leadName} ${agentName} ${run.conversationId}`.toLowerCase();
        if (!source.includes(query.trim().toLowerCase())) return false;
      }
      return true;
    });
  }, [filters, query, runs, leads, agents]);

  useEffect(() => {
    if (!filteredRuns.length) {
      setSelectedRunId(null);
      setDrawerOpen(false);
      return;
    }
    if (!selectedRunId || !filteredRuns.some((run) => run.id === selectedRunId)) {
      setSelectedRunId(filteredRuns[0].id);
    }
  }, [filteredRuns, selectedRunId]);

  const selectedRun = useMemo(() => (selectedRunId ? filteredRuns.find((run) => run.id === selectedRunId) ?? null : null), [filteredRuns, selectedRunId]);
  const selectedLead = selectedRun ? leads.find((lead) => lead.id === selectedRun.leadId) ?? null : null;
  const selectedAgent = selectedRun ? agents.find((agent) => agent.id === selectedRun.triggeredAgentId) ?? null : null;
  const selectedStrategicAnalysis = selectedRun ? strategicAnalyses.find((analysis) => analysis.leadId === selectedRun.leadId) ?? null : null;

  const errorRuns = useMemo(() => filteredRuns.filter((run) => run.status === "error").length, [filteredRuns]);
  const blockedRuns = useMemo(() => filteredRuns.filter((run) => run.status === "blocked").length, [filteredRuns]);
  const failedRuns = blockedRuns + errorRuns;
  const waitingHumanApprovalRuns = useMemo(
    () => filteredRuns.filter((run) => run.status === "waiting_human_approval").length,
    [filteredRuns]
  );
  const waitingHumanInputRuns = useMemo(
    () => filteredRuns.filter((run) => run.status === "waiting_human_input").length,
    [filteredRuns]
  );
  const waitingRuns = waitingHumanApprovalRuns + waitingHumanInputRuns;
  const interventionRuns = failedRuns + waitingRuns;
  const averageRuntimeMs = useMemo(() => {
    if (filteredRuns.length === 0) return 0;
    return Math.round(filteredRuns.reduce((total, run) => total + run.durationMs, 0) / filteredRuns.length);
  }, [filteredRuns]);
  const interventionRatio = filteredRuns.length ? interventionRuns / filteredRuns.length : 0;
  const hasActiveFilters = query.trim().length > 0 || Object.values(filters).some((value) => value !== "all");
  const requiresHumanGate = selectedRun ? runNeedsHumanGate(selectedRun) : false;

  const healthKpis = useMemo(() => {
    return [
      {
        label: "Runs Today",
        value: filteredRuns.length,
        delta: `${runs.length} total`,
        tone: "neutral" as const
      },
      {
        label: "Failed Runs",
        value: failedRuns,
        delta: failedRuns > 0 ? "Errors or blocked states" : "No failures",
        tone: failedRuns > 0 ? ("attention" as const) : ("good" as const)
      },
      {
        label: "Waiting Human Approval",
        value: waitingHumanApprovalRuns,
        delta: waitingHumanInputRuns > 0 ? `${waitingHumanInputRuns} waiting input` : "Approval queue",
        tone: waitingHumanApprovalRuns > 0 ? ("attention" as const) : ("neutral" as const)
      },
      {
        label: "Avg Runtime",
        value: formatDurationMs(averageRuntimeMs),
        delta: "Across filtered runs",
        tone: "neutral" as const
      }
    ];
  }, [averageRuntimeMs, failedRuns, filteredRuns.length, runs.length, waitingHumanApprovalRuns, waitingHumanInputRuns]);

  const alertSummary = useMemo(() => {
    if (filteredRuns.length <= 2 || interventionRatio < 0.35) return null;
    if (failedRuns > 0 && waitingRuns === 0) {
      const title = blockedRuns > 0 && errorRuns > 0
        ? "Blocked and error runs are elevated"
        : blockedRuns > 0
          ? "Blocked runs are elevated"
          : "Error runs are elevated";
      return {
        title,
        detail: `${failedRuns} of ${filteredRuns.length} visible runs are failed (blocked: ${blockedRuns}, error: ${errorRuns}).`,
        badge: blockedRuns > 0 ? "blocked" : "error"
      };
    }
    if (waitingRuns > failedRuns) {
      return {
        title: "Human-wait states are elevated",
        detail: `${interventionRuns} of ${filteredRuns.length} runs need intervention (waiting input: ${waitingHumanInputRuns}, waiting approval: ${waitingHumanApprovalRuns}, failed: ${failedRuns}).`,
        badge: waitingHumanApprovalRuns > 0 ? "waiting_human_approval" : "waiting_human_input"
      };
    }
    return {
      title: "Intervention-required runs are elevated",
      detail: `${interventionRuns} of ${filteredRuns.length} runs need intervention (failed: ${failedRuns}, waiting states: ${waitingRuns}).`,
      badge: failedRuns > 0 ? "blocked" : "waiting_human_input"
    };
  }, [
    blockedRuns,
    errorRuns,
    failedRuns,
    filteredRuns.length,
    interventionRatio,
    interventionRuns,
    waitingHumanApprovalRuns,
    waitingHumanInputRuns,
    waitingRuns
  ]);

  const eventOptions = useMemo(() => {
    const discovered = Array.from(new Set(runs.map((run) => run.eventType)));
    const ordered = Array.from(new Set([...preferredEventTypes, ...discovered]));
    return ordered.map((eventType) => ({ label: toLabel(eventType), value: eventType }));
  }, [runs]);

  const dateOptions = useMemo(
    () =>
      Array.from(new Set(runs.map((run) => run.timestamp.slice(0, 10))))
        .sort((a, b) => (a > b ? -1 : 1))
        .map((date) => ({ label: date, value: date })),
    [runs]
  );

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
      options: [{ label: "All", value: "all" }, ...allStatus.map((status) => ({ label: toLabel(status), value: status }))]
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
      options: [{ label: "All", value: "all" }, ...dateOptions]
    },
    {
      id: "eventType",
      label: "Event",
      value: filters.eventType,
      options: [{ label: "All", value: "all" }, ...eventOptions]
    }
  ];

  function resetFilters(): void {
    setFilters({
      agent: "all",
      status: "all",
      lead: "all",
      priority: "all",
      date: "all",
      eventType: "all"
    });
    setQuery("");
  }

  function handleSelectRun(runId: string): void {
    setSelectedRunId(runId);
    setDrawerOpen(true);
  }

  return (
    <motion.div key="runs" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <SectionHeader
        title="Runs"
        subtitle="Execution observability for orchestrated agent decisions, governance checks, and human-gated actions."
        action={
          <div className="flex items-center gap-2 text-xs">
            <StatusBadge value={interventionRatio >= 0.35 ? "degraded" : "running"} />
            <span className="ml-chip rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-300">
              {filteredRuns.length} visible
            </span>
          </div>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {healthKpis.map((item) => (
          <MetricCard key={item.label} label={item.label} value={item.value} delta={item.delta} tone={item.tone} />
        ))}
      </div>

      {alertSummary ? (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="ml-panel mb-4 rounded-2xl px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-semibold text-amber-100">{alertSummary.title}</p>
              <p className="mt-1 text-xs text-amber-100/80">{alertSummary.detail}</p>
            </div>
            <StatusBadge value={alertSummary.badge} />
          </div>
        </motion.div>
      ) : null}

      <FilterBar
        fields={fields}
        onChange={(id, value) => setFilters((prev) => ({ ...prev, [id]: value }))}
        query={query}
        onQueryChange={setQuery}
        queryPlaceholder="Search run id, decision summary, lead, or conversation"
        actions={
          <button
            type="button"
            onClick={resetFilters}
            disabled={!hasActiveFilters}
            className="ml-button ml-auto rounded-xl px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-45"
          >
            Reset
          </button>
        }
      />

      <div className="mb-3 mt-[-10px] flex items-center justify-between px-1 text-[11px] text-slate-500">
        <span>{filteredRuns.length} run records shown</span>
        <span className="ml-code text-slate-500">
          Last ingest: {runs[0]?.timestamp ? new Date(runs[0].timestamp).toLocaleString() : "n/a"}
        </span>
      </div>

      {isFiltering ? (
        <RunsLoadingState />
      ) : filteredRuns.length === 0 ? (
        <EmptyState
          title={hasActiveFilters ? "No runs match the current filters" : "No runs available"}
          description={
            hasActiveFilters
              ? "Try removing one or more filters to recover visibility across the execution stream."
              : "Runs will appear here as incoming events are orchestrated."
          }
        />
      ) : (
        <RunTable runs={filteredRuns} leads={leads} agents={agents} onSelect={handleSelectRun} selectedRunId={selectedRun?.id ?? null} />
      )}

      <DetailDrawer
        open={drawerOpen && Boolean(selectedRun)}
        title={selectedRun ? `Execution Trace ${selectedRun.id}` : "Execution Trace"}
        subtitle={
          selectedRun
            ? `${selectedRun.timestamp} • ${selectedAgent?.name ?? selectedRun.triggeredAgentId} • ${selectedLead?.name ?? selectedRun.leadId}`
            : undefined
        }
        onClose={() => setDrawerOpen(false)}
      >
        {selectedRun ? (
          <div className="space-y-3 pb-8">
            <section className="ml-panel-soft rounded-xl p-3">
              <h4 className="text-xs font-semibold uppercase tracking-[0.11em] text-slate-500">A. Event Context</h4>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <InfoRow label="Event Type" value={toLabel(selectedRun.eventType)} />
                <InfoRow label="Timestamp" value={selectedRun.timestamp} mono />
                <InfoRow label="Lead" value={selectedLead?.name ?? selectedRun.leadId} />
                <InfoRow label="Conversation" value={selectedRun.conversationId} mono />
                <InfoRow label="Source" value={inferEventSource(selectedRun.eventType)} />
                <InfoRow label="Priority" value={toLabel(selectedRun.priority)} />
              </div>
              <div className="mt-3 rounded-xl border border-slate-600/25 bg-slate-900/55 px-3 py-2.5">
                <p className="text-[10px] font-semibold uppercase tracking-[0.11em] text-slate-500">Triggering Message Preview</p>
                <p className="mt-1.5 text-sm leading-relaxed text-slate-300">{selectedLead?.lastMessage ?? "No message context available."}</p>
              </div>
              <div className="mt-3 flex justify-end">
                <button
                  type="button"
                  onClick={() => {
                    onOpenLead(selectedRun.leadId);
                    setDrawerOpen(false);
                  }}
                  className="ml-button rounded-lg px-3 py-1.5 text-xs font-medium"
                >
                  Open Lead Workspace
                </button>
              </div>
            </section>

            <section className="ml-panel-soft rounded-xl p-3">
              <h4 className="text-xs font-semibold uppercase tracking-[0.11em] text-slate-500">B. Input Snapshot</h4>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <InfoRow label="Current Stage" value={selectedLead?.currentStage ?? "Unknown"} />
                <InfoRow label="Priority Score" value={selectedLead ? String(selectedLead.priorityScore) : "Unknown"} />
                <InfoRow label="Missing Fields" value={selectedLead?.missingFields.length ? selectedLead.missingFields.join(", ") : "None"} />
                <InfoRow
                  label="Open Tasks"
                  value={
                    selectedLead?.openTasks.filter((task) => !task.done).length
                      ? `${selectedLead.openTasks.filter((task) => !task.done).length} active task(s)`
                      : "No open tasks"
                  }
                />
              </div>
              <div className="mt-3">
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.11em] text-slate-500">Detected Signals</p>
                <div className="flex flex-wrap gap-2">
                  {selectedLead?.detectedSignals?.length ? (
                    selectedLead.detectedSignals.map((signal) => <SignalTag key={signal} text={signal} />)
                  ) : (
                    <span className="text-xs text-slate-500">No signal snapshot available.</span>
                  )}
                </div>
              </div>
              <div className="mt-3">
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.11em] text-slate-500">Loaded Context Inputs</p>
                <ul className="space-y-1">
                  {selectedRun.trace.inputSnapshot.map((item) => (
                    <li key={item} className="ml-code rounded-lg border border-slate-600/25 bg-slate-900/55 px-2.5 py-1.5 text-[12px] text-slate-300">
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            </section>

            <section className="ml-panel-soft rounded-xl p-3">
              <h4 className="text-xs font-semibold uppercase tracking-[0.11em] text-slate-500">C. Decision Summary</h4>
              <p className="mt-2 text-sm leading-relaxed text-slate-200">{selectedRun.decisionSummary}</p>
              <p className="mt-2 text-sm leading-relaxed text-slate-300">{selectedRun.trace.decisionSummary}</p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <InfoRow label="Human Approval Required" value={requiresHumanGate ? "Yes" : "No"} />
                <InfoRow label="Next Step" value={selectedRun.nextStep} />
              </div>
              {selectedStrategicAnalysis ? (
                <div className="mt-3 rounded-xl border border-slate-600/25 bg-slate-900/55 px-3 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.11em] text-slate-500">Strategic Advisor Output</p>
                    <StatusBadge value={selectedStrategicAnalysis.priorityRecommendation} />
                  </div>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <InfoRow label="Probable Stage" value={selectedStrategicAnalysis.probableStage} />
                    <InfoRow label="Momentum" value={toLabel(selectedStrategicAnalysis.momentum)} />
                    <InfoRow label="Stage Confidence" value={`${Math.round(selectedStrategicAnalysis.stageConfidence * 100)}%`} />
                    <InfoRow label="Recommended Action" value={toLabel(selectedStrategicAnalysis.nextBestAction)} />
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {selectedStrategicAnalysis.keySignals.slice(0, 6).map((signal, index) => (
                      <SignalTag key={`${selectedRun.id}-${signal}-${index}`} text={signal} />
                    ))}
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-slate-300">{selectedStrategicAnalysis.rationale}</p>
                </div>
              ) : null}
            </section>

            <section className="ml-panel-soft rounded-xl p-3">
              <h4 className="text-xs font-semibold uppercase tracking-[0.11em] text-slate-500">D. Agents Invoked</h4>
              <ol className="mt-3 space-y-2">
                {selectedRun.trace.agentsInvoked.map((agentName, index) => (
                  <li key={`${selectedRun.id}-${agentName}`} className="rounded-xl border border-slate-600/25 bg-slate-900/55 px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-slate-500/60 bg-slate-800 text-[10px] font-semibold text-slate-300">
                        {index + 1}
                      </span>
                      <span className="text-sm text-slate-200">{agentName}</span>
                    </div>
                  </li>
                ))}
              </ol>
            </section>

            <section className="ml-panel-soft rounded-xl p-3">
              <h4 className="text-xs font-semibold uppercase tracking-[0.11em] text-slate-500">E. Output</h4>
              <p className="ml-code mt-2 rounded-xl border border-slate-600/25 bg-slate-900/55 px-3 py-2 text-[12px] leading-relaxed text-slate-300">
                {selectedRun.trace.output}
              </p>
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                <InfoRow label="Status" value={toLabel(selectedRun.status)} />
                <InfoRow label="Duration" value={formatDurationMs(selectedRun.durationMs)} mono />
                <InfoRow label="Next Step" value={selectedRun.nextStep} />
              </div>
            </section>

            <section className="ml-panel-soft rounded-xl p-3">
              <h4 className="text-xs font-semibold uppercase tracking-[0.11em] text-slate-500">F. Trace Timeline</h4>
              <div className="mt-3">
                <TraceTimeline timeline={selectedRun.trace.timeline} />
              </div>
            </section>
          </div>
        ) : null}
      </DetailDrawer>
    </motion.div>
  );
}

function RunsLoadingState() {
  return (
    <div className="ml-table-shell overflow-hidden rounded-2xl">
      <div className="animate-pulse space-y-2 p-4">
        {Array.from({ length: 8 }).map((_, index) => (
          <div key={`run-loading-${index}`} className="h-12 rounded-xl border border-slate-700/30 bg-slate-900/50" />
        ))}
      </div>
    </div>
  );
}

function InfoRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-xl border border-slate-600/20 bg-slate-900/45 px-2.5 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-[0.11em] text-slate-500">{label}</p>
      <p className={`mt-1 text-xs text-slate-200 ${mono ? "ml-code" : ""}`}>{value}</p>
    </div>
  );
}
