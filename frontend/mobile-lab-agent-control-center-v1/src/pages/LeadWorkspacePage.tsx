import { AnimatePresence, motion } from "framer-motion";
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
import { TraceTimeline } from "../components/TraceTimeline.js";

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

const sourceChannelByLead: Record<string, string> = {
  "lead-nadia-belhaj": "WhatsApp Concierge",
  "lead-camille-roux": "WhatsApp Organic",
  "lead-dalia-karim": "VIP Follow-up",
  "lead-omar-hadid": "Paid Campaign",
  "lead-sara-elhadi": "WhatsApp Organic",
  "lead-ines-lamrani": "Referral",
  "lead-julien-fabre": "VIP Follow-up",
  "lead-leila-benna": "Concierge Referral"
};

const confidenceByReplyIndex = [94, 88, 82];

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
  const [traceOpen, setTraceOpen] = useState(false);
  const [conversationLoading, setConversationLoading] = useState(false);

  const latestRun = useMemo(() => runs.find((run) => run.leadId === lead.id) ?? null, [lead.id, runs]);
  const latestLearning = useMemo(() => learningEvents.find((event) => event.leadId === lead.id) ?? learningEvents[0] ?? null, [lead.id, learningEvents]);
  const leadMessages = useMemo(() => messages.filter((message) => message.leadId === lead.id), [messages, lead.id]);

  const strategicRationale = useMemo(() => {
    if (analysis.rationale) return analysis.rationale;
    if (latestRun?.trace?.decisionSummary) return latestRun.trace.decisionSummary;
    return "Prioritize high-intent progression while minimizing policy risk and maintaining premium tone discipline.";
  }, [analysis.rationale, latestRun]);

  const selectedReply = suggestedReplies.find((reply) => reply.id === selectedReplyId) ?? suggestedReplies[0] ?? null;

  function triggerConversationAction(action: "analyze" | "generate" | "missing_info" | "task") {
    if (action === "analyze" || action === "generate") {
      setConversationLoading(true);
      window.setTimeout(() => setConversationLoading(false), 650);
    }
  }

  return (
    <motion.div key="lead-workspace" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <SectionHeader
        title="Lead Workspace"
        subtitle="Unified lead operations surface for intelligence, conversation context, and AI-guided execution."
        action={
          <button type="button" onClick={onBackToLeads} className="ml-button rounded-lg px-3 py-1.5 text-xs font-medium">
            Back to Leads
          </button>
        }
      />

      <div className="ml-panel mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl p-3.5">
        <div className="flex min-w-0 items-center gap-3">
          <span className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-500/70 bg-slate-800 text-xs font-semibold text-slate-100">
            {lead.name
              .split(/\s+/)
              .slice(0, 2)
              .map((chunk) => chunk[0]?.toUpperCase() ?? "")
              .join("")}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-100">{lead.name}</p>
            <p className="text-xs text-slate-400">
              {lead.country} • {lead.language} • {sourceChannelByLead[lead.id] ?? "WhatsApp"}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge value={lead.approvalStatus === "none" ? "approved" : lead.approvalStatus} />
          <span className="ml-chip rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-300">{lead.currentStage}</span>
          <span className="ml-chip rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-300">Priority {lead.priorityScore}</span>
          <span className="ml-chip rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-300">{formatCurrency(lead.estimatedValue)}</span>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[0.92fr_1.28fr_1fr]">
        <section className="space-y-4 xl:sticky xl:top-4 xl:self-start">
          <article className="ml-panel rounded-2xl p-4">
            <h3 className="text-sm font-semibold text-slate-100">Commercial State</h3>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
              <Info label="Current stage" value={lead.currentStage} />
              <Info label="Priority score" value={String(lead.priorityScore)} />
              <Info label="Estimated value" value={formatCurrency(lead.estimatedValue)} />
              <Info label="Qualification" value={lead.qualificationStatus} />
              <Info label="Payment" value={lead.paymentStatus.replaceAll("_", " ")} />
              <Info label="Event date" value={lead.eventDate} />
              <Info label="Destination" value={lead.destination} />
              <Info label="Assigned" value={lead.assignedOperator} />
            </div>
          </article>

          <article className="ml-panel rounded-2xl p-4">
            <h3 className="text-sm font-semibold text-slate-100">Signals</h3>
            <div className="mt-3 flex flex-wrap gap-2">
              {lead.detectedSignals.map((signal) => (
                <SignalTag key={signal} text={signal} />
              ))}
              {lead.highValue ? <SignalTag text="High-value lead" /> : null}
              {lead.paymentIntent === "high" ? <SignalTag text="Payment intent high" /> : null}
              <SignalTag text="Event date detected" />
            </div>
          </article>

          <article className="ml-panel rounded-2xl p-4">
            <h3 className="text-sm font-semibold text-slate-100">Missing Fields</h3>
            {lead.missingFields.length === 0 ? (
              <p className="mt-3 rounded-xl border border-emerald-300/24 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-100">
                No blocker detected. Qualification is complete enough for next commercial action.
              </p>
            ) : (
              <div className="mt-3 space-y-2">
                {lead.missingFields.map((field) => (
                  <div key={field} className="rounded-xl border border-amber-300/24 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
                    {field}
                  </div>
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
            messages={leadMessages}
            leadName={lead.name}
            leadStage={lead.currentStage}
            language={lead.language}
            isLoading={conversationLoading}
            onAction={triggerConversationAction}
          />

          {selectedReply ? (
            <div className="ml-panel mt-4 rounded-2xl p-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-slate-100">Selected Reply Composer Preview</h3>
                <span className="ml-chip rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-300">
                  {selectedReply.language}
                </span>
              </div>
              <p className="mt-2 text-xs text-slate-500">{selectedReply.intent}</p>
              <p className="ml-panel-soft mt-3 rounded-xl px-3 py-2 text-sm leading-relaxed text-slate-200">{selectedReply.content}</p>
            </div>
          ) : null}
        </section>

        <section className="space-y-4 xl:sticky xl:top-4 xl:self-start">
          <StrategicAnalysisCard analysis={analysis} rationale={strategicRationale} />

          <article className="ml-panel rounded-2xl p-4">
            <h3 className="mb-3 text-sm font-semibold text-slate-100">Suggested Replies</h3>
            {suggestedReplies.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-600/35 bg-slate-900/40 px-3 py-6 text-center text-xs text-slate-500">
                No suggestions yet. Run analysis to generate premium response variants.
              </div>
            ) : (
              <div className="space-y-3">
                {suggestedReplies.slice(0, 3).map((reply, index) => (
                  <SuggestedReplyCard
                    key={reply.id}
                    reply={reply}
                    selected={selectedReplyId === reply.id}
                    onSelect={setSelectedReplyId}
                    confidence={confidenceByReplyIndex[index] ?? 80}
                    recommendation={index === 0 ? "primary" : "secondary"}
                  />
                ))}
              </div>
            )}
          </article>

          <article className="ml-panel rounded-2xl p-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-100">Agent Activity</h3>
              {latestRun ? <StatusBadge value={latestRun.status} /> : null}
            </div>
            {latestRun ? (
              <div className="mt-3 space-y-2 text-xs">
                <Info label="Last triggered agent" value={latestRun.triggeredAgentId} compact />
                <Info label="Last run time" value={latestRun.timestamp} compact />
                <div className="ml-panel-soft rounded-xl px-3 py-2">
                  <p className="text-slate-500">Trace snippet</p>
                  <p className="mt-1 leading-relaxed text-slate-300">{latestRun.decisionSummary}</p>
                </div>
                {(latestRun.status === "waiting_human_approval" || latestRun.status === "blocked") && (
                  <p className="rounded-xl border border-amber-300/24 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
                    Workflow requires intervention before automated continuation.
                  </p>
                )}
                <button type="button" onClick={() => setTraceOpen(true)} className="ml-button rounded-lg px-3 py-1.5 text-xs font-medium">
                  Open Trace Details
                </button>
              </div>
            ) : (
              <p className="mt-3 text-xs text-slate-500">No activity yet for this lead.</p>
            )}
          </article>

          <article className="ml-panel rounded-2xl p-4">
            <h3 className="text-sm font-semibold text-slate-100">Learning Snapshot</h3>
            {latestLearning ? (
              <div className="mt-3 space-y-2 text-xs">
                <p className="ml-panel-soft rounded-xl px-3 py-2 text-slate-300">
                  <span className="font-semibold text-slate-200">Latest correction:</span> {latestLearning.deltaSummary}
                </p>
                <p className="ml-panel-soft rounded-xl px-3 py-2 text-slate-300">
                  <span className="font-semibold text-slate-200">Pattern:</span> {latestLearning.correctionPattern}
                </p>
                <p className="ml-panel-soft rounded-xl px-3 py-2 text-slate-300">
                  <span className="font-semibold text-slate-200">Human final:</span> {latestLearning.finalHumanVersion}
                </p>
              </div>
            ) : (
              <p className="mt-3 text-xs text-slate-500">No learning signals yet.</p>
            )}
          </article>
        </section>
      </div>

      <AnimatePresence>
        {traceOpen && latestRun ? (
          <>
            <motion.button
              type="button"
              aria-label="Close trace drawer"
              className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[1px]"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setTraceOpen(false)}
            />

            <motion.aside
              className="fixed right-0 top-0 z-50 h-full w-full max-w-xl overflow-y-auto border-l border-slate-600/35 bg-slate-950/95 p-5 backdrop-blur-md"
              initial={{ x: 420 }}
              animate={{ x: 0 }}
              exit={{ x: 420 }}
              transition={{ duration: 0.28, ease: "easeOut" }}
            >
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold text-slate-100">Execution Trace Details</h3>
                  <p className="text-xs text-slate-400">{latestRun.id} • {latestRun.timestamp}</p>
                </div>
                <button type="button" onClick={() => setTraceOpen(false)} className="ml-button rounded-lg px-3 py-1.5 text-xs font-medium">
                  Close
                </button>
              </div>

              <div className="space-y-3">
                <section className="ml-panel-soft rounded-xl p-3">
                  <h4 className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-500">Event Context</h4>
                  <p className="mt-2 text-sm leading-relaxed text-slate-300">{latestRun.trace.eventContext}</p>
                </section>

                <section className="ml-panel-soft rounded-xl p-3">
                  <h4 className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-500">Input Snapshot</h4>
                  <ul className="mt-2 space-y-1">
                    {latestRun.trace.inputSnapshot.map((item) => (
                      <li key={item} className="ml-code rounded-lg border border-slate-600/25 bg-slate-900/60 px-2 py-1.5 text-[12px] text-slate-300">
                        {item}
                      </li>
                    ))}
                  </ul>
                </section>

                <section className="ml-panel-soft rounded-xl p-3">
                  <h4 className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-500">Trace Timeline</h4>
                  <div className="mt-3">
                    <TraceTimeline timeline={latestRun.trace.timeline} />
                  </div>
                </section>
              </div>
            </motion.aside>
          </>
        ) : null}
      </AnimatePresence>
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
