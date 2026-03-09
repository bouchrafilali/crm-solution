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
      className="group w-full rounded-2xl border border-zinc-800 bg-zinc-900/80 p-4 text-left transition hover:border-zinc-700"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-zinc-100">{agent.name}</p>
          <p className="mt-1 text-xs text-zinc-500">{agent.role}</p>
        </div>
        <StatusBadge value={agent.status} />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 text-xs text-zinc-400">
        <div>
          <p className="text-zinc-500">Version</p>
          <p className="text-zinc-200">{agent.version}</p>
        </div>
        <div>
          <p className="text-zinc-500">Autonomy</p>
          <p className="text-zinc-200">{agent.autonomyLevel.replaceAll("_", " ")}</p>
        </div>
        <div>
          <p className="text-zinc-500">Total Runs</p>
          <p className="text-zinc-200">{agent.totalRuns.toLocaleString()}</p>
        </div>
        <div>
          <p className="text-zinc-500">Success</p>
          <p className="text-zinc-200">{formatPercent(agent.successRate)}</p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {agent.primaryTriggers.slice(0, 2).map((trigger) => (
          <span key={trigger} className="rounded-md border border-zinc-700 bg-zinc-800/70 px-2 py-0.5 text-[11px] text-zinc-300">
            {trigger}
          </span>
        ))}
      </div>

      <p className="mt-3 text-[11px] text-zinc-500 opacity-80 group-hover:opacity-100">Open details</p>
    </motion.button>
  );
}
