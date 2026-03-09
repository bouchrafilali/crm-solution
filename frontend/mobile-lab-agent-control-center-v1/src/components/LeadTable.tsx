import { Lead } from "../types.js";
import { formatCurrency } from "../utils.js";
import { StatusBadge } from "./StatusBadge.js";

interface LeadTableProps {
  leads: Lead[];
  onOpenLead: (leadId: string) => void;
}

export function LeadTable({ leads, onOpenLead }: LeadTableProps) {
  return (
    <div className="ml-table-shell overflow-hidden rounded-2xl">
      <div className="max-h-[520px] overflow-x-auto overflow-y-auto scroll-dark">
        <table className="ml-table w-full min-w-[1200px] text-left text-xs">
          <thead className="sticky top-0 z-10">
            <tr>
              <th className="px-3 py-3 font-medium">Lead</th>
              <th className="px-3 py-3 font-medium">Country</th>
              <th className="px-3 py-3 font-medium">Language</th>
              <th className="px-3 py-3 font-medium">Current Stage</th>
              <th className="px-3 py-3 font-medium">Priority</th>
              <th className="px-3 py-3 font-medium">Est. Value</th>
              <th className="px-3 py-3 font-medium">Event Date</th>
              <th className="px-3 py-3 font-medium">Last Message</th>
              <th className="px-3 py-3 font-medium">Assigned Operator</th>
              <th className="px-3 py-3 font-medium">Next Best Action</th>
              <th className="px-3 py-3 font-medium">Approval</th>
            </tr>
          </thead>
          <tbody>
            {leads.map((lead) => (
              <tr
                key={lead.id}
                onClick={() => onOpenLead(lead.id)}
                className="cursor-pointer transition"
              >
                <td className="px-3 py-3 font-semibold text-slate-100">{lead.name}</td>
                <td className="px-3 py-3 text-slate-300">{lead.country}</td>
                <td className="px-3 py-3 text-slate-300">{lead.language}</td>
                <td className="px-3 py-3 text-slate-400">{lead.currentStage}</td>
                <td className="px-3 py-3">
                  <StatusBadge
                    value={lead.priorityScore >= 90 ? "high" : lead.priorityScore >= 75 ? "medium" : "low"}
                    className="!text-[10px]"
                  />
                </td>
                <td className="px-3 py-3 font-medium text-slate-200">{formatCurrency(lead.estimatedValue)}</td>
                <td className="px-3 py-3 text-slate-400">{lead.eventDate}</td>
                <td className="max-w-[220px] truncate px-3 py-3 text-slate-400">{lead.lastMessage}</td>
                <td className="px-3 py-3 text-slate-300">{lead.assignedOperator}</td>
                <td className="max-w-[230px] truncate px-3 py-3 text-slate-300">{lead.nextBestAction}</td>
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
