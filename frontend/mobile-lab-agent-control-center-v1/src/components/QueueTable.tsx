import { Lead } from "../types.js";
import { StatusBadge } from "./StatusBadge.js";

interface QueueTableProps {
  leads: Lead[];
  onOpenLead: (leadId: string) => void;
}

export function QueueTable({ leads, onOpenLead }: QueueTableProps) {
  return (
    <div className="ml-table-shell overflow-hidden rounded-xl">
      <div className="max-h-[360px] overflow-y-auto scroll-dark">
        <table className="ml-table w-full min-w-[980px] text-left text-xs">
          <thead className="sticky top-0 z-10">
            <tr>
              <th className="px-3 py-3">Lead</th>
              <th className="px-3 py-3">Stage</th>
              <th className="px-3 py-3">Priority</th>
              <th className="px-3 py-3">Last Message</th>
              <th className="px-3 py-3">Next Best Action</th>
              <th className="px-3 py-3">Approval</th>
            </tr>
          </thead>
          <tbody>
            {leads.map((lead) => (
              <tr key={lead.id} className="cursor-pointer transition" onClick={() => onOpenLead(lead.id)}>
                <td className="px-3 py-3 font-semibold text-slate-100">{lead.name}</td>
                <td className="px-3 py-3 text-slate-400">{lead.currentStage}</td>
                <td className="px-3 py-3">
                  <span className="ml-chip rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-300">
                    {lead.priorityScore}
                  </span>
                </td>
                <td className="max-w-[250px] truncate px-3 py-3 text-slate-400">{lead.lastMessage}</td>
                <td className="max-w-[290px] truncate px-3 py-3 text-slate-300">{lead.nextBestAction}</td>
                <td className="px-3 py-3">
                  {lead.approvalStatus === "none" ? <span className="text-slate-500">No gate</span> : <StatusBadge value={lead.approvalStatus} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
