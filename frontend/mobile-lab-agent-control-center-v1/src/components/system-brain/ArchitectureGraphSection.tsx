import { motion } from "framer-motion";
import { useMemo, useState } from "react";
import { ArchitectureEdge, ArchitectureNode } from "../../system-brain-types.js";
import { cn } from "../../utils.js";
import { SectionHeader } from "../SectionHeader.js";

function shortName(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

export function ArchitectureGraphSection({
  nodes,
  edges
}: {
  nodes: ArchitectureNode[];
  edges: ArchitectureEdge[];
}) {
  const [activeId, setActiveId] = useState(nodes[0]?.id ?? "");
  const activeNode = useMemo(() => nodes.find((node) => node.id === activeId) ?? nodes[0] ?? null, [nodes, activeId]);

  return (
    <section className="ml-panel rounded-2xl p-4">
      <SectionHeader
        title="Architecture Graph / Agent Map"
        subtitle="Live AI pipeline topology with step-level provider, prompt, latency, and cache behavior visibility."
      />

      <div className="grid gap-4 xl:grid-cols-[1.8fr_1fr]">
        <div className="ml-panel-soft overflow-x-auto rounded-2xl p-4">
          <div className="flex min-w-[980px] items-center gap-3">
            {nodes.map((node, index) => {
              const next = nodes[index + 1];
              const edge = next ? edges.find((item) => item.from === node.id && item.to === next.id) : null;
              return (
                <div key={node.id} className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setActiveId(node.id)}
                    className={cn(
                      "ml-interactive rounded-2xl border px-4 py-3 text-left",
                      activeId === node.id
                        ? "border-cyan-300/45 bg-cyan-500/10"
                        : "border-slate-600/40 bg-slate-900/70 hover:border-slate-500/60"
                    )}
                  >
                    <p className="text-[10px] uppercase tracking-[0.12em] text-slate-500">{node.provider}</p>
                    <p className="mt-1 text-sm font-semibold text-slate-100">{shortName(node.name)}</p>
                    <p className="mt-1 text-xs text-slate-400">{node.promptVersion}</p>
                  </button>
                  {edge ? (
                    <div className="flex flex-col items-center gap-1">
                      <span className="text-slate-500">→</span>
                      <span className="rounded-md border border-slate-700/60 bg-slate-900/70 px-2 py-0.5 text-[10px] text-slate-400">
                        {edge.label}
                      </span>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>

        <motion.aside
          key={activeNode?.id}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
          className="ml-panel-soft rounded-2xl p-4"
        >
          {activeNode ? (
            <>
              <p className="text-[10px] uppercase tracking-[0.12em] text-slate-500">Node Details</p>
              <h3 className="mt-1 text-base font-semibold text-slate-100">{activeNode.name}</h3>
              <p className="mt-1 text-xs leading-relaxed text-slate-400">{activeNode.role}</p>
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                <div className="ml-panel rounded-xl p-2.5">
                  <p className="text-slate-500">Provider / Model</p>
                  <p className="mt-1 font-medium text-slate-200">{activeNode.provider} · {activeNode.model}</p>
                </div>
                <div className="ml-panel rounded-xl p-2.5">
                  <p className="text-slate-500">Prompt Version</p>
                  <p className="mt-1 font-medium text-slate-200">{activeNode.promptVersion}</p>
                </div>
                <div className="ml-panel rounded-xl p-2.5">
                  <p className="text-slate-500">Avg Tokens</p>
                  <p className="mt-1 font-medium text-slate-200">in {activeNode.avgInputTokens} / out {activeNode.avgOutputTokens}</p>
                </div>
                <div className="ml-panel rounded-xl p-2.5">
                  <p className="text-slate-500">p95 Latency</p>
                  <p className="mt-1 font-medium text-slate-200">{activeNode.p95LatencyMs} ms</p>
                </div>
                <div className="ml-panel rounded-xl p-2.5">
                  <p className="text-slate-500">Fail Rate</p>
                  <p className="mt-1 font-medium text-slate-200">{activeNode.failRate.toFixed(1)}%</p>
                </div>
                <div className="ml-panel rounded-xl p-2.5">
                  <p className="text-slate-500">Cache Behavior</p>
                  <p className="mt-1 font-medium text-slate-200">{activeNode.cacheBehavior}</p>
                </div>
              </div>
              <div className="mt-3">
                <p className="text-[11px] uppercase tracking-[0.1em] text-slate-500">Dependencies</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {activeNode.dependencies.map((dep) => (
                    <span key={dep} className="ml-chip rounded-md px-2 py-0.5 text-[11px] text-slate-300">{dep}</span>
                  ))}
                </div>
              </div>
            </>
          ) : null}
        </motion.aside>
      </div>
    </section>
  );
}
