import { AnimatePresence, motion } from "framer-motion";
import { useMemo, useState } from "react";
import { Agent } from "../types.js";
import { AgentCard } from "../components/AgentCard.js";
import { SectionHeader } from "../components/SectionHeader.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { formatPercent } from "../utils.js";

interface AgentsPageProps {
  agents: Agent[];
}

export function AgentsPage({ agents }: AgentsPageProps) {
  const [openAgentId, setOpenAgentId] = useState<string | null>(null);
  const openAgent = useMemo(() => agents.find((agent) => agent.id === openAgentId) ?? null, [agents, openAgentId]);

  return (
    <motion.div key="agents" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <SectionHeader title="Agents" subtitle="Operational health, autonomy profile, and recent execution quality for each agent." />

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {agents.map((agent) => (
          <AgentCard key={agent.id} agent={agent} onOpen={setOpenAgentId} />
        ))}
      </div>

      <AnimatePresence>
        {openAgent ? (
          <>
            <motion.div
              className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px]"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setOpenAgentId(null)}
            />

            <motion.aside
              className="fixed right-0 top-0 z-50 h-full w-full max-w-2xl overflow-y-auto border-l border-zinc-800 bg-zinc-950 p-6"
              initial={{ x: 420 }}
              animate={{ x: 0 }}
              exit={{ x: 420 }}
              transition={{ type: "spring", bounce: 0, duration: 0.35 }}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-xl font-semibold text-zinc-100">{openAgent.name}</h3>
                  <p className="mt-1 text-sm text-zinc-400">{openAgent.role}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setOpenAgentId(null)}
                  className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1 text-xs text-zinc-300"
                >
                  Close
                </button>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <StatusBadge value={openAgent.status} />
                <span className="rounded-full border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-[11px] text-zinc-300">{openAgent.version}</span>
                <span className="rounded-full border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-[11px] text-zinc-300">
                  {openAgent.autonomyLevel.replaceAll("_", " ")}
                </span>
              </div>

              <p className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900/70 px-3 py-2 text-sm text-zinc-300">{openAgent.mission}</p>

              <div className="mt-6 grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-3 text-sm">
                  <p className="text-zinc-500">Total runs</p>
                  <p className="mt-1 font-semibold text-zinc-100">{openAgent.totalRuns.toLocaleString()}</p>
                </div>
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-3 text-sm">
                  <p className="text-zinc-500">Success rate</p>
                  <p className="mt-1 font-semibold text-zinc-100">{formatPercent(openAgent.successRate)}</p>
                </div>
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-3 text-sm">
                  <p className="text-zinc-500">Average runtime</p>
                  <p className="mt-1 font-semibold text-zinc-100">{openAgent.avgRuntimeSec.toFixed(1)} sec</p>
                </div>
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-3 text-sm">
                  <p className="text-zinc-500">Last run</p>
                  <p className="mt-1 font-semibold text-zinc-100">{openAgent.lastRun}</p>
                </div>
              </div>

              <section className="mt-6">
                <h4 className="text-sm font-semibold text-zinc-200">Triggers</h4>
                <div className="mt-2 flex flex-wrap gap-2">
                  {openAgent.triggers.map((trigger) => (
                    <span key={trigger} className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-300">
                      {trigger}
                    </span>
                  ))}
                </div>
              </section>

              <section className="mt-6 grid gap-3 sm:grid-cols-2">
                <div>
                  <h4 className="mb-2 text-sm font-semibold text-zinc-200">Expected Inputs</h4>
                  <ul className="space-y-1 text-xs text-zinc-400">
                    {openAgent.expectedInputs.map((item) => (
                      <li key={item} className="rounded-lg border border-zinc-800 bg-zinc-900/70 px-2 py-1.5">
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h4 className="mb-2 text-sm font-semibold text-zinc-200">Expected Outputs</h4>
                  <ul className="space-y-1 text-xs text-zinc-400">
                    {openAgent.expectedOutputs.map((item) => (
                      <li key={item} className="rounded-lg border border-zinc-800 bg-zinc-900/70 px-2 py-1.5">
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              </section>

              <section className="mt-6">
                <h4 className="mb-2 text-sm font-semibold text-zinc-200">Dependencies</h4>
                <div className="flex flex-wrap gap-2">
                  {openAgent.dependencies.map((dependency) => (
                    <span key={dependency} className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-300">
                      {dependency}
                    </span>
                  ))}
                </div>
              </section>

              <section className="mt-6">
                <h4 className="mb-2 text-sm font-semibold text-zinc-200">Recent Runs</h4>
                <div className="space-y-2">
                  {openAgent.recentRuns.map((run) => (
                    <div key={run.id} className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm text-zinc-200">{run.summary}</p>
                        <StatusBadge value={run.status} />
                      </div>
                      <p className="mt-1 text-xs text-zinc-500">
                        {run.timestamp} • {run.durationSec.toFixed(1)} sec
                      </p>
                    </div>
                  ))}
                </div>
              </section>

              <section className="mt-6">
                <h4 className="mb-2 text-sm font-semibold text-zinc-200">Recent Errors / Blocked Cases</h4>
                {openAgent.recentIssues.length === 0 ? (
                  <p className="rounded-xl border border-zinc-800 bg-zinc-900/70 px-3 py-2 text-xs text-zinc-500">No recent issues for this agent.</p>
                ) : (
                  <div className="space-y-2">
                    {openAgent.recentIssues.map((issue) => (
                      <div key={issue.id} className="rounded-xl border border-rose-500/30 bg-rose-500/8 p-3 text-xs text-rose-200">
                        <p>{issue.message}</p>
                        <p className="mt-1 text-rose-300/70">{issue.timestamp}</p>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </motion.aside>
          </>
        ) : null}
      </AnimatePresence>
    </motion.div>
  );
}
