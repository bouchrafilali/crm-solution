import { RunRecord } from "../types.js";
import { byId } from "../mock-data.js";
import { cn, formatDurationMs } from "../utils.js";
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
                className={cn(
                  "group cursor-pointer transition",
                  selectedRunId === run.id
                    ? "bg-sky-500/12 shadow-[inset_2px_0_0_rgba(125,211,252,0.85)]"
                    : "hover:bg-slate-800/45"
                )}
              >
                <td className="px-3 py-3 align-top text-slate-400">
                  <p className="ml-code text-[11px]">{run.timestamp}</p>
                  <p className="mt-1 text-[10px] uppercase tracking-[0.11em] text-slate-500">{run.id}</p>
                </td>
                <td className="px-3 py-3 align-top text-slate-300">
                  <p className="font-medium text-slate-200">{run.eventType.replaceAll("_", " ")}</p>
                  <p className="mt-1 text-[10px] uppercase tracking-[0.11em] text-slate-500">{run.priority} priority</p>
                </td>
                <td className="px-3 py-3 align-top">
                  <p className="font-medium text-slate-100">{byId.lead[run.leadId]?.name ?? run.leadId}</p>
                  <p className="mt-1 text-[11px] text-slate-500">{byId.lead[run.leadId]?.currentStage}</p>
                </td>
                <td className="ml-code px-3 py-3 align-top text-[11px] text-slate-400">{run.conversationId}</td>
                <td className="px-3 py-3 align-top text-slate-200">
                  <p>{byId.agent[run.triggeredAgentId]?.name ?? run.triggeredAgentId}</p>
                  <p className="mt-1 text-[11px] text-slate-500">{byId.agent[run.triggeredAgentId]?.version}</p>
                </td>
                <td className="max-w-[300px] px-3 py-3 align-top text-slate-300">
                  <p className="max-h-[2.9rem] overflow-hidden leading-relaxed">{run.decisionSummary}</p>
                </td>
                <td className="px-3 py-3">
                  <StatusBadge value={run.status} />
                </td>
                <td className="ml-code px-3 py-3 align-top text-[11px] text-slate-400">{formatDurationMs(run.durationMs)}</td>
                <td className="max-w-[220px] px-3 py-3 align-top text-slate-300">
                  <p className="max-h-[2.9rem] overflow-hidden leading-relaxed">{run.nextStep}</p>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
