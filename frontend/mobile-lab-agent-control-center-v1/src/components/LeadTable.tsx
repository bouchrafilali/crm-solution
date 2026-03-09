import { Lead } from "../types.js";
import { formatCurrency } from "../utils.js";
import { StatusBadge } from "./StatusBadge.js";

interface LeadTableProps {
  leads: Lead[];
  onOpenLead: (leadId: string) => void;
}

export function LeadTable({ leads, onOpenLead }: LeadTableProps) {
  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/80">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1200px] text-left text-xs">
          <thead className="bg-zinc-950/80 text-zinc-500">
            <tr>
              <th className="px-3 py-2 font-medium">Lead</th>
              <th className="px-3 py-2 font-medium">Country</th>
              <th className="px-3 py-2 font-medium">Language</th>
              <th className="px-3 py-2 font-medium">Current Stage</th>
              <th className="px-3 py-2 font-medium">Priority</th>
              <th className="px-3 py-2 font-medium">Est. Value</th>
              <th className="px-3 py-2 font-medium">Event Date</th>
              <th className="px-3 py-2 font-medium">Last Message</th>
              <th className="px-3 py-2 font-medium">Assigned Operator</th>
              <th className="px-3 py-2 font-medium">Next Best Action</th>
              <th className="px-3 py-2 font-medium">Approval</th>
            </tr>
          </thead>
          <tbody>
            {leads.map((lead) => (
              <tr
                key={lead.id}
                onClick={() => onOpenLead(lead.id)}
                className="cursor-pointer border-t border-zinc-800 text-zinc-300 transition hover:bg-zinc-800/50"
              >
                <td className="px-3 py-2 font-medium text-zinc-100">{lead.name}</td>
                <td className="px-3 py-2">{lead.country}</td>
                <td className="px-3 py-2">{lead.language}</td>
                <td className="px-3 py-2 text-zinc-400">{lead.currentStage}</td>
                <td className="px-3 py-2">
                  <StatusBadge
                    value={lead.priorityScore >= 90 ? "high" : lead.priorityScore >= 75 ? "medium" : "low"}
                    className="!text-[10px]"
                  />
                </td>
                <td className="px-3 py-2">{formatCurrency(lead.estimatedValue)}</td>
                <td className="px-3 py-2 text-zinc-400">{lead.eventDate}</td>
                <td className="max-w-[220px] truncate px-3 py-2 text-zinc-400">{lead.lastMessage}</td>
                <td className="px-3 py-2">{lead.assignedOperator}</td>
                <td className="max-w-[230px] truncate px-3 py-2">{lead.nextBestAction}</td>
                <td className="px-3 py-2">
                  {lead.approvalStatus === "none" ? <span className="text-zinc-500">No gate</span> : <StatusBadge value={lead.approvalStatus} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
