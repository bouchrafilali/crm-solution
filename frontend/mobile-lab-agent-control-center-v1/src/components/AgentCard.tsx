import { motion } from "framer-motion";
import { Agent } from "../types.js";
import { formatPercent } from "../utils.js";
import { StatusBadge } from "./StatusBadge.js";

interface AgentCardProps {
  agent: Agent;
  onOpen: (id: string) => void;
}

export function AgentCard({ agent, onOpen }: AgentCardProps) {
  return (
    <motion.button
      type="button"
      onClick={() => onOpen(agent.id)}
      whileHover={{ y: -2 }}
      className="ml-panel ml-interactive group w-full rounded-2xl p-4 text-left"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate-100">{agent.name}</p>
          <p className="mt-1 text-xs leading-relaxed text-slate-400">{agent.role}</p>
        </div>
        <StatusBadge value={agent.status} />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 text-xs text-slate-400">
        <div>
          <p className="text-slate-500">Version</p>
          <p className="text-slate-200">{agent.version}</p>
        </div>
        <div>
          <p className="text-slate-500">Autonomy</p>
          <p className="text-slate-200">{agent.autonomyLevel.replaceAll("_", " ")}</p>
        </div>
        <div>
          <p className="text-slate-500">Total Runs</p>
          <p className="text-slate-200">{agent.totalRuns.toLocaleString()}</p>
        </div>
        <div>
          <p className="text-slate-500">Success</p>
          <p className="text-slate-200">{formatPercent(agent.successRate)}</p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {agent.primaryTriggers.slice(0, 2).map((trigger) => (
          <span key={trigger} className="ml-chip rounded-md px-2 py-0.5 text-[11px] text-slate-300">
            {trigger}
          </span>
        ))}
      </div>

      <p className="mt-3 text-[11px] font-medium uppercase tracking-[0.1em] text-slate-500 opacity-80 group-hover:opacity-100">Open details</p>
    </motion.button>
  );
}
