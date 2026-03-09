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
      className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-4 shadow-[0_8px_24px_-14px_rgba(0,0,0,0.8)]"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-zinc-100">{byId.lead[item.leadId]?.name ?? item.leadId}</p>
        <StatusBadge value={item.urgency} />
      </div>
      <p className="mt-2 text-xs text-zinc-400">{item.reason}</p>
      <p className="mt-3 rounded-xl border border-zinc-800 bg-zinc-950/80 px-3 py-2 text-xs text-zinc-300">{item.contentPreview}</p>

      <div className="mt-3 flex items-center justify-between">
        <p className="text-[11px] text-zinc-500">
          Requested by {byId.agent[item.requestedByAgentId]?.name ?? item.requestedByAgentId} at {item.requestedAt}
        </p>
        <StatusBadge value={item.decision} />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <button
          type="button"
          onClick={() => onDecision(item.id, "approved")}
          className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2 py-1.5 text-emerald-200 transition hover:bg-emerald-500/20"
        >
          Approve
        </button>
        <button
          type="button"
          onClick={() => onDecision(item.id, "approved")}
          className="rounded-lg border border-zinc-700 bg-zinc-800/80 px-2 py-1.5 text-zinc-200 transition hover:border-zinc-600"
        >
          Edit then approve
        </button>
        <button
          type="button"
          onClick={() => onDecision(item.id, "rejected")}
          className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-2 py-1.5 text-rose-200 transition hover:bg-rose-500/20"
        >
          Reject
        </button>
        <button
          type="button"
          onClick={() => onDecision(item.id, "pending")}
          className="rounded-lg border border-zinc-700 bg-zinc-800/80 px-2 py-1.5 text-zinc-200 transition hover:border-zinc-600"
        >
          Ask context
        </button>
      </div>
    </motion.article>
  );
}
