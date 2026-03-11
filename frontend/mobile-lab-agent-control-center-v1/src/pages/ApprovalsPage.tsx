import { motion } from "framer-motion";
import { Agent, ApprovalDecision, ApprovalGroup, ApprovalItem, Lead } from "../types.js";
import { ApprovalCard } from "../components/ApprovalCard.js";
import { SectionHeader } from "../components/SectionHeader.js";

interface ApprovalsPageProps {
  approvals: ApprovalItem[];
  leads: Lead[];
  agents: Agent[];
  onDecision: (id: string, decision: ApprovalDecision) => void;
}

const groups: ApprovalGroup[] = [
  "Waiting Price Approval",
  "Waiting Reply Approval",
  "Waiting Missing Info",
  "Waiting Sensitive Action Approval"
];

export function ApprovalsPage({ approvals, leads, agents, onDecision }: ApprovalsPageProps) {
  const leadById = new Map(leads.map((lead) => [lead.id, lead]));
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  return (
    <motion.div key="approvals" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <SectionHeader
        title="Approvals"
        subtitle="Centralized human validation center for high-risk or policy-gated actions."
      />

      <div className="grid gap-4 xl:grid-cols-2 2xl:grid-cols-4">
        {groups.map((group) => {
          const items = approvals.filter((item) => item.group === group);

          return (
            <section key={group} className="ml-panel rounded-2xl p-4">
              <h3 className="text-sm font-semibold text-slate-100">{group}</h3>
              <p className="mt-1 text-xs text-slate-500">{items.length} item(s)</p>
              <div className="mt-3 space-y-3">
                {items.map((item) => (
                  <ApprovalCard
                    key={item.id}
                    item={item}
                    leadName={leadById.get(item.leadId)?.name}
                    requestedByName={agentById.get(item.requestedByAgentId)?.name}
                    onDecision={onDecision}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </motion.div>
  );
}
