import { StrategicAnalysis } from "../types.js";
import { StatusBadge } from "./StatusBadge.js";

interface StrategicAnalysisCardProps {
  analysis: StrategicAnalysis;
  rationale?: string;
}

function formatToken(value: string): string {
  return value
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function StrategicAnalysisCard({ analysis, rationale }: StrategicAnalysisCardProps) {
  const effectiveRationale = rationale ?? analysis.rationale;

  return (
    <article className="ml-panel rounded-2xl p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-slate-100">Strategic Analysis</h3>
        <div className="flex items-center gap-2">
          <span className="ml-chip rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-300">
            {formatToken(analysis.probableStage)}
          </span>
          <StatusBadge value={analysis.priorityRecommendation} />
        </div>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
        <div className="ml-panel-soft rounded-lg px-2.5 py-2">
          <p className="text-[10px] uppercase tracking-[0.1em] text-slate-500">Stage confidence</p>
          <p className="mt-1 font-semibold text-slate-100">{Math.round(analysis.stageConfidence * 100)}%</p>
        </div>
        <div className="ml-panel-soft rounded-lg px-2.5 py-2">
          <p className="text-[10px] uppercase tracking-[0.1em] text-slate-500">Momentum</p>
          <p className="mt-1 font-semibold text-slate-100">{formatToken(analysis.momentum)}</p>
        </div>
        <div className="ml-panel-soft rounded-lg px-2.5 py-2">
          <p className="text-[10px] uppercase tracking-[0.1em] text-slate-500">Human approval</p>
          <p className="mt-1 font-semibold text-slate-100">{analysis.humanApprovalRequired ? "Required" : "Not required"}</p>
        </div>
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
          <p className="mb-1 text-slate-500">Missing information</p>
          {analysis.missingInformation.length ? (
            <ul className="space-y-1">
              {analysis.missingInformation.map((item) => (
                <li key={item} className="rounded-lg border border-amber-300/25 bg-amber-500/10 px-2 py-1 text-amber-100">
                  {item}
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-lg border border-emerald-300/22 bg-emerald-500/10 px-2 py-1 text-emerald-100">No missing information detected.</p>
          )}
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
        <span className="font-semibold">Next best action:</span> {formatToken(analysis.nextBestAction)}
      </p>
      <p className="mt-2 rounded-xl border border-slate-500/25 bg-slate-900/60 px-3 py-2 text-xs leading-relaxed text-slate-300">
        <span className="font-semibold text-slate-200">Reply objective:</span> {analysis.replyObjective}
      </p>

      {effectiveRationale ? (
        <p className="mt-2 rounded-xl border border-slate-500/25 bg-slate-900/60 px-3 py-2 text-xs leading-relaxed text-slate-300">
          <span className="font-semibold text-slate-200">Strategy rationale:</span> {effectiveRationale}
        </p>
      ) : null}
    </article>
  );
}
