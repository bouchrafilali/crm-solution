import { motion } from "framer-motion";
import { useMemo } from "react";
import { LearningEvent } from "../types.js";
import { SectionHeader } from "../components/SectionHeader.js";
import { byId } from "../mock-data.js";

interface LearningPageProps {
  learningEvents: LearningEvent[];
}

export function LearningPage({ learningEvents }: LearningPageProps) {
  const patternCounts = useMemo(() => {
    const countMap = new Map<string, number>();
    for (const event of learningEvents) {
      countMap.set(event.correctionPattern, (countMap.get(event.correctionPattern) ?? 0) + 1);
    }
    return Array.from(countMap.entries())
      .map(([pattern, count]) => ({ pattern, count }))
      .sort((a, b) => b.count - a.count);
  }, [learningEvents]);

  const improvementCandidates = [
    {
      title: "Prompt to revise",
      description: "Tighten French response prompt to cap verbosity and force one clear CTA.",
      owner: "Reply Draft Agent"
    },
    {
      title: "Rule to tighten",
      description: "Block any price framing before qualification completeness reaches required threshold.",
      owner: "Human Approval Agent"
    },
    {
      title: "Agent logic to review",
      description: "Add delivery-commitment guardrail in strategic analysis when ops capacity is uncertain.",
      owner: "Strategic Advisor Agent"
    }
  ];

  return (
    <motion.div key="learning" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <SectionHeader title="Learning" subtitle="Monitor how human corrections improve model behavior and operational quality." />

      <section className="ml-panel rounded-2xl p-4">
        <h3 className="text-sm font-semibold text-slate-100">Recent Corrections</h3>
        <div className="ml-table-shell mt-3 overflow-x-auto rounded-xl">
          <table className="ml-table w-full min-w-[960px] text-left text-xs">
            <thead>
              <tr>
                <th className="px-3 py-3">Timestamp</th>
                <th className="px-3 py-3">Lead</th>
                <th className="px-3 py-3">AI Suggestion</th>
                <th className="px-3 py-3">Final Human Version</th>
                <th className="px-3 py-3">Delta Summary</th>
              </tr>
            </thead>
            <tbody>
              {learningEvents.map((event) => (
                <tr key={event.id}>
                  <td className="ml-code px-3 py-3 text-[11px] text-slate-400">{event.timestamp}</td>
                  <td className="px-3 py-3 font-medium text-slate-200">{byId.lead[event.leadId]?.name ?? event.leadId}</td>
                  <td className="max-w-[280px] truncate px-3 py-3 text-slate-400">{event.aiSuggestion}</td>
                  <td className="max-w-[280px] truncate px-3 py-3 text-slate-300">{event.finalHumanVersion}</td>
                  <td className="px-3 py-3 text-slate-400">{event.deltaSummary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <section className="ml-panel rounded-2xl p-4">
          <h3 className="text-sm font-semibold text-slate-100">Frequent Correction Patterns</h3>
          <div className="mt-3 space-y-2">
            {patternCounts.map((entry) => (
              <div key={entry.pattern} className="ml-panel-soft flex items-center justify-between rounded-xl px-3 py-2">
                <p className="text-sm text-slate-200">{entry.pattern}</p>
                <span className="ml-chip rounded-full px-2 py-0.5 text-xs text-slate-300">{entry.count}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="ml-panel rounded-2xl p-4">
          <h3 className="text-sm font-semibold text-slate-100">Improvement Candidates</h3>
          <div className="mt-3 space-y-2">
            {improvementCandidates.map((candidate) => (
              <article key={candidate.title} className="ml-panel-soft rounded-xl p-3">
                <p className="text-sm font-medium text-slate-200">{candidate.title}</p>
                <p className="mt-1 text-xs leading-relaxed text-slate-400">{candidate.description}</p>
                <p className="mt-2 text-[11px] text-slate-500">Owner: {candidate.owner}</p>
              </article>
            ))}
          </div>
        </section>
      </div>
    </motion.div>
  );
}
