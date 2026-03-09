import { RunRecord } from "../types.js";
import { byId } from "../mock-data.js";
import { formatDurationMs } from "../utils.js";
import { StatusBadge } from "./StatusBadge.js";

interface RunTableProps {
  runs: RunRecord[];
  onSelect: (runId: string) => void;
}

export function RunTable({ runs, onSelect }: RunTableProps) {
  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/80">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1080px] text-left text-xs">
          <thead className="bg-zinc-950/80 text-zinc-500">
            <tr>
              <th className="px-3 py-2 font-medium">Timestamp</th>
              <th className="px-3 py-2 font-medium">Event Type</th>
              <th className="px-3 py-2 font-medium">Lead</th>
              <th className="px-3 py-2 font-medium">Conversation</th>
              <th className="px-3 py-2 font-medium">Agent</th>
              <th className="px-3 py-2 font-medium">Decision Summary</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Duration</th>
              <th className="px-3 py-2 font-medium">Next Step</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr
                key={run.id}
                onClick={() => onSelect(run.id)}
                className="cursor-pointer border-t border-zinc-800 text-zinc-300 transition hover:bg-zinc-800/50"
              >
                <td className="px-3 py-2 text-zinc-400">{run.timestamp}</td>
                <td className="px-3 py-2">{run.eventType.replaceAll("_", " ")}</td>
                <td className="px-3 py-2">{byId.lead[run.leadId]?.name ?? run.leadId}</td>
                <td className="px-3 py-2 text-zinc-400">{run.conversationId}</td>
                <td className="px-3 py-2">{byId.agent[run.triggeredAgentId]?.name ?? run.triggeredAgentId}</td>
                <td className="max-w-[280px] truncate px-3 py-2 text-zinc-300">{run.decisionSummary}</td>
                <td className="px-3 py-2">
                  <StatusBadge value={run.status} />
                </td>
                <td className="px-3 py-2 text-zinc-400">{formatDurationMs(run.durationMs)}</td>
                <td className="max-w-[220px] truncate px-3 py-2">{run.nextStep}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
