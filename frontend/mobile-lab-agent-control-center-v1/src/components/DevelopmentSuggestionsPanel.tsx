import { Agent, ApprovalItem, LearningEvent, RunRecord, StrategicAnalysis } from "../types.js";

type DevelopmentSuggestionPriority = "critical" | "high" | "medium" | "low";
type DevelopmentSuggestionCategory =
  | "runtime_reliability"
  | "run_observability"
  | "approval_workflow"
  | "learning_quality"
  | "system_brain";

interface DevelopmentSuggestion {
  id: string;
  title: string;
  priority: DevelopmentSuggestionPriority;
  category: DevelopmentSuggestionCategory;
  reason: string;
  suggestedAction: string;
  sourceSignal: string;
}

interface DevelopmentSuggestionInput {
  runs: RunRecord[];
  agents: Agent[];
  approvals: ApprovalItem[];
  learningEvents: LearningEvent[];
  strategicAnalyses: StrategicAnalysis[];
}

function priorityRank(priority: DevelopmentSuggestionPriority): number {
  if (priority === "critical") return 0;
  if (priority === "high") return 1;
  if (priority === "medium") return 2;
  return 3;
}

function formatCategory(category: DevelopmentSuggestionCategory): string {
  return category.replaceAll("_", " ");
}

function buildDevelopmentSuggestions(input: DevelopmentSuggestionInput): DevelopmentSuggestion[] {
  const runErrors = input.runs.filter((run) => run.status === "error" || run.status === "blocked");
  const waitingStates = input.runs.filter(
    (run) => run.status === "waiting_human_approval" || run.status === "waiting_human_input" || run.status === "pending"
  );
  const pendingApprovals = input.approvals.filter((approval) => approval.decision === "pending");
  const stalePendingApprovals = pendingApprovals.filter((approval) => {
    const createdAt = Date.parse(approval.requestedAt);
    if (Number.isNaN(createdAt)) return false;
    return Date.now() - createdAt > 12 * 60 * 60 * 1000;
  });
  const seenRunStates = new Set(input.runs.map((run) => run.status));
  const expectedStates: Array<RunRecord["status"]> = [
    "success",
    "error",
    "blocked",
    "waiting_human_input",
    "waiting_human_approval"
  ];
  const missingStates = expectedStates.filter((state) => !seenRunStates.has(state));

  const suggestions: DevelopmentSuggestion[] = [];

  if (runErrors.length > 0) {
    suggestions.push({
      id: "stabilize-run-errors",
      title: "Reduce blocked and failed run volume",
      priority: runErrors.length >= 10 ? "critical" : "high",
      category: "runtime_reliability",
      reason: `${runErrors.length} blocked/error runs detected in current telemetry.`,
      suggestedAction: "Add retry backoff + provider failover guardrails for high-error agent paths.",
      sourceSignal: "run_errors"
    });
  }

  if (missingStates.length >= 2 && input.runs.length > 0) {
    suggestions.push({
      id: "expand-run-state-coverage",
      title: "Fill missing run state coverage",
      priority: "high",
      category: "run_observability",
      reason: `Run timeline is missing ${missingStates.length} expected states (${missingStates.join(", ")}).`,
      suggestedAction: "Normalize run status mapping and enforce state emission at every orchestration step.",
      sourceSignal: "missing_run_states"
    });
  }

  if (stalePendingApprovals.length > 0 || waitingStates.length > 0) {
    suggestions.push({
      id: "approval-persistence-gaps",
      title: "Harden approval persistence and resolution flow",
      priority: stalePendingApprovals.length > 0 ? "high" : "medium",
      category: "approval_workflow",
      reason: `${pendingApprovals.length} approvals pending, with ${stalePendingApprovals.length} stale >12h and ${waitingStates.length} waiting runs.`,
      suggestedAction: "Persist approval state transitions with SLA timestamps and add escalation jobs for stalled items.",
      sourceSignal: "approval_persistence_gaps"
    });
  }

  if (input.learningEvents.length === 0) {
    suggestions.push({
      id: "learning-loop-thin",
      title: "Increase learning loop signal density",
      priority: "medium",
      category: "learning_quality",
      reason: "No learning events available for model correction feedback.",
      suggestedAction: "Capture operator edits as structured deltas and feed them into suggestion quality scoring.",
      sourceSignal: "learning_events_empty"
    });
  }

  const likelyMockUsage =
    input.runs.length < 3 &&
    input.learningEvents.length < 2 &&
    input.agents.every((agent) => agent.totalRuns === 0 || agent.status === "idle");
  const systemBrainMockMode = input.strategicAnalyses.length === 0 || likelyMockUsage;
  if (systemBrainMockMode) {
    suggestions.push({
      id: "system-brain-mock-mode",
      title: "Replace system brain mock placeholders with live telemetry",
      priority: "medium",
      category: "system_brain",
      reason: "System behavior indicates mock/minimal data mode in strategic supervision paths.",
      suggestedAction: "Wire strategic analysis generation to runtime traces and expose explicit live/mock mode health checks.",
      sourceSignal: "system_brain_mock_mode"
    });
  }

  if (suggestions.length === 0) {
    suggestions.push({
      id: "baseline-observability-upgrade",
      title: "Add proactive observability tasks",
      priority: "low",
      category: "run_observability",
      reason: "Current dashboard signals look stable with no urgent gaps detected.",
      suggestedAction: "Add canary alerts for error spikes and weekly drift checks across run outcomes.",
      sourceSignal: "stable_baseline"
    });
  }

  return suggestions.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority)).slice(0, 6);
}

const priorityToneMap: Record<DevelopmentSuggestionPriority, string> = {
  critical: "border-rose-300/35 bg-rose-500/12 text-rose-100",
  high: "border-amber-300/35 bg-amber-500/12 text-amber-100",
  medium: "border-cyan-300/35 bg-cyan-500/12 text-cyan-100",
  low: "border-slate-300/25 bg-slate-500/10 text-slate-200"
};

export function DevelopmentSuggestionsPanel({ input }: { input: DevelopmentSuggestionInput }) {
  const suggestions = buildDevelopmentSuggestions(input);

  return (
    <section className="ml-panel mt-4 rounded-2xl p-4">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.12em] text-cyan-300">AI Suggested Development Tasks</p>
          <p className="mt-1 text-xs text-slate-400">
            Product and system improvements inferred from runs, approvals, learning events, and agent telemetry.
          </p>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {suggestions.map((suggestion) => (
          <article key={suggestion.id} className="ml-panel-soft rounded-xl p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className={`ml-chip rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] ${priorityToneMap[suggestion.priority]}`}>
                {suggestion.priority}
              </span>
              <span className="text-[10px] uppercase tracking-[0.09em] text-slate-500">{formatCategory(suggestion.category)}</span>
            </div>
            <h4 className="text-sm font-semibold text-slate-100">{suggestion.title}</h4>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-300">{suggestion.reason}</p>
            <p className="mt-2 text-xs text-slate-200">
              <span className="text-slate-500">Suggested fix:</span> {suggestion.suggestedAction}
            </p>
            <p className="mt-2 text-[11px] text-slate-500">
              Source signal: <span className="ml-code text-slate-400">{suggestion.sourceSignal}</span>
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}
