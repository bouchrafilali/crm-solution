import { useMemo, useState } from "react";
import { LeadDebuggerTrace } from "../../system-brain-types.js";
import { SectionHeader } from "../SectionHeader.js";

export function LeadDebuggerSection({ traces }: { traces: LeadDebuggerTrace[] }) {
  const [leadId, setLeadId] = useState(traces[0]?.leadId ?? "");
  const current = useMemo(() => traces.find((trace) => trace.leadId === leadId) ?? traces[0] ?? null, [traces, leadId]);

  return (
    <section className="ml-panel rounded-2xl p-4">
      <SectionHeader
        title="Lead Debugger / Execution Inspector"
        subtitle="Replay exact execution path with prompt versions, provider trace, and token-level step cost."
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="text-xs text-slate-500" htmlFor="lead-debugger-selector">Inspect lead</label>
        <select
          id="lead-debugger-selector"
          value={current?.leadId ?? ""}
          onChange={(event) => setLeadId(event.target.value)}
          className="ml-panel-soft rounded-lg border border-slate-700/60 px-2.5 py-1.5 text-xs text-slate-200"
        >
          {traces.map((trace) => (
            <option key={trace.leadId} value={trace.leadId}>{trace.leadName}</option>
          ))}
        </select>
      </div>

      {current ? (
        <div className="grid gap-4 xl:grid-cols-[1.35fr_1fr]">
          <article className="ml-panel-soft rounded-xl p-4">
            <p className="text-[10px] uppercase tracking-[0.12em] text-slate-500">Execution Summary</p>
            <div className="mt-2 space-y-2 text-xs">
              <p><span className="text-slate-500">Inbound:</span> <span className="text-slate-200">{current.latestInbound}</span></p>
              <p><span className="text-slate-500">Stage:</span> <span className="text-slate-200">{current.stageResult}</span></p>
              <p><span className="text-slate-500">Strategy:</span> <span className="text-slate-200">{current.strategyResult}</span></p>
              <p><span className="text-slate-500">Reply:</span> <span className="text-slate-200">{current.replyResult}</span></p>
              <p><span className="text-slate-500">Brand Guardian:</span> <span className="text-slate-200">{current.brandGuardianResult}</span></p>
              <p><span className="text-slate-500">Final Output:</span> <span className="text-slate-100">{current.finalOutput}</span></p>
              <p><span className="text-slate-500">Snapshot:</span> <span className="ml-code text-slate-300">{current.snapshotId}</span></p>
            </div>
          </article>

          <aside className="ml-panel-soft rounded-xl p-4">
            <p className="text-[10px] uppercase tracking-[0.12em] text-slate-500">Step Trace</p>
            <div className="mt-2 space-y-2">
              {current.steps.map((step) => (
                <article key={step.id} className="ml-panel rounded-lg p-2.5 text-xs">
                  <p className="font-semibold text-slate-100">{step.title}</p>
                  <p className="mt-0.5 text-slate-400">{step.summary}</p>
                  <p className="mt-1 text-[11px] text-slate-500">{step.provider} · {step.model} · {step.promptVersion}</p>
                  <p className="mt-1 text-[11px] text-cyan-200">
                    in {step.tokens.in} / out {step.tokens.out} · ${step.tokens.costUsd.toFixed(4)}
                  </p>
                </article>
              ))}
            </div>
          </aside>
        </div>
      ) : null}
    </section>
  );
}
