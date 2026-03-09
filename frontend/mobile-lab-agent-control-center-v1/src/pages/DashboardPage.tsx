import { motion } from "framer-motion";
import { AppMockData } from "../types.js";
import { MetricCard } from "../components/MetricCard.js";
import { SectionHeader } from "../components/SectionHeader.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { byId } from "../mock-data.js";

interface DashboardPageProps {
  data: AppMockData;
  onOpenLead: (leadId: string) => void;
}

const cardAnimation = {
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.25 }
};

export function DashboardPage({ data, onOpenLead }: DashboardPageProps) {
  const activeAgents = data.agents.filter((agent) => agent.status === "running").length;
  const pendingApprovals = data.approvals.filter((approval) => approval.decision === "pending").length;
  const highPriorityLeads = data.leads.filter((lead) => lead.priorityScore >= 85).length;
  const blockedFlows = data.runs.filter((run) => run.status === "blocked" || run.status === "error").length;
  const runsToday = data.runs.length;
  const learningEventsToday = data.learningEvents.length;
  const highPriorityQueue = data.leads
    .filter((lead) => lead.priorityScore >= 85)
    .sort((a, b) => b.priorityScore - a.priorityScore)
    .slice(0, 5);

  return (
    <motion.div key="dashboard" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <SectionHeader
        title="Dashboard"
        subtitle="Live command view of agents, lead urgency, blockers, and human interventions."
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        <MetricCard label="Active Agents" value={activeAgents} delta="Live" tone="good" />
        <MetricCard label="Runs Today" value={runsToday} delta="+12% vs yesterday" tone="neutral" />
        <MetricCard label="Pending Approvals" value={pendingApprovals} delta="Needs attention" tone="attention" />
        <MetricCard label="High Priority Leads" value={highPriorityLeads} delta="Queue hot" tone="attention" />
        <MetricCard label="Blocked Flows" value={blockedFlows} delta={blockedFlows > 0 ? "Investigate" : "Clear"} tone="attention" />
        <MetricCard label="Learning Events Today" value={learningEventsToday} delta="Auto-captured" tone="good" />
      </div>

      <div className="mt-6 grid gap-4 xl:grid-cols-[1.45fr_1fr]">
        <motion.section {...cardAnimation} className="ml-panel rounded-2xl p-4">
          <SectionHeader title="System Activity Feed" subtitle="Chronological events across orchestrations, approvals, and learning." />
          <div className="space-y-2">
            {data.activityFeed.map((event) => (
              <button
                key={event.id}
                type="button"
                onClick={() => onOpenLead(event.leadId)}
                className="ml-panel-soft ml-interactive w-full rounded-xl p-3 text-left"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium text-slate-100">{event.title}</p>
                  <span className="ml-code text-[11px] text-slate-500">{event.timestamp}</span>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-slate-400">{event.detail}</p>
              </button>
            ))}
          </div>
        </motion.section>

        <div className="space-y-4">
          <motion.section {...cardAnimation} className="ml-panel rounded-2xl p-4">
            <SectionHeader title="Pending Approvals Snapshot" subtitle="Items requiring operator decision." />
            <div className="space-y-2">
              {data.approvals.map((approval) => (
                <button
                  key={approval.id}
                  type="button"
                  onClick={() => onOpenLead(approval.leadId)}
                  className="ml-panel-soft ml-interactive w-full rounded-xl p-3 text-left"
                >
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium text-slate-200">{byId.lead[approval.leadId]?.name ?? approval.leadId}</p>
                    <StatusBadge value={approval.urgency} />
                  </div>
                  <p className="mt-1 text-xs text-slate-500">{approval.group}</p>
                </button>
              ))}
            </div>
          </motion.section>

          <motion.section {...cardAnimation} className="ml-panel rounded-2xl p-4">
            <SectionHeader title="Recent Learning Events" subtitle="AI-to-human correction samples." />
            <div className="space-y-2">
              {data.learningEvents.slice(0, 3).map((event) => (
                <button
                  key={event.id}
                  type="button"
                  onClick={() => onOpenLead(event.leadId)}
                  className="ml-panel-soft ml-interactive w-full rounded-xl p-3 text-left"
                >
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium text-slate-200">{event.correctionPattern}</p>
                    <span className="ml-code text-[11px] text-slate-500">{event.timestamp}</span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">{event.deltaSummary}</p>
                </button>
              ))}
            </div>
          </motion.section>
        </div>
      </div>

      <motion.section {...cardAnimation} className="ml-panel mt-4 rounded-2xl p-4">
        <SectionHeader title="High Priority Queue" subtitle="Urgent leads with recommended next action and approval state." />
        <div className="ml-table-shell overflow-x-auto rounded-xl">
          <table className="ml-table w-full min-w-[980px] text-left text-xs">
            <thead>
              <tr>
                <th className="px-3 py-3">Lead</th>
                <th className="px-3 py-3">Stage</th>
                <th className="px-3 py-3">Priority Score</th>
                <th className="px-3 py-3">Last Inbound</th>
                <th className="px-3 py-3">Next Best Action</th>
                <th className="px-3 py-3">Approval Status</th>
              </tr>
            </thead>
            <tbody>
              {highPriorityQueue.map((lead) => (
                <tr
                  key={lead.id}
                  onClick={() => onOpenLead(lead.id)}
                  className="cursor-pointer transition"
                >
                  <td className="px-3 py-3 font-semibold text-slate-100">{lead.name}</td>
                  <td className="px-3 py-3 text-slate-400">{lead.currentStage}</td>
                  <td className="px-3 py-3 text-slate-300">{lead.priorityScore}</td>
                  <td className="max-w-[280px] truncate px-3 py-3 text-slate-400">{lead.lastMessage}</td>
                  <td className="max-w-[300px] truncate px-3 py-3 text-slate-300">{lead.nextBestAction}</td>
                  <td className="px-3 py-3">
                    {lead.approvalStatus === "none" ? <span className="text-slate-500">No gate</span> : <StatusBadge value={lead.approvalStatus} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </motion.section>
    </motion.div>
  );
}
