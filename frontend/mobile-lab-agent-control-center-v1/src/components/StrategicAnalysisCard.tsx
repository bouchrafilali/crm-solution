import { StrategicAnalysis } from "../types.js";

interface StrategicAnalysisCardProps {
  analysis: StrategicAnalysis;
}

export function StrategicAnalysisCard({ analysis }: StrategicAnalysisCardProps) {
  return (
    <article className="ml-panel rounded-2xl p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-slate-100">Strategic Analysis</h3>
        <span className="ml-chip rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-300">
          {analysis.probableStage}
        </span>
      </div>

      <div className="mt-3 space-y-2 text-xs">
        <div>
          <p className="mb-1 text-slate-500">Key signals</p>
          <div className="flex flex-wrap gap-1.5">
            {analysis.keySignals.map((signal) => (
              <span key={signal} className="ml-chip rounded-md px-2 py-0.5 text-slate-300">
                {signal}
              </span>
            ))}
          </div>
        </div>

        <div>
          <p className="mb-1 text-slate-500">Risks</p>
          <ul className="space-y-1">
            {analysis.risks.map((risk) => (
              <li key={risk} className="rounded-lg border border-rose-300/25 bg-rose-500/10 px-2 py-1 text-rose-100">
                {risk}
              </li>
            ))}
          </ul>
        </div>

        <div>
          <p className="mb-1 text-slate-500">Opportunities</p>
          <ul className="space-y-1">
            {analysis.opportunities.map((opportunity) => (
              <li key={opportunity} className="rounded-lg border border-emerald-300/25 bg-emerald-500/10 px-2 py-1 text-emerald-100">
                {opportunity}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <p className="mt-3 rounded-xl border border-sky-300/30 bg-sky-500/12 px-3 py-2 text-xs text-sky-100">
        <span className="font-semibold">Next best action:</span> {analysis.nextBestAction}
      </p>
    </article>
  );
}
