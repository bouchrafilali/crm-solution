import { StrategicAnalysis } from "../types.js";

interface StrategicAnalysisCardProps {
  analysis: StrategicAnalysis;
}

export function StrategicAnalysisCard({ analysis }: StrategicAnalysisCardProps) {
  return (
    <article className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-4">
      <h3 className="text-sm font-semibold text-zinc-100">Strategic Analysis</h3>
      <p className="mt-1 text-xs text-zinc-400">Probable stage: {analysis.probableStage}</p>

      <div className="mt-3 space-y-2 text-xs">
        <div>
          <p className="mb-1 text-zinc-500">Key signals</p>
          <div className="flex flex-wrap gap-1.5">
            {analysis.keySignals.map((signal) => (
              <span key={signal} className="rounded-md border border-zinc-700 bg-zinc-800/70 px-2 py-0.5 text-zinc-300">
                {signal}
              </span>
            ))}
          </div>
        </div>

        <div>
          <p className="mb-1 text-zinc-500">Risks</p>
          <ul className="space-y-1">
            {analysis.risks.map((risk) => (
              <li key={risk} className="rounded-lg border border-rose-500/20 bg-rose-500/8 px-2 py-1 text-rose-200">
                {risk}
              </li>
            ))}
          </ul>
        </div>

        <div>
          <p className="mb-1 text-zinc-500">Opportunities</p>
          <ul className="space-y-1">
            {analysis.opportunities.map((opportunity) => (
              <li key={opportunity} className="rounded-lg border border-emerald-500/20 bg-emerald-500/8 px-2 py-1 text-emerald-200">
                {opportunity}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <p className="mt-3 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-100">
        Next best action: {analysis.nextBestAction}
      </p>
    </article>
  );
}
