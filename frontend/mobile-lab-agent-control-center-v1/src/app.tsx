import { AnimatePresence, motion } from "framer-motion";
import { useMemo, useState } from "react";
import { mockData } from "./mock-data.js";
import { ApprovalDecision, NavPage } from "./types.js";
import { DashboardPage } from "./pages/DashboardPage.js";
import { AgentsPage } from "./pages/AgentsPage.js";
import { RunsPage } from "./pages/RunsPage.js";
import { LeadsPage } from "./pages/LeadsPage.js";
import { LeadWorkspacePage } from "./pages/LeadWorkspacePage.js";
import { ApprovalsPage } from "./pages/ApprovalsPage.js";
import { LearningPage } from "./pages/LearningPage.js";
import { cn, initials } from "./utils.js";

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
  { id: "learning", label: "Learning" }
];

export function App() {
  const [activePage, setActivePage] = useState<NavPage>("dashboard");
  const [selectedLeadId, setSelectedLeadId] = useState(mockData.leads[0]?.id ?? "");
  const [approvals, setApprovals] = useState(mockData.approvals);

  const selectedLead = useMemo(() => mockData.leads.find((lead) => lead.id === selectedLeadId) ?? mockData.leads[0], [selectedLeadId]);
  const selectedLeadAnalysis = useMemo(() => {
    const mapped = mockData.strategicAnalyses.find((analysis) => analysis.leadId === selectedLead?.id);
    if (mapped) return mapped;
    return {
      leadId: selectedLead.id,
      probableStage: selectedLead.currentStage,
      keySignals: selectedLead.detectedSignals,
      risks: selectedLead.missingFields.length ? [`Missing fields: ${selectedLead.missingFields.join(", ")}`] : ["No major policy risk detected"],
      opportunities: ["Move conversation to a single clear next step", "Use concise conversion wording"],
      nextBestAction: selectedLead.nextBestAction
    };
  }, [selectedLead]);
  const selectedLeadReplies = useMemo(
    () => mockData.suggestedReplies.filter((reply) => reply.leadId === selectedLead?.id),
    [selectedLead]
  );

  function openLeadWorkspace(leadId: string): void {
    setSelectedLeadId(leadId);
    setActivePage("lead-workspace");
  }

  function handleApprovalDecision(id: string, decision: ApprovalDecision): void {
    setApprovals((prev) => prev.map((item) => (item.id === id ? { ...item, decision } : item)));
  }

  return (
    <div className="min-h-screen bg-[#07090f] text-zinc-100">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_14%_18%,rgba(56,189,248,0.08),transparent_36%),radial-gradient(circle_at_88%_0%,rgba(34,197,94,0.06),transparent_30%)]" />
      <div className="relative flex min-h-screen">
        <aside className="sticky top-0 hidden h-screen w-72 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950/90 p-5 lg:flex">
          <div>
            <p className="text-[11px] uppercase tracking-[0.18em] text-cyan-300">Mobile-Lab</p>
            <h1 className="mt-2 text-lg font-semibold tracking-tight text-zinc-100">Agent Control Center V1</h1>
            <p className="mt-1 text-xs text-zinc-500">Mission Control for AI-powered WhatsApp sales operations.</p>
          </div>

          <nav className="mt-6 space-y-1">
            {sidebarItems.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setActivePage(item.id)}
                className={cn(
                  "flex w-full items-center justify-between rounded-xl px-3 py-2 text-sm transition",
                  activePage === item.id
                    ? "border border-cyan-400/30 bg-cyan-500/10 text-cyan-100"
                    : "border border-transparent text-zinc-300 hover:border-zinc-800 hover:bg-zinc-900"
                )}
              >
                <span>{item.label}</span>
                {item.id === "approvals" ? (
                  <span className="rounded-md border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-[11px] text-zinc-400">
                    {approvals.filter((item) => item.decision === "pending").length}
                  </span>
                ) : null}
              </button>
            ))}
          </nav>

          <div className="mt-auto space-y-3 rounded-2xl border border-zinc-800 bg-zinc-900/70 p-3 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-zinc-500">System status</span>
              <span className="inline-flex items-center gap-1 text-emerald-300">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" />
                Stable
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-zinc-500">Environment</span>
              <span className="text-zinc-300">Production Sim</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-zinc-500">Operator</span>
              <span className="inline-flex items-center gap-2 text-zinc-300">
                <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-zinc-700 bg-zinc-800 text-[10px]">
                  {initials("Meryem Lahlou")}
                </span>
                Meryem Lahlou
              </span>
            </div>
          </div>
        </aside>

        <main className="w-full px-4 pb-6 pt-4 sm:px-6 lg:px-8">
          <div className="mb-4 flex items-center justify-between rounded-2xl border border-zinc-800 bg-zinc-900/70 px-4 py-3 lg:hidden">
            <div>
              <p className="text-[10px] uppercase tracking-[0.16em] text-cyan-300">Mobile-Lab</p>
              <p className="text-sm font-semibold">Agent Control Center V1</p>
            </div>
            <select
              value={activePage === "lead-workspace" ? "leads" : activePage}
              onChange={(event) => setActivePage(event.target.value as NavPage)}
              className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs"
            >
              {sidebarItems.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>

          <AnimatePresence mode="wait">
            {activePage === "dashboard" ? <DashboardPage key="page-dashboard" data={{ ...mockData, approvals }} onOpenLead={openLeadWorkspace} /> : null}
            {activePage === "agents" ? <AgentsPage key="page-agents" agents={mockData.agents} /> : null}
            {activePage === "runs" ? (
              <RunsPage key="page-runs" runs={mockData.runs} leads={mockData.leads} agents={mockData.agents} onOpenLead={openLeadWorkspace} />
            ) : null}
            {activePage === "leads" ? <LeadsPage key="page-leads" leads={mockData.leads} onOpenLead={openLeadWorkspace} /> : null}
            {activePage === "lead-workspace" && selectedLead && selectedLeadAnalysis ? (
              <LeadWorkspacePage
                key={`page-workspace-${selectedLead.id}`}
                lead={selectedLead}
                analysis={selectedLeadAnalysis}
                suggestedReplies={selectedLeadReplies}
                runs={mockData.runs}
                learningEvents={mockData.learningEvents}
                messages={mockData.conversations}
                onBackToLeads={() => setActivePage("leads")}
              />
            ) : null}
            {activePage === "approvals" ? <ApprovalsPage key="page-approvals" approvals={approvals} onDecision={handleApprovalDecision} /> : null}
            {activePage === "learning" ? <LearningPage key="page-learning" learningEvents={mockData.learningEvents} /> : null}
          </AnimatePresence>
        </main>
      </div>
    </div>
  );
}
