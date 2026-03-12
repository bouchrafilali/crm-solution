import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useState } from "react";
import { AppErrorBoundary } from "./components/AppErrorBoundary.js";
import { AppShell } from "./components/shell/AppShell.js";
import { ExternalModulePage } from "./components/shell/ExternalModulePage.js";
import { ModulePageHeader } from "./components/shell/ModulePageHeader.js";
import { PageContainer } from "./components/shell/PageContainer.js";
import { mockData } from "./mock-data.js";
import { ControlCenterPage } from "./pages/ControlCenterPage.js";
import { DashboardPage } from "./pages/DashboardPage.js";
import { LeadsPage } from "./pages/LeadsPage.js";
import { LeadWorkspacePage } from "./pages/LeadWorkspacePage.js";
import { RunsPage } from "./pages/RunsPage.js";
import { ApprovalsPage } from "./pages/ApprovalsPage.js";
import { LearningPage } from "./pages/LearningPage.js";
import { SystemArchitectureMapPage } from "./pages/SystemArchitectureMapPage.js";
import { SystemBrainPage } from "./pages/SystemBrainPage.js";
import { AgentsPage } from "./pages/AgentsPage.js";
import { generateStrategicAdvisorAnalysis } from "./strategicAdvisorAgentV1.js";
import { systemBrainMock } from "./system-brain-mock.js";
import {
  ActivityEvent,
  Agent,
  AppMockData,
  ApprovalDecision,
  ApprovalItem,
  ConversationMessage,
  LearningEvent,
  Lead,
  NavPage,
  RunRecord,
  StrategicAnalysis,
  SuggestedReply
} from "./types.js";

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

const navAliases: Record<string, NavPage> = {
  "": "control-center",
  index: "control-center",
  dashboard: "agent-control-center",
  "agent-control-center": "agent-control-center",
  "control-center": "control-center",
  "mobile-app": "mobile-app",
  insights: "insights",
  forecast: "forecast",
  "whatsapp-intelligence": "whatsapp-intelligence",
  blueprint: "blueprint",
  "create-invoice": "create-invoice",
  "orders-payments": "orders-payments",
  appointments: "appointments",
  agents: "agents",
  runs: "runs",
  leads: "leads",
  "lead-workspace": "lead-workspace",
  approvals: "approvals",
  learning: "learning",
  "system-architecture-map": "system-architecture-map",
  "system-brain": "system-brain"
};

const quickNavItems: Array<{ id: NavPage; label: string }> = [
  { id: "control-center", label: "Control Center" },
  { id: "agent-control-center", label: "Dashboard" },
  { id: "leads", label: "Leads" },
  { id: "runs", label: "Runs" },
  { id: "approvals", label: "Approvals" },
  { id: "learning", label: "Learning" },
  { id: "system-brain", label: "System Brain" }
];

const externalModules: Partial<
  Record<
    NavPage,
    {
      title: string;
      subtitle: string;
      src: string;
    }
  >
> = {
  "mobile-app": {
    title: "Mobile App",
    subtitle: "Operational workspace for fast execution and operator workflows.",
    src: "/whatsapp-intelligence/mobile-lab"
  },
  insights: {
    title: "Insights",
    subtitle: "Business intelligence and analytics for strategic signals.",
    src: "/admin/insights"
  },
  forecast: {
    title: "Forecast",
    subtitle: "Revenue, demand and operational projections.",
    src: "/admin/forecast-v4"
  },
  "whatsapp-intelligence": {
    title: "WhatsApp Intelligence",
    subtitle: "Conversation analysis and operator guidance.",
    src: "/whatsapp-intelligence"
  },
  blueprint: {
    title: "Blueprint",
    subtitle: "System architecture view and application flow mapping.",
    src: "/blueprint"
  },
  "create-invoice": {
    title: "Create Invoice",
    subtitle: "Direct access to invoice generator and PDF preview.",
    src: "/admin/invoices"
  },
  "orders-payments": {
    title: "Orders & Payments",
    subtitle: "Visibility on orders, deposits, balances and payment status.",
    src: "/admin/invoices"
  },
  appointments: {
    title: "Appointments",
    subtitle: "Showroom scheduling, confirmations and reminders.",
    src: "/admin/appointments-v2"
  }
};

function withCurrentQuery(src: string): string {
  if (typeof window === "undefined") return src;
  const search = window.location.search;
  if (!search) return src;
  if (src.includes("?")) return `${src}&${search.slice(1)}`;
  return `${src}${search}`;
}

function readPageFromHash(): NavPage {
  if (typeof window === "undefined") return "control-center";
  const raw = window.location.hash.replace(/^#\/?/, "").trim();
  return navAliases[raw] ?? "control-center";
}

function internalPageMeta(page: NavPage): { title: string; subtitle: string } {
  if (page === "agent-control-center") {
    return {
      title: "Agent Control Center V1",
      subtitle: "AI operations cockpit for runs, validations, leads and system supervision."
    };
  }
  if (page === "runs") return { title: "Runs", subtitle: "Execution traces and intervention visibility." };
  if (page === "leads") return { title: "Leads", subtitle: "Lead intelligence and next actions." };
  if (page === "lead-workspace") return { title: "Lead Workspace", subtitle: "Conversation context and suggested actions." };
  if (page === "approvals") return { title: "Approvals", subtitle: "Human validation queue and pending decisions." };
  if (page === "learning") return { title: "Learning", subtitle: "Operator feedback and learning outcomes." };
  if (page === "system-architecture-map") return { title: "System Map", subtitle: "Architecture and orchestration topology." };
  if (page === "system-brain") return { title: "Mobile-Lab System Brain", subtitle: "Prompt, pipeline and execution oversight." };
  if (page === "agents") return { title: "Agents", subtitle: "Agent statuses, issues, and recent activity." };
  return { title: "Module", subtitle: "" };
}

export function App() {
  const [activePage, setActivePage] = useState<NavPage>(() => readPageFromHash());
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
    return presentCount === requiredKeys.length ? "live" : "mixed";
  }, [liveData]);

  const selectedLead = useMemo(
    () => leads.find((lead) => lead.id === selectedLeadId) ?? leads[0] ?? null,
    [selectedLeadId, leads]
  );
  const selectedLeadAnalysis = useMemo(() => {
    if (!selectedLead) return null;
    const mapped = strategicAnalyses.find((analysis) => analysis.leadId === selectedLead.id);
    if (mapped) return mapped;
    return generateStrategicAdvisorAnalysis({
      lead: selectedLead,
      conversation: {
        id: `wa-${selectedLead.id}`,
        label: `Conversation ${selectedLead.id}`
      },
      recentMessages: conversations.filter((message) => message.leadId === selectedLead.id).slice(-6),
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
        if (Array.isArray(payload.approvals)) setApprovals(payload.approvals);
      } catch (error) {
        if (cancelled) return;
        setLiveDataError(error instanceof Error ? error.message : "live_data_unavailable");
      }
    }

    void loadLiveData();
    const interval = window.setInterval(() => void loadLiveData(), 15000);
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
    const onHash = (): void => setActivePage(readPageFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  function openLeadWorkspace(leadId: string): void {
    setSelectedLeadId(leadId);
    navigateToPage("lead-workspace");
  }

  function handleApprovalDecision(id: string, decision: ApprovalDecision): void {
    setApprovals((prev) => prev.map((item) => (item.id === id ? { ...item, decision } : item)));
  }

  const externalModule = externalModules[activePage];
  const resolvedExternalModule = useMemo(() => {
    if (!externalModule) return null;
    return {
      ...externalModule,
      src: withCurrentQuery(externalModule.src)
    };
  }, [externalModule]);
  const internalMeta = internalPageMeta(activePage);
  const showControlCenter = activePage === "control-center";

  return (
    <AppShell>
      <PageContainer>
        <AppErrorBoundary onReset={() => navigateToPage("control-center")}>
          {liveDataError ? (
            <div className="mb-3 rounded-xl border border-amber-300/35 bg-amber-400/10 px-3 py-2 text-xs text-amber-100">
              Live Mobile-Lab feed unavailable ({liveDataError}). Showing fallback data.
            </div>
          ) : null}
          <div className="mb-3 flex items-center gap-2 text-[11px] text-slate-400">
            <span>
              Data source:
              <span className="ml-1 rounded bg-white/10 px-1.5 py-0.5 text-slate-200">
                {dataSourceMode === "live" ? "live" : dataSourceMode === "mixed" ? "mixed" : "mock_fallback"}
              </span>
            </span>
            {lastSyncAt ? (
              <span>
                Synced at <span className="text-slate-300">{new Date(lastSyncAt).toLocaleTimeString()}</span>
              </span>
            ) : null}
          </div>
          <div className="mb-4 flex gap-2 overflow-x-auto rounded-2xl border border-white/10 bg-white/[0.03] p-2">
            {quickNavItems.map((item) => {
              const active = activePage === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => navigateToPage(item.id)}
                  className={`shrink-0 rounded-xl px-3 py-2 text-xs font-medium transition ${
                    active
                      ? "bg-cyan-400/15 text-cyan-100 ring-1 ring-cyan-300/40"
                      : "text-slate-300 hover:bg-white/[0.06] hover:text-slate-100"
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </div>

          <AnimatePresence mode="wait">
            {showControlCenter ? (
              <ControlCenterPage key="page-control-center" onOpenPage={navigateToPage} data={appData} />
            ) : (
              <motion.div
                key={`page-${activePage}`}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.2, ease: "easeOut" }}
              >
                <ModulePageHeader
                  title={resolvedExternalModule?.title ?? internalMeta.title}
                  subtitle={resolvedExternalModule?.subtitle ?? internalMeta.subtitle}
                  onBack={() => navigateToPage("control-center")}
                />

                {resolvedExternalModule ? <ExternalModulePage src={resolvedExternalModule.src} /> : null}
                {activePage === "agent-control-center" ? (
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
              </motion.div>
            )}
          </AnimatePresence>
        </AppErrorBoundary>
      </PageContainer>
    </AppShell>
  );
}
