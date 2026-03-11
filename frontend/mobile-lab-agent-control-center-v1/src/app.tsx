import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useState } from "react";
import { mockData } from "./mock-data.js";
import {
  ActivityEvent,
  AppMockData,
  ApprovalDecision,
  ApprovalItem,
  ConversationMessage,
  LearningEvent,
  Lead,
  NavPage,
  RunRecord,
  StrategicAnalysis,
  SuggestedReply,
  Agent
} from "./types.js";
import { DashboardPage } from "./pages/DashboardPage.js";
import { AgentsPage } from "./pages/AgentsPage.js";
import { RunsPage } from "./pages/RunsPage.js";
import { LeadsPage } from "./pages/LeadsPage.js";
import { LeadWorkspacePage } from "./pages/LeadWorkspacePage.js";
import { ApprovalsPage } from "./pages/ApprovalsPage.js";
import { LearningPage } from "./pages/LearningPage.js";
import { SystemArchitectureMapPage } from "./pages/SystemArchitectureMapPage.js";
import { SystemBrainPage } from "./pages/SystemBrainPage.js";
import { generateStrategicAdvisorAnalysis } from "./strategicAdvisorAgentV1.js";
import { cn, initials } from "./utils.js";
import { systemBrainMock } from "./system-brain-mock.js";
import { AppErrorBoundary } from "./components/AppErrorBoundary.js";

interface SidebarItem {
  id: Exclude<NavPage, "lead-workspace">;
  label: string;
}

const sidebarItems: SidebarItem[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "agents", label: "Agents" },
  { id: "runs", label: "Runs" },
  { id: "leads", label: "Leads" },
  { id: "approvals", label: "Approvals" },
  { id: "learning", label: "Learning" },
  { id: "system-architecture-map", label: "System Map" },
  { id: "system-brain", label: "System Brain" }
];

function isNavPage(value: string): value is NavPage {
  return [
    "dashboard",
    "agents",
    "runs",
    "leads",
    "lead-workspace",
    "approvals",
    "learning",
    "system-architecture-map",
    "system-brain"
  ].includes(value);
}

function readPageFromHash(): NavPage | null {
  if (typeof window === "undefined") return null;
  const hashValue = window.location.hash.replace(/^#/, "").replace(/^\//, "");
  return isNavPage(hashValue) ? hashValue : null;
}

interface AgentControlCenterLivePayload {
  agents?: Agent[];
  leads?: Lead[];
  runs?: RunRecord[];
  approvals?: ApprovalItem[];
  learningEvents?: LearningEvent[];
  suggestedReplies?: SuggestedReply[];
  strategicAnalyses?: StrategicAnalysis[];
  conversations?: ConversationMessage[];
  activityFeed?: ActivityEvent[];
}

type DataSourceMode = "live" | "mixed" | "mock_fallback";

export function App() {
  const [activePage, setActivePage] = useState<NavPage>(() => readPageFromHash() ?? "dashboard");
  const [liveData, setLiveData] = useState<AgentControlCenterLivePayload | null>(null);
  const [liveDataError, setLiveDataError] = useState<string | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [selectedLeadId, setSelectedLeadId] = useState("");
  const [approvals, setApprovals] = useState<ApprovalItem[]>(mockData.approvals);

  const agents = useMemo(() => (Array.isArray(liveData?.agents) ? liveData.agents : mockData.agents), [liveData]);
  const leads = useMemo(() => (Array.isArray(liveData?.leads) ? liveData.leads : mockData.leads), [liveData]);
  const runs = useMemo(() => (Array.isArray(liveData?.runs) ? liveData.runs : mockData.runs), [liveData]);
  const learningEvents = useMemo(
    () => (Array.isArray(liveData?.learningEvents) ? liveData.learningEvents : mockData.learningEvents),
    [liveData]
  );
  const suggestedReplies = useMemo(
    () => (Array.isArray(liveData?.suggestedReplies) ? liveData.suggestedReplies : mockData.suggestedReplies),
    [liveData]
  );
  const strategicAnalyses = useMemo(
    () => (Array.isArray(liveData?.strategicAnalyses) ? liveData.strategicAnalyses : mockData.strategicAnalyses),
    [liveData]
  );
  const conversations = useMemo(
    () => (Array.isArray(liveData?.conversations) ? liveData.conversations : mockData.conversations),
    [liveData]
  );
  const activityFeed = useMemo(
    () => (Array.isArray(liveData?.activityFeed) ? liveData.activityFeed : mockData.activityFeed),
    [liveData]
  );
  const appData = useMemo<AppMockData>(
    () => ({
      agents,
      leads,
      runs,
      activityFeed,
      approvals,
      learningEvents,
      suggestedReplies,
      strategicAnalyses,
      conversations
    }),
    [agents, leads, runs, activityFeed, approvals, learningEvents, suggestedReplies, strategicAnalyses, conversations]
  );
  const dataSourceMode = useMemo<DataSourceMode>(() => {
    if (!liveData) return "mock_fallback";
    const requiredKeys: Array<keyof AgentControlCenterLivePayload> = [
      "agents",
      "leads",
      "runs",
      "approvals",
      "learningEvents",
      "suggestedReplies",
      "strategicAnalyses",
      "conversations",
      "activityFeed"
    ];
    const presentCount = requiredKeys.filter((key) => Array.isArray(liveData[key])).length;
    if (presentCount === requiredKeys.length) return "live";
    return "mixed";
  }, [liveData]);

  const selectedLead = useMemo(
    () => leads.find((lead) => lead.id === selectedLeadId) ?? leads[0] ?? null,
    [selectedLeadId, leads]
  );
  const selectedLeadAnalysis = useMemo(() => {
    if (!selectedLead) return null;
    const mapped = strategicAnalyses.find((analysis) => analysis.leadId === selectedLead?.id);
    if (mapped) return mapped;
    return generateStrategicAdvisorAnalysis({
      lead: selectedLead,
      conversation: {
        id: `wa-${selectedLead.id}`,
        label: `Conversation ${selectedLead.id}`
      },
      recentMessages: conversations
        .filter((message) => message.leadId === selectedLead.id)
        .slice(-6),
      currentStage: selectedLead.currentStage,
      signals: selectedLead.detectedSignals,
      priorityScore: selectedLead.priorityScore,
      openTasks: selectedLead.openTasks,
      missingFields: selectedLead.missingFields,
      lastOperatorAction: null
    });
  }, [selectedLead, strategicAnalyses, conversations]);
  const selectedLeadReplies = useMemo(
    () => (selectedLead ? suggestedReplies.filter((reply) => reply.leadId === selectedLead.id) : []),
    [selectedLead, suggestedReplies]
  );

  useEffect(() => {
    if (selectedLeadId && leads.some((lead) => lead.id === selectedLeadId)) return;
    setSelectedLeadId(leads[0]?.id ?? "");
  }, [leads, selectedLeadId]);

  useEffect(() => {
    let cancelled = false;

    async function loadLiveData(): Promise<void> {
      try {
        setLiveDataError(null);
        const response = await fetch("/api/agent-control-center-v1/data?range=30&stage=ALL", { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP_${response.status}`);
        const payload = (await response.json()) as AgentControlCenterLivePayload;
        if (cancelled) return;
        setLiveData(payload);
        setLastSyncAt(new Date().toISOString());
        if (Array.isArray(payload.approvals)) {
          setApprovals(payload.approvals);
        }
      } catch (error) {
        if (cancelled) return;
        setLiveDataError(error instanceof Error ? error.message : "live_data_unavailable");
      }
    }

    void loadLiveData();
    const interval = window.setInterval(() => {
      void loadLiveData();
    }, 15000);
    const onVisible = (): void => {
      if (document.visibilityState === "visible") void loadLiveData();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  function navigateToPage(page: NavPage): void {
    setActivePage(page);
  }

  useEffect(() => {
    if (typeof window === "undefined") return;
    const targetHash = `#/${activePage}`;
    if (window.location.hash !== targetHash) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${targetHash}`);
    }
  }, [activePage]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    function handleHashChange(): void {
      const pageFromHash = readPageFromHash();
      if (pageFromHash) setActivePage(pageFromHash);
    }

    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  function openLeadWorkspace(leadId: string): void {
    setSelectedLeadId(leadId);
    navigateToPage("lead-workspace");
  }

  function handleApprovalDecision(id: string, decision: ApprovalDecision): void {
    setApprovals((prev) => prev.map((item) => (item.id === id ? { ...item, decision } : item)));
  }

  return (
    <div className="min-h-screen bg-[#06080d] text-slate-100">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_14%_18%,rgba(56,189,248,0.06),transparent_36%),radial-gradient(circle_at_88%_0%,rgba(16,185,129,0.06),transparent_30%)]" />
      <div className="relative flex min-h-screen">
        <aside className="sticky top-0 hidden h-screen w-72 shrink-0 flex-col border-r border-slate-700/40 bg-slate-950/85 px-5 py-6 backdrop-blur-sm lg:flex">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-sky-300">Mobile-Lab</p>
            <h1 className="mt-2 text-[1.1rem] font-semibold tracking-tight text-slate-100">Agent Control Center V1</h1>
            <p className="mt-1 text-xs leading-relaxed text-slate-400">Mission Control for AI-powered WhatsApp sales operations.</p>
          </div>

          <nav className="mt-8 space-y-1.5">
            {sidebarItems.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => navigateToPage(item.id)}
                className={cn(
                  "ml-interactive flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-sm",
                  activePage === item.id
                    ? "border border-sky-300/35 bg-sky-500/12 text-sky-100"
                    : "border border-transparent text-slate-300 hover:border-slate-600/30 hover:bg-slate-900/65"
                )}
              >
                <span className="flex items-center gap-2">
                  <span className={cn("h-1.5 w-1.5 rounded-full", activePage === item.id ? "bg-sky-300" : "bg-slate-600")} />
                  {item.label}
                </span>
                {item.id === "approvals" ? (
                  <span className="ml-chip rounded-md px-1.5 py-0.5 text-[10px] font-semibold text-slate-300">
                    {approvals.filter((item) => item.decision === "pending").length}
                  </span>
                ) : null}
              </button>
            ))}
          </nav>

          <div className="ml-panel mt-auto space-y-3 rounded-2xl p-3.5 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-slate-500">System status</span>
              <span className="inline-flex items-center gap-1 text-emerald-200">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-300 shadow-[0_0_8px_rgba(52,211,153,0.7)]" />
                Stable
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-500">Environment</span>
              <span className="text-slate-300">Production Sim</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-500">Operator</span>
              <span className="inline-flex items-center gap-2 text-slate-300">
                <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-slate-600 bg-slate-800 text-[10px]">
                  {initials("Meryem Lahlou")}
                </span>
                Meryem Lahlou
              </span>
            </div>
          </div>
        </aside>

        <main className="w-full px-4 pb-8 pt-4 sm:px-6 lg:px-8">
          <div className="mx-auto w-full max-w-[1880px]">
            <div className="ml-panel mb-4 flex items-center justify-between rounded-2xl px-4 py-3 lg:hidden">
            <div>
                <p className="text-[10px] uppercase tracking-[0.16em] text-sky-300">Mobile-Lab</p>
                <p className="text-sm font-semibold text-slate-100">Agent Control Center V1</p>
            </div>
            <select
              value={activePage === "lead-workspace" ? "leads" : activePage}
              onChange={(event) => navigateToPage(event.target.value as NavPage)}
              className="ml-panel-soft rounded-lg px-2 py-1 text-xs text-slate-200"
            >
              {sidebarItems.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
            </div>

            <AppErrorBoundary onReset={() => navigateToPage("dashboard")}>
              {liveDataError ? (
                <div className="ml-panel mb-3 rounded-xl border border-amber-300/35 px-3 py-2 text-xs text-amber-100">
                  Live Mobile-Lab feed unavailable ({liveDataError}). Showing fallback data.
                </div>
              ) : null}
              <div className="mb-2 flex items-center gap-2 text-[11px] text-slate-500">
                <span>
                  Data source:
                  <span className="ml-code ml-1 text-slate-300">
                    {dataSourceMode === "live" ? "live" : dataSourceMode === "mixed" ? "mixed" : "mock_fallback"}
                  </span>
                </span>
                {lastSyncAt ? (
                  <span>
                    Synced at <span className="ml-code text-slate-400">{new Date(lastSyncAt).toLocaleTimeString()}</span>
                  </span>
                ) : null}
              </div>
              <AnimatePresence mode="wait">
                {activePage === "dashboard" ? (
                  <DashboardPage key="page-dashboard" data={appData} onOpenLead={openLeadWorkspace} lastSyncAt={lastSyncAt} />
                ) : null}
                {activePage === "agents" ? <AgentsPage key="page-agents" agents={agents} /> : null}
                {activePage === "runs" ? (
                  <RunsPage key="page-runs" runs={runs} leads={leads} agents={agents} strategicAnalyses={strategicAnalyses} onOpenLead={openLeadWorkspace} />
                ) : null}
                {activePage === "leads" ? <LeadsPage key="page-leads" leads={leads} onOpenLead={openLeadWorkspace} /> : null}
                {activePage === "lead-workspace" && selectedLead && selectedLeadAnalysis ? (
                  <LeadWorkspacePage
                    key={`page-workspace-${selectedLead.id}`}
                    lead={selectedLead}
                    analysis={selectedLeadAnalysis}
                    suggestedReplies={selectedLeadReplies}
                    runs={runs}
                    learningEvents={learningEvents}
                    messages={conversations}
                    onBackToLeads={() => navigateToPage("leads")}
                  />
                ) : null}
                {activePage === "approvals" ? (
                  <ApprovalsPage key="page-approvals" approvals={approvals} leads={leads} agents={agents} onDecision={handleApprovalDecision} />
                ) : null}
                {activePage === "learning" ? <LearningPage key="page-learning" learningEvents={learningEvents} leads={leads} /> : null}
                {activePage === "system-architecture-map" ? <SystemArchitectureMapPage key="page-system-architecture-map" /> : null}
                {activePage === "system-brain" ? <SystemBrainPage key="page-system-brain" data={systemBrainMock} dataMode="mock" /> : null}
              </AnimatePresence>
            </AppErrorBoundary>
          </div>
        </main>
      </div>
    </div>
  );
}
