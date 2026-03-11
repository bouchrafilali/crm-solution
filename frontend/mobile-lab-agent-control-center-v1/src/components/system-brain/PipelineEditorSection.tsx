import { motion } from "framer-motion";
import { useMemo, useState } from "react";
import { PipelineEditorEdge, PipelineEditorNode } from "../../system-brain-types.js";
import { SectionHeader } from "../SectionHeader.js";

const nodeTypeTone: Record<string, string> = {
  trigger: "border-cyan-300/35 bg-cyan-500/10",
  ai_step: "border-indigo-300/35 bg-indigo-500/10",
  condition: "border-amber-300/35 bg-amber-500/10",
  human_review: "border-rose-300/35 bg-rose-500/10",
  automation: "border-emerald-300/35 bg-emerald-500/10",
  delay: "border-slate-400/35 bg-slate-500/10",
  webhook: "border-violet-300/35 bg-violet-500/10",
  metrics: "border-teal-300/35 bg-teal-500/10"
};

export function PipelineEditorSection({
  nodes,
  edges,
  publishedVersion,
  draftVersion
}: {
  nodes: PipelineEditorNode[];
  edges: PipelineEditorEdge[];
  publishedVersion: string;
  draftVersion: string;
}) {
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>(
    Object.fromEntries(nodes.map((node) => [node.id, { x: node.x, y: node.y }]))
  );

  const edgesWithPoints = useMemo(() => {
    return edges
      .map((edge) => {
        const from = positions[edge.from];
        const to = positions[edge.to];
        if (!from || !to) return null;
        return {
          ...edge,
          x1: from.x + 240,
          y1: from.y + 42,
          x2: to.x,
          y2: to.y + 42
        };
      })
      .filter(Boolean) as Array<PipelineEditorEdge & { x1: number; y1: number; x2: number; y2: number }>;
  }, [edges, positions]);

  return (
    <section className="ml-panel rounded-2xl p-4">
      <SectionHeader
        title="Visual AI Pipeline Editor"
        subtitle="Node-based orchestration editor for triggers, AI steps, conditions, approval gates, fallbacks, and publishable flow versions."
        action={
          <div className="flex items-center gap-2 text-[11px]">
            <span className="ml-chip rounded-full px-2 py-1 text-slate-300">Published {publishedVersion}</span>
            <span className="ml-chip rounded-full px-2 py-1 text-amber-200">Draft {draftVersion}</span>
            <button type="button" className="ml-button-primary rounded-lg px-2.5 py-1">Publish Draft</button>
          </div>
        }
      />

      <div className="ml-panel-soft relative h-[520px] overflow-auto rounded-xl">
        <div className="relative h-[520px] min-w-[1840px]">
          <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
            {edgesWithPoints.map((edge) => (
              <g key={edge.id}>
                <line
                  x1={edge.x1}
                  y1={edge.y1}
                  x2={edge.x2}
                  y2={edge.y2}
                  stroke={edge.kind === "fallback" ? "#f59e0b" : "#64748b"}
                  strokeWidth={2}
                  strokeDasharray={edge.kind === "fallback" ? "6 6" : undefined}
                />
                <text x={(edge.x1 + edge.x2) / 2} y={(edge.y1 + edge.y2) / 2 - 6} fill="#94a3b8" fontSize="10" textAnchor="middle">
                  {edge.label}
                </text>
              </g>
            ))}
          </svg>

          {nodes.map((node) => {
            const position = positions[node.id] || { x: node.x, y: node.y };
            return (
              <motion.article
                key={node.id}
                drag
                dragMomentum={false}
                onDragEnd={(_, info) => {
                  setPositions((prev) => ({
                    ...prev,
                    [node.id]: {
                      x: Math.max(20, Math.min(1580, position.x + info.offset.x)),
                      y: Math.max(20, Math.min(420, position.y + info.offset.y))
                    }
                  }));
                }}
                className={`absolute w-[240px] rounded-xl border p-3 shadow-xl ${nodeTypeTone[node.type] || "border-slate-600/40 bg-slate-900/80"}`}
                style={{ left: position.x, top: position.y }}
                whileHover={{ scale: 1.01 }}
              >
                <p className="text-[10px] uppercase tracking-[0.12em] text-slate-500">{node.type.replaceAll("_", " ")}</p>
                <p className="mt-1 text-sm font-semibold text-slate-100">{node.label}</p>
                <div className="mt-2 space-y-1 text-[11px] text-slate-300">
                  {node.metadata.provider ? <p>Provider: {node.metadata.provider}</p> : null}
                  {node.metadata.model ? <p>Model: {node.metadata.model}</p> : null}
                  {node.metadata.version ? <p>Version: {node.metadata.version}</p> : null}
                  {node.metadata.condition ? <p>Condition: {node.metadata.condition}</p> : null}
                  {typeof node.metadata.approvalRequired === "boolean" ? <p>Approval: {node.metadata.approvalRequired ? "Required" : "Not required"}</p> : null}
                </div>
              </motion.article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
