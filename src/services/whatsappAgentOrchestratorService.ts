import { listWhatsAppLeadMessages, type WhatsAppDirection } from "../db/whatsappLeadsRepo.js";
import {
  createWhatsAppAgentRun,
  getWhatsAppAgentLeadState,
  getWhatsAppAgentRunById,
  getLatestWhatsAppAgentRunByLead,
  type WhatsAppAgentRunStatus,
  upsertWhatsAppAgentLeadState,
  upsertWhatsAppAgentRunStep,
  updateWhatsAppAgentRun
} from "../db/whatsappAgentRunsRepo.js";
import { buildBrandGuardianFromContext } from "./whatsappBrandGuardianService.js";
import { computePriorityIntelligence } from "./whatsappPriorityIntelligenceService.js";
import { buildReplyGeneratorFromContext } from "./whatsappReplyGeneratorService.js";
import { detectStageFromStateDelta, detectStageFromTranscript } from "./whatsappStageDetectionService.js";
import { buildStrategicAdvisorFromContext, buildStrategicAdvisorFromStateDelta } from "./whatsappStrategicAdvisorService.js";
import { buildLeadTranscript, type LeadTranscriptResult } from "./whatsappTranscriptFormatter.js";
import { estimateAiCostUsd, type AiUsageMetrics } from "./aiPricing.js";
import { buildLeadDeltaContext, mergeStructuredState, type DeltaMessage } from "./whatsappLeadDeltaService.js";
import { isStructuredStateComplete, normalizeStructuredLeadState } from "./whatsappLeadStateModel.js";

export type WhatsAppAgentStepName =
  | "stage_detection"
  | "fact_extraction"
  | "priority_scoring"
  | "strategic_advisor"
  | "reply_generator"
  | "brand_guardian";

type PrioritySnapshot = {
  conversion_probability: number;
  dropoff_risk: number;
  priority_score: number;
  priority_band: string;
  recommended_attention: string;
  reason_codes: string[];
  primary_reason_code: string | null;
  priorityScore: number;
  priorityBand: string;
  needsReply: boolean;
  waitingSinceMinutes: number;
  silenceSinceMinutes: number;
  stage: string;
  urgency: string;
  paymentIntent: boolean;
  dropoffRisk: number;
  recommendedAction: string;
  commercialPriority: string;
  estimatedHeat: "cold" | "warm" | "hot";
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
  reasoningSource?: "state_delta" | "transcript_fallback";
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
  getLeadState: (leadId: string) => Promise<Awaited<ReturnType<typeof getWhatsAppAgentLeadState>>>;
  detectStage: (input: { leadId: string; transcript: LeadTranscriptResult }) => ReturnType<typeof detectStageFromTranscript>;
  detectStageFromDelta: (input: {
    leadId: string;
    currentState: Record<string, unknown>;
    latestMessageDelta: Record<string, unknown>;
    recentMinimalContext: Array<Record<string, unknown>>;
  }) => ReturnType<typeof detectStageFromStateDelta>;
  getMessages: (leadId: string) => Promise<Array<{ direction: WhatsAppDirection; createdAt: string }>>;
  getRecentMessages: (leadId: string) => Promise<DeltaMessage[]>;
  getStrategicAdvisor: (input: {
    leadId: string;
    transcript: LeadTranscriptResult;
    stageAnalysis: Parameters<typeof buildStrategicAdvisorFromContext>[0]["stageAnalysis"];
  }) => ReturnType<typeof buildStrategicAdvisorFromContext>;
  getStrategicAdvisorFromDelta: (input: {
    leadId: string;
    stageAnalysis: Parameters<typeof buildStrategicAdvisorFromStateDelta>[0]["stageAnalysis"];
    currentState: Record<string, unknown>;
    latestMessageDelta: Record<string, unknown>;
    recentMinimalContext: Array<Record<string, unknown>>;
  }) => ReturnType<typeof buildStrategicAdvisorFromStateDelta>;
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
    getLeadState: (leadId) => getWhatsAppAgentLeadState(leadId),
    detectStage: (input) => detectStageFromTranscript({ leadId: input.leadId, transcript: input.transcript }),
    detectStageFromDelta: (input) =>
      detectStageFromStateDelta({
        leadId: input.leadId,
        currentState: input.currentState,
        latestMessageDelta: input.latestMessageDelta,
        recentMinimalContext: input.recentMinimalContext
      }),
    getMessages: async (leadId) => {
      const rows = await listWhatsAppLeadMessages(leadId, { limit: 50, order: "asc" });
      return rows.map((m) => ({ direction: m.direction, createdAt: m.createdAt }));
    },
    getRecentMessages: async (leadId) => {
      const rows = await listWhatsAppLeadMessages(leadId, { limit: 8, order: "asc" });
      return rows.map((m) => ({
        id: m.id,
        direction: m.direction,
        createdAt: m.createdAt,
        text: m.text || "",
        metadata: m.metadata || null
      }));
    },
    getStrategicAdvisor: (input) =>
      buildStrategicAdvisorFromContext({
        leadId: input.leadId,
        transcript: input.transcript,
        stageAnalysis: input.stageAnalysis
      }),
    getStrategicAdvisorFromDelta: (input) =>
      buildStrategicAdvisorFromStateDelta({
        leadId: input.leadId,
        stageAnalysis: input.stageAnalysis,
        currentState: input.currentState,
        latestMessageDelta: input.latestMessageDelta,
        recentMinimalContext: input.recentMinimalContext
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
  silenceSinceMinutes: number;
  latestDirection: WhatsAppDirection | null;
} {
  const sorted = messages
    .slice()
    .sort((a, b) => toMs(a.createdAt) - toMs(b.createdAt));
  const latest = sorted.length ? sorted[sorted.length - 1] : null;
  if (!latest) {
    return { needsReply: false, waitingSinceMinutes: 0, silenceSinceMinutes: 0, latestDirection: null };
  }
  const now = Date.now();
  const latestAnchor = toMs(latest.createdAt);
  const silenceSinceMinutes = Number.isFinite(latestAnchor) ? Math.max(0, Math.round((now - latestAnchor) / 60000)) : 0;
  if (!latest || latest.direction !== "IN") {
    return { needsReply: false, waitingSinceMinutes: 0, silenceSinceMinutes, latestDirection: latest.direction };
  }
  const anchor = toMs(latest.createdAt);
  const waitingSinceMinutes = Number.isFinite(anchor) ? Math.max(0, Math.round((now - anchor) / 60000)) : 0;
  return { needsReply: true, waitingSinceMinutes, silenceSinceMinutes, latestDirection: latest.direction };
}

function shouldUseTranscriptFallback(input: {
  trigger: string | null;
  structuredStateAvailable: boolean;
  hasDeltaChanges: boolean;
}): boolean {
  const trigger = String(input.trigger || "").toLowerCase();
  if (!input.structuredStateAvailable) return true;
  if (trigger.includes("deep_analysis") || trigger.includes("manual_deep")) return true;
  if (trigger.includes("debug") || trigger.includes("recovery")) return true;
  if (!input.hasDeltaChanges) return false;
  return false;
}

function minimalTranscriptFromDelta(messages: DeltaMessage[]): LeadTranscriptResult {
  const lines = messages
    .slice(-6)
    .map((msg) => {
      const role = msg.direction === "IN" ? "CLIENT" : "MAISON";
      return `[${msg.createdAt}] ${role}: ${String(msg.text || "").trim()}`;
    })
    .filter((line) => line.trim().length > 0);
  const transcript = lines.join("\n");
  return {
    transcript,
    messageCount: lines.length,
    transcriptLength: transcript.length
  };
}

async function markStep(
  deps: OrchestratorDeps,
  runId: string,
  stepName: WhatsAppAgentStepName,
  status: "running" | "completed" | "failed" | "skipped",
  input?: {
    provider?: string | null;
    model?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    cachedInputTokens?: number | null;
    unitInputPricePerMillion?: number | null;
    unitOutputPricePerMillion?: number | null;
    estimatedCostUsd?: number | null;
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
    model: input?.model ?? null,
    inputTokens: input?.inputTokens ?? null,
    outputTokens: input?.outputTokens ?? null,
    cachedInputTokens: input?.cachedInputTokens ?? null,
    unitInputPricePerMillion: input?.unitInputPricePerMillion ?? null,
    unitOutputPricePerMillion: input?.unitOutputPricePerMillion ?? null,
    estimatedCostUsd: input?.estimatedCostUsd ?? null,
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

function usageNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

function costNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Number(value.toFixed(6)) : null;
}

function runCostTotal(value: number): number {
  return Number((Number.isFinite(value) ? value : 0).toFixed(6));
}

function buildStepCostMetrics(input: {
  provider: string | null | undefined;
  model: string | null | undefined;
  usage: AiUsageMetrics | null | undefined;
}): {
  provider: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  unitInputPricePerMillion: number | null;
  unitOutputPricePerMillion: number | null;
  estimatedCostUsd: number | null;
} {
  const provider = input.provider ? String(input.provider).trim() : "";
  const model = input.model ? String(input.model).trim() : "";
  const usage = input.usage || null;
  const estimated = estimateAiCostUsd({ provider, model, usage });
  return {
    provider: provider || null,
    model: model || null,
    inputTokens: usageNumber(usage?.inputTokens),
    outputTokens: usageNumber(usage?.outputTokens),
    cachedInputTokens: usageNumber(usage?.cachedInputTokens),
    unitInputPricePerMillion: costNumber(estimated.unitInputPricePerMillion),
    unitOutputPricePerMillion: costNumber(estimated.unitOutputPricePerMillion),
    estimatedCostUsd: costNumber(estimated.estimatedCostUsd)
  };
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
  let reasoningSource: "state_delta" | "transcript_fallback" = "transcript_fallback";
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalEstimatedCostUsd = 0;
  let structuredState: Record<string, unknown> | null = null;

  let persistedLeadState: Awaited<ReturnType<OrchestratorDeps["getLeadState"]>> | null = null;
  try {
    persistedLeadState = await deps.getLeadState(leadId);
  } catch {
    persistedLeadState = null;
  }
  structuredState = normalizeStructuredLeadState(persistedLeadState?.structuredState || null) as unknown as Record<string, unknown>;

  let recentMessages: DeltaMessage[] = [];
  try {
    recentMessages = await deps.getRecentMessages(leadId);
  } catch {
    recentMessages = [];
  }
  if (!recentMessages.length) {
    try {
      const timingMessages = await deps.getMessages(leadId);
      recentMessages = timingMessages.map((m, idx) => ({
        id: `synthetic-${idx}`,
        direction: m.direction,
        createdAt: m.createdAt,
        text: "",
        metadata: null
      }));
    } catch {
      recentMessages = [];
    }
  }

  const delta = buildLeadDeltaContext({
    messages: recentMessages,
    persistedState: structuredState,
    forceTranscriptFallback: false
  });
  reasoningSource = shouldUseTranscriptFallback({
    trigger: input.trigger || null,
    structuredStateAvailable: isStructuredStateComplete(normalizeStructuredLeadState(structuredState)),
    hasDeltaChanges: delta.hasChanges
  })
    ? "transcript_fallback"
    : "state_delta";
  providers.reasoning_source = reasoningSource;
  const latestInboundMessageId =
    [...recentMessages].reverse().find((m) => m.direction === "IN")?.id || null;
  const latestOutboundMessageId =
    [...recentMessages].reverse().find((m) => m.direction === "OUT")?.id || null;

  let transcript: LeadTranscriptResult | null = null;
  if (reasoningSource === "transcript_fallback") {
    try {
      transcript = await deps.getTranscript(leadId);
    } catch (error) {
      await deps.updateRun({
        runId: run.id,
        status: "failed",
        totalInputTokens,
        totalOutputTokens,
        totalEstimatedCostUsd: runCostTotal(totalEstimatedCostUsd)
      });
      throw new WhatsAppAgentOrchestratorError("transcript_failed", "transcript", toSafeError(error));
    }
    if (!transcript.transcript || transcript.transcriptLength < 30 || transcript.messageCount < 1) {
      await deps.updateRun({
        runId: run.id,
        status: "failed",
        totalInputTokens,
        totalOutputTokens,
        totalEstimatedCostUsd: runCostTotal(totalEstimatedCostUsd)
      });
      throw new WhatsAppAgentOrchestratorError("transcript_too_short", "transcript", "Transcript too short for orchestrator");
    }
  } else {
    transcript = minimalTranscriptFromDelta(recentMessages);
  }

  try {
    await markStep(deps, run.id, "stage_detection", "running");
    const stage =
      reasoningSource === "state_delta"
        ? await deps.detectStageFromDelta({
            leadId,
            currentState: delta.currentState as unknown as Record<string, unknown>,
            latestMessageDelta: delta.latestMessageDelta as unknown as Record<string, unknown>,
            recentMinimalContext: delta.recentMinimalContext as unknown as Array<Record<string, unknown>>
          })
        : await deps.detectStage({
            leadId,
            transcript: transcript as LeadTranscriptResult
          });
    stageAnalysis = stage.analysis as unknown as Record<string, unknown>;
    providers.stage_detection = stage.provider;
    const stageMetrics = buildStepCostMetrics({ provider: stage.provider, model: stage.model, usage: stage.usage });
    totalInputTokens += stageMetrics.inputTokens || 0;
    totalOutputTokens += stageMetrics.outputTokens || 0;
    totalEstimatedCostUsd += stageMetrics.estimatedCostUsd || 0;
    await markStep(deps, run.id, "stage_detection", "completed", {
      provider: stage.provider,
      model: stage.model,
      inputTokens: stageMetrics.inputTokens,
      outputTokens: stageMetrics.outputTokens,
      cachedInputTokens: stageMetrics.cachedInputTokens,
      unitInputPricePerMillion: stageMetrics.unitInputPricePerMillion,
      unitOutputPricePerMillion: stageMetrics.unitOutputPricePerMillion,
      estimatedCostUsd: stageMetrics.estimatedCostUsd,
      output: { analysis: stage.analysis, source: stage.source }
    });
  } catch (error) {
    const safeError = toSafeError(error);
    await markStep(deps, run.id, "stage_detection", "failed", { error: safeError });
    await markStep(deps, run.id, "fact_extraction", "skipped", { error: "stage_detection_failed" });
    await markStep(deps, run.id, "priority_scoring", "skipped", { error: "stage_detection_failed" });
    await markStep(deps, run.id, "strategic_advisor", "skipped", { error: "stage_detection_failed" });
    await markStep(deps, run.id, "reply_generator", "skipped", { error: "stage_detection_failed" });
    await markStep(deps, run.id, "brand_guardian", "skipped", { error: "stage_detection_failed" });
    await deps.updateRun({
      runId: run.id,
      status: "failed",
      totalInputTokens,
      totalOutputTokens,
      totalEstimatedCostUsd: runCostTotal(totalEstimatedCostUsd)
    });
    return {
      runId: run.id,
      leadId,
      messageId,
      status: "failed",
      stageAnalysis: null,
      strategy: null,
      priority: null,
      topReplyCard: null,
      reasoningSource
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

  if (stageAnalysis) {
    structuredState = mergeStructuredState({
      previousState: structuredState,
      stageAnalysis,
      latestInboundMessageId,
      latestOutboundMessageId,
      runId: run.id,
      nowIso: deps.nowIso()
    }) as unknown as Record<string, unknown>;
  }

  try {
    await markStep(deps, run.id, "priority_scoring", "running");
    const messages = await deps.getMessages(leadId);
    const timing = computeTiming(messages);
    const stage = String(stageAnalysis?.stage || "NEW").trim().toUpperCase();
    const signals = Array.isArray(stageAnalysis?.signals) ? stageAnalysis?.signals : [];
    const objections = Array.isArray(stageAnalysis?.objections) ? stageAnalysis?.objections : [];
    const factsSource = stageAnalysis?.facts && typeof stageAnalysis.facts === "object" ? (stageAnalysis.facts as Record<string, unknown>) : {};
    const eventDate = String(factsSource.event_date || "").trim();
    const nowMs = Date.now();
    const eventDateNear = (() => {
      if (!eventDate) return false;
      const eventMs = new Date(`${eventDate}T00:00:00.000Z`).getTime();
      if (!Number.isFinite(eventMs)) return false;
      const days = Math.floor((eventMs - nowMs) / 86400000);
      return days >= 0 && days <= 10;
    })();
    const hasSignal = (type: string): boolean =>
      signals.some((row) => {
        if (!row || typeof row !== "object") return false;
        return String((row as Record<string, unknown>).type || "").toLowerCase() === type;
      });
    const hasObjection = (type: string): boolean =>
      objections.some((row) => {
        if (!row || typeof row !== "object") return false;
        return String((row as Record<string, unknown>).type || "").toLowerCase() === type;
      });
    const intelligence = computePriorityIntelligence({
      leadId,
      stage,
      awaitingReply: timing.needsReply,
      waitingMinutes: timing.waitingSinceMinutes,
      silenceMinutes: timing.silenceSinceMinutes,
      reactivationState: {
        shouldReactivate: !timing.needsReply && timing.silenceSinceMinutes > 360,
        reactivationPriority: !timing.needsReply && timing.silenceSinceMinutes > 1440 ? "high" : timing.silenceSinceMinutes > 360 ? "medium" : "low",
        stalledStage: !timing.needsReply && timing.silenceSinceMinutes > 360 ? stage : null
      },
      signals: {
        product_interest_detected: hasSignal("product_interest"),
        price_request_detected: hasSignal("price_request"),
        payment_intent_detected: Boolean(stageAnalysis?.payment_intent) || hasSignal("payment_intent"),
        deposit_intent_detected: stage === "DEPOSIT_PENDING",
        shipping_question_detected: hasSignal("shipping_question") || String(factsSource.destination_country || "").trim().length > 0,
        delivery_timing_detected: hasSignal("deadline_risk") || String(factsSource.delivery_deadline || "").trim().length > 0,
        customization_request_detected: hasSignal("customization_request") || Array.isArray(factsSource.customization_requests),
        video_interest_detected: hasSignal("video_interest") || stage.includes("VIDEO"),
        event_date_detected: eventDate.length > 0,
        event_date_near: eventDateNear,
        high_ticket_context: false,
        repeat_customer_detected: false,
        price_objection_detected: hasObjection("price"),
        timing_objection_detected: hasObjection("timing"),
        trust_friction_detected: hasObjection("trust"),
        fit_uncertainty_detected: hasObjection("fit") || hasObjection("uncertainty"),
        fabric_uncertainty_detected: hasObjection("fabric"),
        external_approval_delay_detected: hasObjection("external_approval"),
        recent_inbound_message: timing.needsReply && timing.waitingSinceMinutes <= 120
      }
    });
    const estimatedHeat = intelligence.priorityBand === "critical" || intelligence.priorityBand === "high"
      ? "hot"
      : intelligence.priorityBand === "medium"
        ? "warm"
        : "cold";
    priorityItem = {
      conversion_probability: intelligence.conversionProbability,
      dropoff_risk: intelligence.dropoffRisk,
      priority_score: intelligence.priorityScore,
      priority_band: intelligence.priorityBand,
      recommended_attention: intelligence.recommendedAttention,
      reason_codes: intelligence.reasonCodes,
      primary_reason_code: intelligence.primaryReasonCode,
      priorityScore: intelligence.priorityScore,
      priorityBand: intelligence.priorityBand,
      needsReply: timing.needsReply,
      waitingSinceMinutes: timing.waitingSinceMinutes,
      silenceSinceMinutes: timing.silenceSinceMinutes,
      stage: String(stageAnalysis?.stage || ""),
      urgency: String(stageAnalysis?.urgency || "low"),
      paymentIntent: Boolean(stageAnalysis?.payment_intent),
      dropoffRisk: intelligence.dropoffRisk,
      recommendedAction: String(stageAnalysis?.recommended_next_action || "wait"),
      commercialPriority: "medium",
      estimatedHeat,
      reasons: intelligence.reasonCodes
    };
    await markStep(deps, run.id, "priority_scoring", "completed", { output: priorityItem });
  } catch (error) {
    finalStatus = "partial";
    await markStep(deps, run.id, "priority_scoring", "failed", { error: toSafeError(error) });
  }

  try {
    await markStep(deps, run.id, "strategic_advisor", "running");
    const strategic =
      reasoningSource === "state_delta"
        ? await deps.getStrategicAdvisorFromDelta({
            leadId,
            stageAnalysis: stageAnalysis as Parameters<typeof buildStrategicAdvisorFromStateDelta>[0]["stageAnalysis"],
            currentState: delta.currentState as unknown as Record<string, unknown>,
            latestMessageDelta: delta.latestMessageDelta as unknown as Record<string, unknown>,
            recentMinimalContext: delta.recentMinimalContext as unknown as Array<Record<string, unknown>>
          })
        : await deps.getStrategicAdvisor({
            leadId,
            transcript: transcript as LeadTranscriptResult,
            stageAnalysis: stageAnalysis as Parameters<typeof buildStrategicAdvisorFromContext>[0]["stageAnalysis"]
          });
    strategy = strategic.strategy as unknown as Record<string, unknown>;
    providers.strategic_advisor = strategic.provider;
    const strategyMetrics = buildStepCostMetrics({
      provider: strategic.provider,
      model: strategic.model,
      usage: strategic.usage
    });
    totalInputTokens += strategyMetrics.inputTokens || 0;
    totalOutputTokens += strategyMetrics.outputTokens || 0;
    totalEstimatedCostUsd += strategyMetrics.estimatedCostUsd || 0;
    await markStep(deps, run.id, "strategic_advisor", "completed", {
      provider: strategic.provider,
      model: strategic.model,
      inputTokens: strategyMetrics.inputTokens,
      outputTokens: strategyMetrics.outputTokens,
      cachedInputTokens: strategyMetrics.cachedInputTokens,
      unitInputPricePerMillion: strategyMetrics.unitInputPricePerMillion,
      unitOutputPricePerMillion: strategyMetrics.unitOutputPricePerMillion,
      estimatedCostUsd: strategyMetrics.estimatedCostUsd,
      output: { strategy: strategic.strategy, source: strategic.source }
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
      structuredState,
      priorityItem,
      strategy,
      replyOptions: null,
      brandReview: null,
      topReplyCard: null,
      providers,
      reasoningSource
    });
    await deps.updateRun({
      runId: run.id,
      status: finalStatus,
      totalInputTokens,
      totalOutputTokens,
      totalEstimatedCostUsd: runCostTotal(totalEstimatedCostUsd)
    });
    return {
      runId: run.id,
      leadId,
      messageId,
      status: finalStatus,
      stageAnalysis,
      strategy,
      priority: priorityItem,
      topReplyCard: null,
      reasoningSource
    };
  }

  try {
    await markStep(deps, run.id, "reply_generator", "running");
    const reply = await deps.getReplyGenerator({
      leadId,
      transcript: transcript as LeadTranscriptResult,
      stageAnalysis: stageAnalysis as Parameters<typeof buildReplyGeneratorFromContext>[0]["stageAnalysis"],
      strategy: strategy as Parameters<typeof buildReplyGeneratorFromContext>[0]["strategy"]
    });
    replyOptions = reply.replyOptions as unknown as Record<string, unknown>;
    providers.reply_generator = reply.provider;
    const replyMetrics = buildStepCostMetrics({ provider: reply.provider, model: reply.model, usage: reply.usage });
    totalInputTokens += replyMetrics.inputTokens || 0;
    totalOutputTokens += replyMetrics.outputTokens || 0;
    totalEstimatedCostUsd += replyMetrics.estimatedCostUsd || 0;
    await markStep(deps, run.id, "reply_generator", "completed", {
      provider: reply.provider,
      model: reply.model,
      inputTokens: replyMetrics.inputTokens,
      outputTokens: replyMetrics.outputTokens,
      cachedInputTokens: replyMetrics.cachedInputTokens,
      unitInputPricePerMillion: replyMetrics.unitInputPricePerMillion,
      unitOutputPricePerMillion: replyMetrics.unitOutputPricePerMillion,
      estimatedCostUsd: replyMetrics.estimatedCostUsd,
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
      structuredState,
      priorityItem,
      strategy,
      replyOptions,
      brandReview: null,
      topReplyCard,
      providers,
      reasoningSource
    });
    await deps.updateRun({
      runId: run.id,
      status: finalStatus,
      totalInputTokens,
      totalOutputTokens,
      totalEstimatedCostUsd: runCostTotal(totalEstimatedCostUsd)
    });
    return {
      runId: run.id,
      leadId,
      messageId,
      status: finalStatus,
      stageAnalysis,
      strategy,
      priority: priorityItem,
      topReplyCard,
      reasoningSource
    };
  }

  try {
    await markStep(deps, run.id, "brand_guardian", "running");
    const review = await deps.getBrandGuardian({
      leadId,
      transcript: transcript as LeadTranscriptResult,
      stageAnalysis: stageAnalysis as Parameters<typeof buildBrandGuardianFromContext>[0]["stageAnalysis"],
      strategy: strategy as Parameters<typeof buildBrandGuardianFromContext>[0]["strategy"],
      replyOptions: replyOptions as Parameters<typeof buildBrandGuardianFromContext>[0]["replyOptions"]
    });
    brandReview = review.review as unknown as Record<string, unknown>;
    providers.brand_guardian = review.provider;
    const brandMetrics = buildStepCostMetrics({ provider: review.provider, model: review.model, usage: review.usage });
    totalInputTokens += brandMetrics.inputTokens || 0;
    totalOutputTokens += brandMetrics.outputTokens || 0;
    totalEstimatedCostUsd += brandMetrics.estimatedCostUsd || 0;
    await markStep(deps, run.id, "brand_guardian", "completed", {
      provider: review.provider,
      model: review.model,
      inputTokens: brandMetrics.inputTokens,
      outputTokens: brandMetrics.outputTokens,
      cachedInputTokens: brandMetrics.cachedInputTokens,
      unitInputPricePerMillion: brandMetrics.unitInputPricePerMillion,
      unitOutputPricePerMillion: brandMetrics.unitOutputPricePerMillion,
      estimatedCostUsd: brandMetrics.estimatedCostUsd,
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
    structuredState,
    priorityItem,
    strategy,
    replyOptions,
    brandReview,
    topReplyCard,
    providers,
    reasoningSource
  });
  await deps.updateRun({
    runId: run.id,
    status: finalStatus,
    totalInputTokens,
    totalOutputTokens,
    totalEstimatedCostUsd: runCostTotal(totalEstimatedCostUsd)
  });

  return {
    runId: run.id,
    leadId,
    messageId,
    status: finalStatus,
    stageAnalysis,
    strategy,
    priority: priorityItem,
    topReplyCard,
    reasoningSource
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
    totalInputTokens: number | null;
    totalOutputTokens: number | null;
    totalEstimatedCostUsd: number | null;
  } | null;
  steps: Array<{
    stepName: string;
    status: string;
    provider: string | null;
    model: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    cachedInputTokens: number | null;
    unitInputPricePerMillion: number | null;
    unitOutputPricePerMillion: number | null;
    estimatedCostUsd: number | null;
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
      finishedAt: latest.run.finishedAt,
      totalInputTokens: latest.run.totalInputTokens,
      totalOutputTokens: latest.run.totalOutputTokens,
      totalEstimatedCostUsd: latest.run.totalEstimatedCostUsd
    },
    steps: latest.steps.map((step) => ({
      stepName: step.stepName,
      status: step.status,
      provider: step.provider,
      model: step.model,
      inputTokens: step.inputTokens,
      outputTokens: step.outputTokens,
      cachedInputTokens: step.cachedInputTokens,
      unitInputPricePerMillion: step.unitInputPricePerMillion,
      unitOutputPricePerMillion: step.unitOutputPricePerMillion,
      estimatedCostUsd: step.estimatedCostUsd,
      error: step.error
    }))
  };
}

export async function getWhatsAppAgentRunSnapshotByRunId(
  runId: string,
  depsOverride?: Partial<Pick<OrchestratorDeps, never>> & {
    getRunById?: typeof getWhatsAppAgentRunById;
  }
): Promise<{
  run: {
    id: string;
    status: WhatsAppAgentRunStatus;
    startedAt: string;
    finishedAt: string | null;
    totalInputTokens: number | null;
    totalOutputTokens: number | null;
    totalEstimatedCostUsd: number | null;
  } | null;
  steps: Array<{
    stepName: string;
    status: string;
    provider: string | null;
    model: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    cachedInputTokens: number | null;
    unitInputPricePerMillion: number | null;
    unitOutputPricePerMillion: number | null;
    estimatedCostUsd: number | null;
    error: string | null;
  }>;
}> {
  const safeRunId = String(runId || "").trim();
  if (!safeRunId) {
    throw new WhatsAppAgentOrchestratorError("invalid_run_id", "latest_run", "Run ID is required");
  }
  const getRunById = depsOverride?.getRunById || getWhatsAppAgentRunById;
  const latest = await getRunById(safeRunId);
  if (!latest) return { run: null, steps: [] };
  return {
    run: {
      id: latest.run.id,
      status: latest.run.status,
      startedAt: latest.run.startedAt,
      finishedAt: latest.run.finishedAt,
      totalInputTokens: latest.run.totalInputTokens,
      totalOutputTokens: latest.run.totalOutputTokens,
      totalEstimatedCostUsd: latest.run.totalEstimatedCostUsd
    },
    steps: latest.steps.map((step) => ({
      stepName: step.stepName,
      status: step.status,
      provider: step.provider,
      model: step.model,
      inputTokens: step.inputTokens,
      outputTokens: step.outputTokens,
      cachedInputTokens: step.cachedInputTokens,
      unitInputPricePerMillion: step.unitInputPricePerMillion,
      unitOutputPricePerMillion: step.unitOutputPricePerMillion,
      estimatedCostUsd: step.estimatedCostUsd,
      error: step.error
    }))
  };
}
