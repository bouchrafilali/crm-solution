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

      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-4">
        <h3 className="text-sm font-semibold text-zinc-100">Recent Corrections</h3>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[960px] text-left text-xs">
            <thead className="text-zinc-500">
              <tr>
                <th className="py-2">Timestamp</th>
                <th className="py-2">Lead</th>
                <th className="py-2">AI Suggestion</th>
                <th className="py-2">Final Human Version</th>
                <th className="py-2">Delta Summary</th>
              </tr>
            </thead>
            <tbody>
              {learningEvents.map((event) => (
                <tr key={event.id} className="border-t border-zinc-800 text-zinc-300">
                  <td className="py-2 text-zinc-400">{event.timestamp}</td>
                  <td className="py-2">{byId.lead[event.leadId]?.name ?? event.leadId}</td>
                  <td className="max-w-[280px] truncate py-2 text-zinc-400">{event.aiSuggestion}</td>
                  <td className="max-w-[280px] truncate py-2">{event.finalHumanVersion}</td>
                  <td className="py-2 text-zinc-400">{event.deltaSummary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-4">
          <h3 className="text-sm font-semibold text-zinc-100">Frequent Correction Patterns</h3>
          <div className="mt-3 space-y-2">
            {patternCounts.map((entry) => (
              <div key={entry.pattern} className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-950/70 px-3 py-2">
                <p className="text-sm text-zinc-200">{entry.pattern}</p>
                <span className="rounded-full border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-xs text-zinc-400">{entry.count}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-4">
          <h3 className="text-sm font-semibold text-zinc-100">Improvement Candidates</h3>
          <div className="mt-3 space-y-2">
            {improvementCandidates.map((candidate) => (
              <article key={candidate.title} className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-3">
                <p className="text-sm font-medium text-zinc-200">{candidate.title}</p>
                <p className="mt-1 text-xs text-zinc-400">{candidate.description}</p>
                <p className="mt-2 text-[11px] text-zinc-500">Owner: {candidate.owner}</p>
              </article>
            ))}
          </div>
        </section>
      </div>
    </motion.div>
  );
}
