import { listWhatsAppLeadMessages, type WhatsAppDirection } from "../db/whatsappLeadsRepo.js";
import {
  createWhatsAppAgentRun,
  getLatestWhatsAppAgentRunByLead,
  type WhatsAppAgentRunStatus,
  upsertWhatsAppAgentLeadState,
  upsertWhatsAppAgentRunStep,
  updateWhatsAppAgentRun
} from "../db/whatsappAgentRunsRepo.js";
import { buildBrandGuardianFromContext } from "./whatsappBrandGuardianService.js";
import { computePriorityScoreDeterministic } from "./whatsappPriorityDeskService.js";
import { buildReplyGeneratorFromContext } from "./whatsappReplyGeneratorService.js";
import { detectStageFromTranscript } from "./whatsappStageDetectionService.js";
import { buildStrategicAdvisorFromContext } from "./whatsappStrategicAdvisorService.js";
import { buildLeadTranscript, type LeadTranscriptResult } from "./whatsappTranscriptFormatter.js";

export type WhatsAppAgentStepName =
  | "stage_detection"
  | "fact_extraction"
  | "priority_scoring"
  | "strategic_advisor"
  | "reply_generator"
  | "brand_guardian";

type PrioritySnapshot = {
  priorityScore: number;
  priorityBand: string;
  needsReply: boolean;
  waitingSinceMinutes: number;
  stage: string;
  urgency: string;
  paymentIntent: boolean;
  dropoffRisk: string;
  recommendedAction: string;
  commercialPriority: string;
  estimatedHeat: string;
  reasons: string[];
};

export type WhatsAppAgentOrchestratorResult = {
  runId: string;
  leadId: string;
  messageId: string;
  status: WhatsAppAgentRunStatus;
  stageAnalysis: Record<string, unknown> | null;
  strategy: Record<string, unknown> | null;
  priority: Record<string, unknown> | null;
  topReplyCard: Record<string, unknown> | null;
};

export class WhatsAppAgentOrchestratorError extends Error {
  code: string;
  step: WhatsAppAgentStepName | "transcript" | "latest_run";

  constructor(code: string, step: WhatsAppAgentStepName | "transcript" | "latest_run", message: string) {
    super(message);
    this.code = code;
    this.step = step;
  }
}

type OrchestratorDeps = {
  getTranscript: (leadId: string) => Promise<LeadTranscriptResult>;
  detectStage: (input: { leadId: string; transcript: LeadTranscriptResult }) => ReturnType<typeof detectStageFromTranscript>;
  getMessages: (leadId: string) => Promise<Array<{ direction: WhatsAppDirection; createdAt: string }>>;
  getStrategicAdvisor: (input: {
    leadId: string;
    transcript: LeadTranscriptResult;
    stageAnalysis: Parameters<typeof buildStrategicAdvisorFromContext>[0]["stageAnalysis"];
  }) => ReturnType<typeof buildStrategicAdvisorFromContext>;
  getReplyGenerator: (input: {
    leadId: string;
    transcript: LeadTranscriptResult;
    stageAnalysis: Parameters<typeof buildReplyGeneratorFromContext>[0]["stageAnalysis"];
    strategy: Parameters<typeof buildReplyGeneratorFromContext>[0]["strategy"];
  }) => ReturnType<typeof buildReplyGeneratorFromContext>;
  getBrandGuardian: (input: {
    leadId: string;
    transcript: LeadTranscriptResult;
    stageAnalysis: Parameters<typeof buildBrandGuardianFromContext>[0]["stageAnalysis"];
    strategy: Parameters<typeof buildBrandGuardianFromContext>[0]["strategy"];
    replyOptions: Parameters<typeof buildBrandGuardianFromContext>[0]["replyOptions"];
  }) => ReturnType<typeof buildBrandGuardianFromContext>;
  createRun: typeof createWhatsAppAgentRun;
  updateRun: typeof updateWhatsAppAgentRun;
  updateStep: typeof upsertWhatsAppAgentRunStep;
  upsertLeadState: typeof upsertWhatsAppAgentLeadState;
  getLatestRun: typeof getLatestWhatsAppAgentRunByLead;
  nowIso: () => string;
};

function defaultDeps(): OrchestratorDeps {
  return {
    getTranscript: (leadId) => buildLeadTranscript(leadId, 30),
    detectStage: (input) => detectStageFromTranscript({ leadId: input.leadId, transcript: input.transcript }),
    getMessages: async (leadId) => {
      const rows = await listWhatsAppLeadMessages(leadId, { limit: 50, order: "asc" });
      return rows.map((m) => ({ direction: m.direction, createdAt: m.createdAt }));
    },
    getStrategicAdvisor: (input) =>
      buildStrategicAdvisorFromContext({
        leadId: input.leadId,
        transcript: input.transcript,
        stageAnalysis: input.stageAnalysis
      }),
    getReplyGenerator: (input) =>
      buildReplyGeneratorFromContext({
        leadId: input.leadId,
        transcript: input.transcript,
        stageAnalysis: input.stageAnalysis,
        strategy: input.strategy
      }),
    getBrandGuardian: (input) =>
      buildBrandGuardianFromContext({
        leadId: input.leadId,
        transcript: input.transcript,
        stageAnalysis: input.stageAnalysis,
        strategy: input.strategy,
        replyOptions: input.replyOptions
      }),
    createRun: createWhatsAppAgentRun,
    updateRun: updateWhatsAppAgentRun,
    updateStep: upsertWhatsAppAgentRunStep,
    upsertLeadState: upsertWhatsAppAgentLeadState,
    getLatestRun: getLatestWhatsAppAgentRunByLead,
    nowIso: () => new Date().toISOString()
  };
}

const STEP_ORDER: Record<WhatsAppAgentStepName, number> = {
  stage_detection: 1,
  fact_extraction: 2,
  priority_scoring: 3,
  strategic_advisor: 4,
  reply_generator: 5,
  brand_guardian: 6
};

function toMs(value: string): number {
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : NaN;
}

function computeTiming(messages: Array<{ direction: WhatsAppDirection; createdAt: string }>): {
  needsReply: boolean;
  waitingSinceMinutes: number;
} {
  const sorted = messages
    .slice()
    .sort((a, b) => toMs(a.createdAt) - toMs(b.createdAt));
  const latest = sorted.length ? sorted[sorted.length - 1] : null;
  if (!latest || latest.direction !== "IN") {
    return { needsReply: false, waitingSinceMinutes: 0 };
  }
  const now = Date.now();
  const anchor = toMs(latest.createdAt);
  const waitingSinceMinutes = Number.isFinite(anchor) ? Math.max(0, Math.round((now - anchor) / 60000)) : 0;
  return { needsReply: true, waitingSinceMinutes };
}

async function markStep(
  deps: OrchestratorDeps,
  runId: string,
  stepName: WhatsAppAgentStepName,
  status: "running" | "completed" | "failed" | "skipped",
  input?: {
    provider?: string | null;
    output?: Record<string, unknown> | null;
    error?: string | null;
  }
): Promise<void> {
  const nowIso = deps.nowIso();
  await deps.updateStep({
    runId,
    stepName,
    stepOrder: STEP_ORDER[stepName],
    status,
    provider: input?.provider ?? null,
    startedAt: status === "running" ? nowIso : undefined,
    finishedAt: status === "completed" || status === "failed" || status === "skipped" ? nowIso : undefined,
    outputJson: input?.output ?? null,
    error: input?.error ?? null
  });
}

function toSafeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error || "unknown_error");
  return text.slice(0, 300);
}

function pickTopReplyCard(input: {
  brandReview: Record<string, unknown> | null;
  replyOptions: Record<string, unknown> | null;
}): Record<string, unknown> | null {
  const brandOptions = input.brandReview && Array.isArray(input.brandReview.reply_options)
    ? input.brandReview.reply_options
    : null;
  if (brandOptions && brandOptions.length > 0 && brandOptions[0] && typeof brandOptions[0] === "object") {
    return brandOptions[0] as Record<string, unknown>;
  }
  const replyOptions = input.replyOptions && Array.isArray(input.replyOptions.reply_options)
    ? input.replyOptions.reply_options
    : null;
  if (replyOptions && replyOptions.length > 0 && replyOptions[0] && typeof replyOptions[0] === "object") {
    return replyOptions[0] as Record<string, unknown>;
  }
  return null;
}

export async function runWhatsAppAgentOrchestrator(
  input: { leadId: string; messageId: string; trigger?: string | null },
  depsOverride?: Partial<OrchestratorDeps>
): Promise<WhatsAppAgentOrchestratorResult> {
  const deps: OrchestratorDeps = { ...defaultDeps(), ...(depsOverride || {}) };
  const leadId = String(input.leadId || "").trim();
  const messageId = String(input.messageId || "").trim();
  if (!leadId) throw new WhatsAppAgentOrchestratorError("invalid_lead_id", "transcript", "Lead ID is required");
  if (!messageId) throw new WhatsAppAgentOrchestratorError("invalid_message_id", "transcript", "Message ID is required");

  const run = await deps.createRun({ leadId, messageId, status: "running" });
  let stageAnalysis: Record<string, unknown> | null = null;
  let facts: Record<string, unknown> | null = null;
  let priorityItem: PrioritySnapshot | null = null;
  let strategy: Record<string, unknown> | null = null;
  let replyOptions: Record<string, unknown> | null = null;
  let brandReview: Record<string, unknown> | null = null;
  let finalStatus: WhatsAppAgentRunStatus = "completed";
  let topReplyCard: Record<string, unknown> | null = null;
  const providers: Record<string, string> = {};

  let transcript: LeadTranscriptResult;
  try {
    transcript = await deps.getTranscript(leadId);
  } catch (error) {
    await deps.updateRun({ runId: run.id, status: "failed" });
    throw new WhatsAppAgentOrchestratorError("transcript_failed", "transcript", toSafeError(error));
  }
  if (!transcript.transcript || transcript.transcriptLength < 30 || transcript.messageCount < 1) {
    await deps.updateRun({ runId: run.id, status: "failed" });
    throw new WhatsAppAgentOrchestratorError("transcript_too_short", "transcript", "Transcript too short for orchestrator");
  }

  try {
    await markStep(deps, run.id, "stage_detection", "running");
    const stage = await deps.detectStage({ leadId, transcript });
    stageAnalysis = stage.analysis as unknown as Record<string, unknown>;
    providers.stage_detection = stage.provider;
    await markStep(deps, run.id, "stage_detection", "completed", {
      provider: stage.provider,
      output: { analysis: stage.analysis }
    });
  } catch (error) {
    const safeError = toSafeError(error);
    await markStep(deps, run.id, "stage_detection", "failed", { error: safeError });
    await markStep(deps, run.id, "fact_extraction", "skipped", { error: "stage_detection_failed" });
    await markStep(deps, run.id, "priority_scoring", "skipped", { error: "stage_detection_failed" });
    await markStep(deps, run.id, "strategic_advisor", "skipped", { error: "stage_detection_failed" });
    await markStep(deps, run.id, "reply_generator", "skipped", { error: "stage_detection_failed" });
    await markStep(deps, run.id, "brand_guardian", "skipped", { error: "stage_detection_failed" });
    await deps.updateRun({ runId: run.id, status: "failed" });
    return {
      runId: run.id,
      leadId,
      messageId,
      status: "failed",
      stageAnalysis: null,
      strategy: null,
      priority: null,
      topReplyCard: null
    };
  }

  try {
    await markStep(deps, run.id, "fact_extraction", "running");
    facts = stageAnalysis && stageAnalysis.facts && typeof stageAnalysis.facts === "object"
      ? (stageAnalysis.facts as Record<string, unknown>)
      : {};
    await markStep(deps, run.id, "fact_extraction", "completed", { output: { facts } });
  } catch (error) {
    finalStatus = "partial";
    await markStep(deps, run.id, "fact_extraction", "failed", { error: toSafeError(error) });
  }

  try {
    await markStep(deps, run.id, "priority_scoring", "running");
    const messages = await deps.getMessages(leadId);
    const timing = computeTiming(messages);
    const scored = computePriorityScoreDeterministic({
      stage: String(stageAnalysis?.stage || ""),
      urgency: String(stageAnalysis?.urgency || "low"),
      paymentIntent: Boolean(stageAnalysis?.payment_intent),
      dropoffRisk: String(stageAnalysis?.dropoff_risk || "low"),
      recommendedAction: String(stageAnalysis?.recommended_next_action || "wait"),
      commercialPriority: "medium",
      needsReply: timing.needsReply,
      waitingSinceMinutes: timing.waitingSinceMinutes
    });
    priorityItem = {
      priorityScore: scored.priorityScore,
      priorityBand: scored.priorityBand,
      needsReply: timing.needsReply,
      waitingSinceMinutes: timing.waitingSinceMinutes,
      stage: String(stageAnalysis?.stage || ""),
      urgency: String(stageAnalysis?.urgency || "low"),
      paymentIntent: Boolean(stageAnalysis?.payment_intent),
      dropoffRisk: String(stageAnalysis?.dropoff_risk || "low"),
      recommendedAction: String(stageAnalysis?.recommended_next_action || "wait"),
      commercialPriority: "medium",
      estimatedHeat: scored.estimatedHeat,
      reasons: scored.reasons
    };
    await markStep(deps, run.id, "priority_scoring", "completed", { output: priorityItem });
  } catch (error) {
    finalStatus = "partial";
    await markStep(deps, run.id, "priority_scoring", "failed", { error: toSafeError(error) });
  }

  try {
    await markStep(deps, run.id, "strategic_advisor", "running");
    const strategic = await deps.getStrategicAdvisor({
      leadId,
      transcript,
      stageAnalysis: stageAnalysis as Parameters<typeof buildStrategicAdvisorFromContext>[0]["stageAnalysis"]
    });
    strategy = strategic.strategy as unknown as Record<string, unknown>;
    providers.strategic_advisor = strategic.provider;
    await markStep(deps, run.id, "strategic_advisor", "completed", {
      provider: strategic.provider,
      output: { strategy: strategic.strategy }
    });
  } catch (error) {
    finalStatus = "partial";
    await markStep(deps, run.id, "strategic_advisor", "failed", { error: toSafeError(error) });
    await markStep(deps, run.id, "reply_generator", "skipped", { error: "strategic_advisor_failed" });
    await markStep(deps, run.id, "brand_guardian", "skipped", { error: "strategic_advisor_failed" });
    await deps.upsertLeadState({
      leadId,
      latestRunId: run.id,
      latestMessageId: messageId,
      stageAnalysis,
      facts,
      priorityItem,
      strategy,
      replyOptions: null,
      brandReview: null,
      topReplyCard: null,
      providers
    });
    await deps.updateRun({ runId: run.id, status: finalStatus });
    return {
      runId: run.id,
      leadId,
      messageId,
      status: finalStatus,
      stageAnalysis,
      strategy,
      priority: priorityItem,
      topReplyCard: null
    };
  }

  try {
    await markStep(deps, run.id, "reply_generator", "running");
    const reply = await deps.getReplyGenerator({
      leadId,
      transcript,
      stageAnalysis: stageAnalysis as Parameters<typeof buildReplyGeneratorFromContext>[0]["stageAnalysis"],
      strategy: strategy as Parameters<typeof buildReplyGeneratorFromContext>[0]["strategy"]
    });
    replyOptions = reply.replyOptions as unknown as Record<string, unknown>;
    providers.reply_generator = reply.provider;
    await markStep(deps, run.id, "reply_generator", "completed", {
      provider: reply.provider,
      output: { replyOptions: reply.replyOptions }
    });
  } catch (error) {
    finalStatus = "partial";
    await markStep(deps, run.id, "reply_generator", "failed", { error: toSafeError(error) });
    await markStep(deps, run.id, "brand_guardian", "skipped", { error: "reply_generator_failed" });
    topReplyCard = pickTopReplyCard({ brandReview: null, replyOptions });
    await deps.upsertLeadState({
      leadId,
      latestRunId: run.id,
      latestMessageId: messageId,
      stageAnalysis,
      facts,
      priorityItem,
      strategy,
      replyOptions,
      brandReview: null,
      topReplyCard,
      providers
    });
    await deps.updateRun({ runId: run.id, status: finalStatus });
    return {
      runId: run.id,
      leadId,
      messageId,
      status: finalStatus,
      stageAnalysis,
      strategy,
      priority: priorityItem,
      topReplyCard
    };
  }

  try {
    await markStep(deps, run.id, "brand_guardian", "running");
    const review = await deps.getBrandGuardian({
      leadId,
      transcript,
      stageAnalysis: stageAnalysis as Parameters<typeof buildBrandGuardianFromContext>[0]["stageAnalysis"],
      strategy: strategy as Parameters<typeof buildBrandGuardianFromContext>[0]["strategy"],
      replyOptions: replyOptions as Parameters<typeof buildBrandGuardianFromContext>[0]["replyOptions"]
    });
    brandReview = review.review as unknown as Record<string, unknown>;
    providers.brand_guardian = review.provider;
    await markStep(deps, run.id, "brand_guardian", "completed", {
      provider: review.provider,
      output: { review: review.review }
    });
  } catch (error) {
    finalStatus = "partial";
    await markStep(deps, run.id, "brand_guardian", "failed", { error: toSafeError(error) });
  }

  topReplyCard = pickTopReplyCard({ brandReview, replyOptions });
  await deps.upsertLeadState({
    leadId,
    latestRunId: run.id,
    latestMessageId: messageId,
    stageAnalysis,
    facts,
    priorityItem,
    strategy,
    replyOptions,
    brandReview,
    topReplyCard,
    providers
  });
  await deps.updateRun({ runId: run.id, status: finalStatus });

  return {
    runId: run.id,
    leadId,
    messageId,
    status: finalStatus,
    stageAnalysis,
    strategy,
    priority: priorityItem,
    topReplyCard
  };
}

export function triggerWhatsAppAgentOrchestratorForInbound(
  input: { leadId: string; messageId: string; trigger?: string | null },
  depsOverride?: Partial<OrchestratorDeps>
): void {
  const leadId = String(input.leadId || "").trim();
  const messageId = String(input.messageId || "").trim();
  if (!leadId || !messageId) return;
  setImmediate(() => {
    void runWhatsAppAgentOrchestrator(
      { leadId, messageId, trigger: input.trigger || "zoko_inbound_webhook" },
      depsOverride
    ).catch((error) => {
      console.error("[whatsapp-agent-orchestrator] async_run_failed", {
        leadId,
        messageId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  });
}

export async function getLatestWhatsAppAgentRunSnapshot(
  leadId: string,
  depsOverride?: Partial<Pick<OrchestratorDeps, "getLatestRun">>
): Promise<{
  run: {
    id: string;
    status: WhatsAppAgentRunStatus;
    startedAt: string;
    finishedAt: string | null;
  } | null;
  steps: Array<{
    stepName: string;
    status: string;
    provider: string | null;
    error: string | null;
  }>;
}> {
  const safeLeadId = String(leadId || "").trim();
  if (!safeLeadId) {
    throw new WhatsAppAgentOrchestratorError("invalid_lead_id", "latest_run", "Lead ID is required");
  }
  const getLatestRun = depsOverride?.getLatestRun || defaultDeps().getLatestRun;
  const latest = await getLatestRun(safeLeadId);
  if (!latest) return { run: null, steps: [] };
  return {
    run: {
      id: latest.run.id,
      status: latest.run.status,
      startedAt: latest.run.startedAt,
      finishedAt: latest.run.finishedAt
    },
    steps: latest.steps.map((step) => ({
      stepName: step.stepName,
      status: step.status,
      provider: step.provider,
      error: step.error
    }))
  };
}
