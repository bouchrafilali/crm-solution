import { RunRecord } from "../types.js";
import { byId } from "../mock-data.js";
import { formatDurationMs } from "../utils.js";
import { StatusBadge } from "./StatusBadge.js";

interface RunTableProps {
  runs: RunRecord[];
  onSelect: (runId: string) => void;
  selectedRunId?: string | null;
}

export function RunTable({ runs, onSelect, selectedRunId = null }: RunTableProps) {
  return (
    <div className="ml-table-shell overflow-hidden rounded-2xl">
      <div className="max-h-[460px] overflow-x-auto overflow-y-auto scroll-dark">
        <table className="ml-table w-full min-w-[1080px] text-left text-xs">
          <thead className="sticky top-0 z-10">
            <tr>
              <th className="px-3 py-3 font-medium">Timestamp</th>
              <th className="px-3 py-3 font-medium">Event Type</th>
              <th className="px-3 py-3 font-medium">Lead</th>
              <th className="px-3 py-3 font-medium">Conversation</th>
              <th className="px-3 py-3 font-medium">Agent</th>
              <th className="px-3 py-3 font-medium">Decision Summary</th>
              <th className="px-3 py-3 font-medium">Status</th>
              <th className="px-3 py-3 font-medium">Duration</th>
              <th className="px-3 py-3 font-medium">Next Step</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr
                key={run.id}
                onClick={() => onSelect(run.id)}
                className={`cursor-pointer transition ${selectedRunId === run.id ? "bg-sky-500/12" : ""}`}
              >
                <td className="px-3 py-3 text-slate-400">{run.timestamp}</td>
                <td className="px-3 py-3 text-slate-300">{run.eventType.replaceAll("_", " ")}</td>
                <td className="px-3 py-3 font-medium text-slate-100">{byId.lead[run.leadId]?.name ?? run.leadId}</td>
                <td className="ml-code px-3 py-3 text-[11px] text-slate-400">{run.conversationId}</td>
                <td className="px-3 py-3 text-slate-200">{byId.agent[run.triggeredAgentId]?.name ?? run.triggeredAgentId}</td>
                <td className="max-w-[280px] truncate px-3 py-3 text-slate-300">{run.decisionSummary}</td>
                <td className="px-3 py-3">
                  <StatusBadge value={run.status} />
                </td>
                <td className="ml-code px-3 py-3 text-[11px] text-slate-400">{formatDurationMs(run.durationMs)}</td>
                <td className="max-w-[220px] truncate px-3 py-3 text-slate-300">{run.nextStep}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
