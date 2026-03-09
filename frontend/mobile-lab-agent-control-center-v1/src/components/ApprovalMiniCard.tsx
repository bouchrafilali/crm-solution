import { ApprovalItem } from "../types.js";
import { byId } from "../mock-data.js";
import { StatusBadge } from "./StatusBadge.js";

interface ApprovalMiniCardProps {
  item: ApprovalItem;
  onOpenLead: (leadId: string) => void;
}

export function ApprovalMiniCard({ item, onOpenLead }: ApprovalMiniCardProps) {
  return (
    <button
      type="button"
      onClick={() => onOpenLead(item.leadId)}
      className="ml-panel-soft ml-interactive w-full rounded-xl p-3 text-left"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-slate-100">{byId.lead[item.leadId]?.name ?? item.leadId}</p>
        <StatusBadge value={item.urgency} />
      </div>

      <p className="mt-1 text-xs leading-relaxed text-slate-400">{item.reason}</p>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
        <span>Requested by {byId.agent[item.requestedByAgentId]?.name ?? item.requestedByAgentId}</span>
        <span className="ml-code">{item.requestedAt}</span>
      </div>
    </button>
  );
}
