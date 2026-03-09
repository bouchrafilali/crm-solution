import { motion } from "framer-motion";
import { ApprovalItem, ApprovalDecision } from "../types.js";
import { byId } from "../mock-data.js";
import { StatusBadge } from "./StatusBadge.js";

interface ApprovalCardProps {
  item: ApprovalItem;
  onDecision: (id: string, decision: ApprovalDecision) => void;
}

export function ApprovalCard({ item, onDecision }: ApprovalCardProps) {
  return (
    <motion.article
      layout
      whileHover={{ y: -2 }}
      className="ml-panel ml-interactive rounded-2xl p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-slate-100">{byId.lead[item.leadId]?.name ?? item.leadId}</p>
        <StatusBadge value={item.urgency} />
      </div>
      <p className="mt-2 text-xs leading-relaxed text-slate-400">{item.reason}</p>
      <p className="ml-panel-soft mt-3 rounded-xl px-3 py-2 text-xs leading-relaxed text-slate-300">{item.contentPreview}</p>

      <div className="mt-3 flex items-center justify-between">
        <p className="text-[11px] text-slate-500">
          Requested by {byId.agent[item.requestedByAgentId]?.name ?? item.requestedByAgentId} at {item.requestedAt}
        </p>
        <StatusBadge value={item.decision} />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <button
          type="button"
          onClick={() => onDecision(item.id, "approved")}
          className="ml-button ml-button-primary rounded-lg px-2 py-1.5 font-medium"
        >
          Approve
        </button>
        <button
          type="button"
          onClick={() => onDecision(item.id, "approved")}
          className="ml-button rounded-lg px-2 py-1.5 font-medium"
        >
          Edit then approve
        </button>
        <button
          type="button"
          onClick={() => onDecision(item.id, "rejected")}
          className="ml-button ml-button-danger rounded-lg px-2 py-1.5 font-medium"
        >
          Reject
        </button>
        <button
          type="button"
          onClick={() => onDecision(item.id, "pending")}
          className="ml-button rounded-lg px-2 py-1.5 font-medium"
        >
          Ask context
        </button>
      </div>
    </motion.article>
  );
}
