import { motion } from "framer-motion";
import { SectionHeader } from "../components/SectionHeader.js";
import {
  buildPriorities,
  controlPaths,
  systemMapFlowSteps,
  systemMapLayers,
  type SystemMapLayer,
  uiBindings
} from "../systemMapData.js";

const layerTone: Record<SystemMapLayer["id"], string> = {
  input: "border-slate-500/30",
  processing: "border-slate-500/30",
  orchestration: "border-sky-300/35",
  intelligence: "border-indigo-300/25",
  human: "border-amber-300/35",
  execution: "border-emerald-300/25",
  learning: "border-teal-300/30",
  ui: "border-cyan-300/30"
};

const layerAccent: Record<SystemMapLayer["id"], string> = {
  input: "text-slate-300",
  processing: "text-slate-300",
  orchestration: "text-sky-200",
  intelligence: "text-indigo-200",
  human: "text-amber-200",
  execution: "text-emerald-200",
  learning: "text-teal-200",
  ui: "text-cyan-200"
};

export function SystemArchitectureMapPage() {
  return (
    <motion.div key="system-map" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <SectionHeader
        title="Mobile-Lab System Architecture Map"
        subtitle="Disciplined multi-agent operating system map showing controlled orchestration, human oversight, execution traceability, and learning feedback into product surfaces."
      />

      <section className="ml-panel rounded-2xl p-4">
        <h3 className="text-sm font-semibold text-slate-100">Primary End-to-End Flow</h3>
        <p className="mt-1 text-xs text-slate-400">
          Inputs → Ingestion / Normalization → Orchestrator → Decision Routing → Intelligence → Human Control (if needed) → Execution → Learning Loop → Product Interface
        </p>

        <div className="mt-4 flex items-stretch gap-2 overflow-x-auto pb-2 scroll-dark">
          {systemMapFlowSteps.map((step, index) => (
            <div key={step.id} className="flex min-w-[220px] items-center gap-2">
              <motion.article whileHover={{ y: -2 }} className="ml-panel-soft ml-interactive h-full rounded-xl p-3">
                <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">Step {index + 1}</p>
                <p className="mt-1 text-sm font-semibold text-slate-100">{step.title}</p>
                <p className="mt-1 text-xs leading-relaxed text-slate-400">{step.summary}</p>
              </motion.article>
              {index < systemMapFlowSteps.length - 1 ? <span className="text-slate-500">→</span> : null}
            </div>
          ))}
        </div>

        <div className="mt-3 rounded-xl border border-teal-300/25 bg-teal-500/10 px-3 py-2 text-xs text-teal-100">
          <span className="font-semibold">Feedback closure:</span> Prompt / Rule Improvement feeds back into Governance Check + Strategic Advisor Agent + Reply Draft Agent.
        </div>
      </section>

      <section className="mt-4">
        <SectionHeader
          title="Layered Architecture"
          subtitle="Explicit layer separation to keep behavior controlled, observable, and implementation-ready."
        />

        <div className="space-y-2">
          {systemMapLayers.map((layer, index) => (
            <div key={layer.id}>
              <article className={`ml-panel rounded-2xl border p-4 ${layerTone[layer.id]}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">{layer.title}</p>
                    <p className="mt-1 text-xs leading-relaxed text-slate-400">{layer.purpose}</p>
                  </div>
                  <span className={`ml-chip rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] ${layerAccent[layer.id]}`}>
                    {layer.id}
                  </span>
                </div>

                <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  {layer.nodes.map((node) => (
                    <div key={node.name} className="ml-panel-soft rounded-xl px-3 py-2">
                      <p className="text-xs font-semibold text-slate-100">{node.name}</p>
                      <p className="mt-1 text-xs leading-relaxed text-slate-400">{node.role}</p>
                    </div>
                  ))}
                </div>
              </article>

              {index < systemMapLayers.length - 1 ? (
                <div className="flex justify-center py-1">
                  <span className="ml-chip rounded-full px-2 py-0.5 text-xs text-slate-400">↓</span>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </section>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1.2fr_1fr]">
        <section className="ml-panel rounded-2xl p-4">
          <h3 className="text-sm font-semibold text-slate-100">Control Paths</h3>
          <p className="mt-1 text-xs text-slate-400">Traceable system paths for execution, governance, and learning feedback.</p>

          <div className="mt-3 space-y-2">
            {controlPaths.map((path) => (
              <article key={path.name} className="ml-panel-soft rounded-xl p-3">
                <p className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-300">{path.name}</p>
                <p className="ml-code mt-1 text-[11px] leading-relaxed text-slate-400">{path.path.join(" -> ")}</p>
                <p className="mt-1 text-xs text-slate-500">{path.why}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="ml-panel rounded-2xl p-4">
          <h3 className="text-sm font-semibold text-slate-100">Build First Priorities</h3>
          <p className="mt-1 text-xs text-slate-400">Recommended implementation sequence for a stable AI sales operating system.</p>

          <div className="mt-3 space-y-2">
            {buildPriorities.map((priority) => (
              <article key={priority.step} className="ml-panel-soft rounded-xl p-3">
                <p className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-200">{priority.step}</p>
                <p className="mt-1 text-xs text-slate-300">{priority.focus}</p>
                <p className="mt-1 text-xs text-slate-500">{priority.deliverable}</p>
              </article>
            ))}
          </div>
        </section>
      </div>

      <section className="ml-panel mt-4 rounded-2xl p-4">
        <h3 className="text-sm font-semibold text-slate-100">Product Interface Bindings</h3>
        <p className="mt-1 text-xs text-slate-400">How system outputs are exposed across Mobile-Lab product surfaces.</p>

        <div className="ml-table-shell mt-3 overflow-x-auto rounded-xl">
          <table className="ml-table w-full min-w-[1050px] text-left text-xs">
            <thead>
              <tr>
                <th className="px-3 py-3">UI Surface</th>
                <th className="px-3 py-3">Fed By</th>
                <th className="px-3 py-3">Operational Outcome</th>
              </tr>
            </thead>
            <tbody>
              {uiBindings.map((binding) => (
                <tr key={binding.surface}>
                  <td className="px-3 py-3 font-semibold text-slate-100">{binding.surface}</td>
                  <td className="px-3 py-3">
                    <div className="flex flex-wrap gap-1.5">
                      {binding.sources.map((source) => (
                        <span key={`${binding.surface}-${source}`} className="ml-chip rounded-md px-2 py-0.5 text-[11px] text-slate-300">
                          {source}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-3 text-slate-400">{binding.outcome}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </motion.div>
  );
}
