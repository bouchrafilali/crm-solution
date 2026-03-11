import { motion } from "framer-motion";
import { AppMockData } from "../types.js";
import { MetricCard } from "../components/MetricCard.js";
import { SectionHeader } from "../components/SectionHeader.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { ActivityFeed } from "../components/ActivityFeed.js";
import { QueueTable } from "../components/QueueTable.js";
import { ApprovalMiniCard } from "../components/ApprovalMiniCard.js";
import { LearningEventCard } from "../components/LearningEventCard.js";

interface DashboardPageProps {
  data: AppMockData;
  onOpenLead: (leadId: string) => void;
}

const cardAnimation = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.22 }
};

export function DashboardPage({ data, onOpenLead }: DashboardPageProps) {
  const leadById = new Map(data.leads.map((lead) => [lead.id, lead]));
  const agentById = new Map(data.agents.map((agent) => [agent.id, agent]));
  const activeAgents = data.agents.filter((agent) => agent.status === "running").length;
  const pendingApprovals = data.approvals.filter((approval) => approval.decision === "pending").length;
  const highPriorityLeads = data.leads.filter((lead) => lead.priorityScore >= 85).length;
  const blockedFlows = data.runs.filter((run) => run.status === "blocked" || run.status === "error").length;
  const runsToday = data.runs.length;
  const learningEventsToday = data.learningEvents.length;

  const highPriorityQueue = data.leads
    .filter((lead) => lead.priorityScore >= 85)
    .sort((a, b) => b.priorityScore - a.priorityScore)
    .slice(0, 6);

  const criticalApprovals = data.approvals
    .filter((approval) => approval.decision === "pending")
    .sort((a, b) => (a.urgency === b.urgency ? 0 : a.urgency === "high" ? -1 : 1))
    .slice(0, 4);

  const recentLearning = data.learningEvents.slice(0, 3);

  return (
    <motion.div key="dashboard" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <SectionHeader
        title="Dashboard"
        subtitle="Mission control overview for agent health, lead urgency, human approvals, and live system activity."
      />

      <div className="ml-panel mb-4 flex flex-wrap items-center gap-2 rounded-2xl px-3 py-2.5 text-xs">
        <span className="ml-chip rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-emerald-200">System Stable</span>
        <span className="ml-chip rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-300">Ops Window 08:00-22:00</span>
        <span className="ml-chip rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-300">Luxury WhatsApp Sales</span>
        <span className="ml-auto text-slate-500">Last sync: <span className="ml-code text-slate-400">2026-03-09 08:42</span></span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        <MetricCard label="Active Agents" value={activeAgents} delta="Live" tone="good" />
        <MetricCard label="Runs Today" value={runsToday} delta="Execution trace healthy" tone="neutral" />
        <MetricCard label="Pending Approvals" value={pendingApprovals} delta="Human queue" tone="attention" />
        <MetricCard label="High Priority Leads" value={highPriorityLeads} delta="Commercial focus" tone="attention" />
        <MetricCard label="Blocked Flows" value={blockedFlows} delta={blockedFlows > 0 ? "Needs intervention" : "No blockers"} tone="attention" />
        <MetricCard label="Learning Events Today" value={learningEventsToday} delta="Feedback active" tone="good" />
      </div>

      <div className="mt-6 grid gap-4 xl:grid-cols-[1.6fr_1fr]">
        <motion.section {...cardAnimation} className="ml-panel rounded-2xl p-4">
          <SectionHeader
            title="System Activity Feed"
            subtitle="Chronological operations log with event type, lead context, agent source, and status."
            action={<StatusBadge value={blockedFlows > 0 ? "blocked" : "success"} />}
          />

          <ActivityFeed events={data.activityFeed} runs={data.runs} leads={data.leads} agents={data.agents} onOpenLead={onOpenLead} />
        </motion.section>

        <div className="space-y-4">
          <motion.section {...cardAnimation} className="ml-panel rounded-2xl p-4">
            <SectionHeader title="Pending Approvals Snapshot" subtitle="Highest urgency approvals requiring immediate operator review." />
            <div className="space-y-2">
              {criticalApprovals.map((approval) => (
                <ApprovalMiniCard
                  key={approval.id}
                  item={approval}
                  leadName={leadById.get(approval.leadId)?.name}
                  requestedByName={agentById.get(approval.requestedByAgentId)?.name}
                  onOpenLead={onOpenLead}
                />
              ))}
            </div>
          </motion.section>

          <motion.section {...cardAnimation} className="ml-panel rounded-2xl p-4">
            <SectionHeader title="Recent Learning Events" subtitle="Latest AI-to-human corrections and quality deltas." />
            <div className="space-y-2">
              {recentLearning.map((event) => (
                <LearningEventCard key={event.id} event={event} leadName={leadById.get(event.leadId)?.name} onOpenLead={onOpenLead} />
              ))}
            </div>
          </motion.section>
        </div>
      </div>

      <motion.section {...cardAnimation} className="ml-panel mt-4 rounded-2xl p-4">
        <SectionHeader
          title="High Priority Queue"
          subtitle="Urgent leads with stage, message context, next action, and approval readiness."
        />
        <QueueTable leads={highPriorityQueue} onOpenLead={onOpenLead} />
      </motion.section>
    </motion.div>
  );
}
