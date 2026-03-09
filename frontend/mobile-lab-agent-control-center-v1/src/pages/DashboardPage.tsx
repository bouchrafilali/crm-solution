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
        <motion.section {...cardAnimation} className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-4">
          <SectionHeader title="System Activity Feed" subtitle="Chronological events across orchestrations, approvals, and learning." />
          <div className="space-y-2">
            {data.activityFeed.map((event) => (
              <button
                key={event.id}
                type="button"
                onClick={() => onOpenLead(event.leadId)}
                className="w-full rounded-xl border border-zinc-800 bg-zinc-950/70 p-3 text-left transition hover:border-zinc-700"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium text-zinc-100">{event.title}</p>
                  <span className="text-xs text-zinc-500">{event.timestamp}</span>
                </div>
                <p className="mt-1 text-xs text-zinc-400">{event.detail}</p>
              </button>
            ))}
          </div>
        </motion.section>

        <div className="space-y-4">
          <motion.section {...cardAnimation} className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-4">
            <SectionHeader title="Pending Approvals Snapshot" subtitle="Items requiring operator decision." />
            <div className="space-y-2">
              {data.approvals.map((approval) => (
                <button
                  key={approval.id}
                  type="button"
                  onClick={() => onOpenLead(approval.leadId)}
                  className="w-full rounded-xl border border-zinc-800 bg-zinc-950/70 p-3 text-left transition hover:border-zinc-700"
                >
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-zinc-200">{byId.lead[approval.leadId]?.name ?? approval.leadId}</p>
                    <StatusBadge value={approval.urgency} />
                  </div>
                  <p className="mt-1 text-xs text-zinc-500">{approval.group}</p>
                </button>
              ))}
            </div>
          </motion.section>

          <motion.section {...cardAnimation} className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-4">
            <SectionHeader title="Recent Learning Events" subtitle="AI-to-human correction samples." />
            <div className="space-y-2">
              {data.learningEvents.slice(0, 3).map((event) => (
                <button
                  key={event.id}
                  type="button"
                  onClick={() => onOpenLead(event.leadId)}
                  className="w-full rounded-xl border border-zinc-800 bg-zinc-950/70 p-3 text-left transition hover:border-zinc-700"
                >
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-zinc-200">{event.correctionPattern}</p>
                    <span className="text-xs text-zinc-500">{event.timestamp}</span>
                  </div>
                  <p className="mt-1 text-xs text-zinc-500">{event.deltaSummary}</p>
                </button>
              ))}
            </div>
          </motion.section>
        </div>
      </div>

      <motion.section {...cardAnimation} className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900/80 p-4">
        <SectionHeader title="High Priority Queue" subtitle="Urgent leads with recommended next action and approval state." />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-left text-xs">
            <thead className="text-zinc-500">
              <tr>
                <th className="py-2">Lead</th>
                <th className="py-2">Stage</th>
                <th className="py-2">Priority Score</th>
                <th className="py-2">Last Inbound</th>
                <th className="py-2">Next Best Action</th>
                <th className="py-2">Approval Status</th>
              </tr>
            </thead>
            <tbody>
              {highPriorityQueue.map((lead) => (
                <tr
                  key={lead.id}
                  onClick={() => onOpenLead(lead.id)}
                  className="cursor-pointer border-t border-zinc-800 text-zinc-300 transition hover:bg-zinc-800/50"
                >
                  <td className="py-2 font-medium text-zinc-100">{lead.name}</td>
                  <td className="py-2 text-zinc-400">{lead.currentStage}</td>
                  <td className="py-2">{lead.priorityScore}</td>
                  <td className="max-w-[280px] truncate py-2 text-zinc-400">{lead.lastMessage}</td>
                  <td className="max-w-[300px] truncate py-2">{lead.nextBestAction}</td>
                  <td className="py-2">
                    {lead.approvalStatus === "none" ? <span className="text-zinc-500">No gate</span> : <StatusBadge value={lead.approvalStatus} />}
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
