import { motion } from "framer-motion";
import { useMemo, useState } from "react";
import { LearningEvent, Lead, RunRecord, StrategicAnalysis, SuggestedReply } from "../types.js";
import { formatCurrency } from "../utils.js";
import { SectionHeader } from "../components/SectionHeader.js";
import { SignalTag } from "../components/SignalTag.js";
import { TaskList } from "../components/TaskList.js";
import { ConversationPanel } from "../components/ConversationPanel.js";
import { StrategicAnalysisCard } from "../components/StrategicAnalysisCard.js";
import { SuggestedReplyCard } from "../components/SuggestedReplyCard.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { byId } from "../mock-data.js";

interface LeadWorkspacePageProps {
  lead: Lead;
  analysis: StrategicAnalysis;
  suggestedReplies: SuggestedReply[];
  runs: RunRecord[];
  learningEvents: LearningEvent[];
  onBackToLeads: () => void;
  messages: Array<{
    id: string;
    leadId: string;
    actor: "client" | "operator" | "brand";
    text: string;
    timestamp: string;
    state: "sent" | "delivered" | "read";
    replyTo?: { actor: string; text: string };
  }>;
}

export function LeadWorkspacePage({
  lead,
  analysis,
  suggestedReplies,
  runs,
  learningEvents,
  onBackToLeads,
  messages
}: LeadWorkspacePageProps) {
  const [selectedReplyId, setSelectedReplyId] = useState<string>(suggestedReplies[0]?.id ?? "");

  const latestRun = useMemo(() => runs.find((run) => run.leadId === lead.id) ?? null, [lead.id, runs]);
  const latestLearning = useMemo(() => learningEvents.find((event) => event.leadId === lead.id) ?? learningEvents[0] ?? null, [lead.id, learningEvents]);

  return (
    <motion.div key="lead-workspace" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <SectionHeader
        title="Lead Workspace"
        subtitle="Unified lead operations surface for intelligence, conversation control, and AI-guided execution."
        action={
          <button type="button" onClick={onBackToLeads} className="ml-button rounded-lg px-3 py-1.5 text-xs font-medium">
            Back to Leads
          </button>
        }
      />

      <div className="ml-panel mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl p-3.5">
        <div className="flex min-w-0 items-center gap-3">
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-600 bg-slate-800 text-xs font-semibold text-slate-100">
            {lead.name
              .split(/\s+/)
              .slice(0, 2)
              .map((chunk) => chunk[0]?.toUpperCase() ?? "")
              .join("")}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-100">{lead.name}</p>
            <p className="text-xs text-slate-400">
              {lead.country} • {lead.language} • {lead.currentStage}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge value={lead.approvalStatus === "none" ? "approved" : lead.approvalStatus} />
          <span className="ml-chip rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-300">Priority {lead.priorityScore}</span>
          <span className="ml-chip rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-300">{formatCurrency(lead.estimatedValue)}</span>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[0.92fr_1.3fr_1fr]">
        <section className="space-y-4">
          <article className="ml-panel rounded-2xl p-4">
            <h3 className="text-sm font-semibold text-slate-100">Lead Intelligence</h3>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
              <Info label="Country" value={lead.country} />
              <Info label="Language" value={lead.language} />
              <Info label="Current stage" value={lead.currentStage} />
              <Info label="Priority score" value={String(lead.priorityScore)} />
              <Info label="Estimated value" value={formatCurrency(lead.estimatedValue)} />
              <Info label="Destination" value={lead.destination} />
              <Info label="Event date" value={lead.eventDate} />
              <Info label="Qualification" value={lead.qualificationStatus} />
              <Info label="Payment" value={lead.paymentStatus.replaceAll("_", " ")} />
            </div>
          </article>

          <article className="ml-panel rounded-2xl p-4">
            <h3 className="text-sm font-semibold text-slate-100">Detected Signals</h3>
            <div className="mt-3 flex flex-wrap gap-2">
              {lead.detectedSignals.map((signal) => (
                <SignalTag key={signal} text={signal} />
              ))}
            </div>
          </article>

          <article className="ml-panel rounded-2xl p-4">
            <h3 className="text-sm font-semibold text-slate-100">Missing Fields</h3>
            {lead.missingFields.length === 0 ? (
              <p className="mt-3 rounded-xl border border-emerald-300/24 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-100">
                Qualification complete. No blocking fields.
              </p>
            ) : (
              <div className="mt-3 flex flex-wrap gap-2">
                {lead.missingFields.map((field) => (
                  <span key={field} className="rounded-md border border-amber-300/25 bg-amber-500/10 px-2 py-1 text-xs text-amber-100">
                    {field}
                  </span>
                ))}
              </div>
            )}
          </article>

          <article className="ml-panel rounded-2xl p-4">
            <h3 className="mb-3 text-sm font-semibold text-slate-100">Open Tasks</h3>
            <TaskList tasks={lead.openTasks} />
          </article>
        </section>

        <section>
          <ConversationPanel
            messages={messages.filter((message) => message.leadId === lead.id)}
            leadName={lead.name}
            leadStage={lead.currentStage}
            language={lead.language}
          />
        </section>

        <section className="space-y-4">
          <StrategicAnalysisCard analysis={analysis} />

          <article className="ml-panel rounded-2xl p-4">
            <h3 className="mb-3 text-sm font-semibold text-slate-100">Suggested Replies</h3>
            {suggestedReplies.length === 0 ? (
              <p className="text-xs text-slate-500">No suggestions available for this lead yet.</p>
            ) : (
              <div className="space-y-3">
                {suggestedReplies.map((reply) => (
                  <SuggestedReplyCard key={reply.id} reply={reply} selected={selectedReplyId === reply.id} onSelect={setSelectedReplyId} />
                ))}
              </div>
            )}
          </article>

          <article className="ml-panel rounded-2xl p-4">
            <h3 className="text-sm font-semibold text-slate-100">Agent Activity</h3>
            {latestRun ? (
              <div className="mt-3 space-y-2 text-xs">
                <Info label="Last triggered agent" value={byId.agent[latestRun.triggeredAgentId]?.name ?? latestRun.triggeredAgentId} compact />
                <Info label="Last run time" value={latestRun.timestamp} compact />
                <div className="ml-panel-soft rounded-xl px-3 py-2">
                  <p className="text-slate-500">Current status</p>
                  <StatusBadge value={latestRun.status} className="mt-1" />
                </div>
                <div className="ml-panel-soft rounded-xl px-3 py-2">
                  <p className="text-slate-500">Trace snippet</p>
                  <p className="mt-1 leading-relaxed text-slate-300">{latestRun.decisionSummary}</p>
                </div>
              </div>
            ) : (
              <p className="mt-3 text-xs text-slate-500">No activity yet for this lead.</p>
            )}
          </article>

          <article className="ml-panel rounded-2xl p-4">
            <h3 className="text-sm font-semibold text-slate-100">Learning Snapshot</h3>
            {latestLearning ? (
              <div className="mt-3 space-y-2 text-xs">
                <p className="ml-panel-soft rounded-xl px-3 py-2 text-slate-300">Latest correction: {latestLearning.deltaSummary}</p>
                <p className="ml-panel-soft rounded-xl px-3 py-2 text-slate-300">Frequent pattern: {latestLearning.correctionPattern}</p>
              </div>
            ) : (
              <p className="mt-3 text-xs text-slate-500">No learning signals yet.</p>
            )}
          </article>
        </section>
      </div>
    </motion.div>
  );
}

function Info({ label, value, compact = false }: { label: string; value: string; compact?: boolean }) {
  return (
    <div className={`ml-panel-soft rounded-xl ${compact ? "px-3 py-2" : "px-2.5 py-2"}`}>
      <p className="text-[10px] font-semibold uppercase tracking-[0.11em] text-slate-500">{label}</p>
      <p className="mt-1 text-slate-200">{value}</p>
    </div>
  );
}
