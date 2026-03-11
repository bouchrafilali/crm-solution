import { motion } from "framer-motion";
import { SectionHeader } from "../components/SectionHeader.js";
import { BrainKpiCard } from "../components/system-brain/BrainKpiCard.js";
import { ArchitectureGraphSection } from "../components/system-brain/ArchitectureGraphSection.js";
import { PromptManagerSection } from "../components/system-brain/PromptManagerSection.js";
import { StepPerformanceSection } from "../components/system-brain/StepPerformanceSection.js";
import { LeadDebuggerSection } from "../components/system-brain/LeadDebuggerSection.js";
import { PipelineEditorSection } from "../components/system-brain/PipelineEditorSection.js";
import { MobileLabSystemBrainData } from "../system-brain-types.js";
import { SectionErrorBoundary } from "../components/SectionErrorBoundary.js";

export function SystemBrainPage({ data }: { data: MobileLabSystemBrainData }) {
  const minimalMode =
    typeof window !== "undefined" &&
    (window.location.search.includes("sb_minimal=1") || window.location.hash.includes("sb-minimal"));
  const safeData: MobileLabSystemBrainData = {
    kpis: data?.kpis ?? [],
    architecture: {
      nodes: data?.architecture?.nodes ?? [],
      edges: data?.architecture?.edges ?? []
    },
    flowRules: data?.flowRules ?? [],
    prompts: data?.prompts ?? [],
    stepPerformance: data?.stepPerformance ?? [],
    tokenEconomy: data?.tokenEconomy ?? [],
    logs: data?.logs ?? [],
    debugger: data?.debugger ?? [],
    pipelineEditor: {
      nodes: data?.pipelineEditor?.nodes ?? [],
      edges: data?.pipelineEditor?.edges ?? [],
      publishedVersion: data?.pipelineEditor?.publishedVersion ?? "n/a",
      draftVersion: data?.pipelineEditor?.draftVersion ?? "n/a"
    }
  };

  if (minimalMode) {
    return (
      <motion.div key="system-brain-minimal" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
        <section className="ml-panel rounded-2xl p-6">
          <p className="text-[10px] uppercase tracking-[0.14em] text-cyan-300">System Brain Minimal Mode</p>
          <h1 className="mt-2 text-2xl font-semibold text-slate-100">System Brain Route Mounted</h1>
          <p className="mt-2 text-sm text-slate-400">
            This confirms routing and page mounting are working. Disable minimal mode to render full sections.
          </p>
        </section>
      </motion.div>
    );
  }

  return (
    <motion.div key="system-brain" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <SectionHeader
        title="Mobile-Lab System Brain"
        subtitle="Elite AI operations command center for orchestration, prompt governance, token economy, and lead-level execution intelligence."
      />

      <div className="ml-panel mb-4 flex flex-wrap items-center gap-2 rounded-2xl px-3 py-2.5 text-xs">
        <span className="ml-chip rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-cyan-200">Brain Mode</span>
        <span className="ml-chip rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-emerald-200">Production Visibility</span>
        <span className="ml-chip rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-300">Deterministic + Auditable</span>
        <span className="ml-auto text-slate-500">Pipeline build: <span className="ml-code text-slate-300">flow@2.8.0</span></span>
      </div>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {safeData.kpis.map((item) => (
          <BrainKpiCard key={item.id} item={item} />
        ))}
      </section>

      <div className="mt-4 space-y-4">
        <SectionErrorBoundary sectionName="Architecture Graph / Agent Map">
          <ArchitectureGraphSection nodes={safeData.architecture.nodes} edges={safeData.architecture.edges} />
        </SectionErrorBoundary>

        <SectionErrorBoundary sectionName="Flow Configurations">
          <section className="ml-panel rounded-2xl p-4">
            <SectionHeader
              title="Flow Configurations"
              subtitle="Operational trigger-chain policies in list mode, with status and publish version visibility."
            />
            <div className="ml-table-shell overflow-x-auto rounded-xl">
              <table className="ml-table w-full min-w-[980px] text-left text-xs">
                <thead>
                  <tr>
                    <th className="px-3 py-3">Trigger</th>
                    <th className="px-3 py-3">Condition</th>
                    <th className="px-3 py-3">Action</th>
                    <th className="px-3 py-3">Status</th>
                    <th className="px-3 py-3">Version</th>
                  </tr>
                </thead>
                <tbody>
                  {safeData.flowRules.map((rule) => (
                    <tr key={rule.id}>
                      <td className="px-3 py-3 font-semibold text-slate-100">{rule.trigger}</td>
                      <td className="px-3 py-3 text-slate-400">{rule.condition}</td>
                      <td className="px-3 py-3 text-slate-300">{rule.action}</td>
                      <td className="px-3 py-3">
                        <span className="ml-chip rounded-md px-2 py-0.5 text-[11px] text-slate-300">{rule.status}</span>
                      </td>
                      <td className="px-3 py-3 text-slate-500">{rule.version}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </SectionErrorBoundary>

        <SectionErrorBoundary sectionName="Prompt Management + Versioning">
          <PromptManagerSection prompts={safeData.prompts} />
        </SectionErrorBoundary>
        <SectionErrorBoundary sectionName="Step Performance + Token Economy">
          <StepPerformanceSection rows={safeData.stepPerformance} tokenEconomy={safeData.tokenEconomy} />
        </SectionErrorBoundary>

        <SectionErrorBoundary sectionName="Logs and Event Stream">
          <section className="ml-panel rounded-2xl p-4">
            <SectionHeader
              title="Logs and Event Stream"
              subtitle="Filterable operations stream with cache, single-flight joins, fallback behavior, and error trace context."
            />
            <div className="ml-table-shell overflow-x-auto rounded-xl">
              <table className="ml-table w-full min-w-[1280px] text-left text-xs">
                <thead>
                  <tr>
                    <th className="px-3 py-3">Timestamp</th>
                    <th className="px-3 py-3">Lead</th>
                    <th className="px-3 py-3">Step</th>
                    <th className="px-3 py-3">Provider</th>
                    <th className="px-3 py-3">Status</th>
                    <th className="px-3 py-3">Tokens</th>
                    <th className="px-3 py-3">Latency</th>
                    <th className="px-3 py-3">Cache</th>
                    <th className="px-3 py-3">Join</th>
                    <th className="px-3 py-3">Fallback</th>
                    <th className="px-3 py-3">Error</th>
                  </tr>
                </thead>
                <tbody>
                  {safeData.logs.map((row) => (
                    <tr key={row.id}>
                      <td className="px-3 py-3 text-slate-400">{new Date(row.timestamp).toLocaleString()}</td>
                      <td className="px-3 py-3 text-slate-300">{row.leadId}</td>
                      <td className="px-3 py-3 text-slate-300">{row.step}</td>
                      <td className="px-3 py-3 text-slate-300">{row.provider}</td>
                      <td className="px-3 py-3"><span className="ml-chip rounded-md px-2 py-0.5 text-[11px] text-slate-300">{row.status}</span></td>
                      <td className="px-3 py-3 text-slate-300">{row.inputTokens}/{row.outputTokens}</td>
                      <td className="px-3 py-3 text-slate-300">{row.latencyMs} ms</td>
                      <td className="px-3 py-3 text-cyan-300">{row.cache}</td>
                      <td className="px-3 py-3 text-indigo-300">{row.joinedInflight ? "yes" : "no"}</td>
                      <td className="px-3 py-3 text-amber-300">{row.fallbackTriggered ? "yes" : "no"}</td>
                      <td className="px-3 py-3 text-rose-300">{row.error ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </SectionErrorBoundary>

        <SectionErrorBoundary sectionName="Lead Debugger / Execution Inspector">
          <LeadDebuggerSection traces={safeData.debugger} />
        </SectionErrorBoundary>

        <SectionErrorBoundary sectionName="Visual AI Pipeline Editor">
          <PipelineEditorSection
            nodes={safeData.pipelineEditor.nodes}
            edges={safeData.pipelineEditor.edges}
            publishedVersion={safeData.pipelineEditor.publishedVersion}
            draftVersion={safeData.pipelineEditor.draftVersion}
          />
        </SectionErrorBoundary>
      </div>
    </motion.div>
  );
}
