import {
  buildReplyGeneratorFromContext,
  type ReplyGeneratorResult
} from "./whatsappReplyGeneratorService.js";
import { getWhatsAppAgentLeadState, upsertWhatsAppAgentLeadState } from "../db/whatsappAgentRunsRepo.js";
import { runWhatsAppAgentOrchestrator } from "./whatsappAgentOrchestratorService.js";
import { detectStageFromTranscript } from "./whatsappStageDetectionService.js";
import { buildStrategicAdvisorFromContext } from "./whatsappStrategicAdvisorService.js";
import { buildLeadTranscript } from "./whatsappTranscriptFormatter.js";
import { buildLeadReactivationReplies } from "./whatsappReactivationReplyService.js";
import { listWhatsAppLeadMessages } from "../db/whatsappLeadsRepo.js";
import { buildLeadPriorityIntelligence } from "./whatsappPriorityIntelligenceService.js";
import { estimateAiCostUsd } from "./aiPricing.js";

type Card = {
  label: string;
  intent: string;
  messages: string[];
  reason_short?: string;
};

type FallbackGenerationMeta = {
  path: "direct_generation_fallback";
  provider: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
  generatedAt: string | null;
};

export type MobileLabLeadCardsResult = {
  leadId: string;
  replyCards: Card[];
  topReplyCard: Card | null;
  generationMode: "cached" | "fresh" | null;
  generationFallbackUsed?: boolean;
  generationFallbackReason?: string | null;
  fallbackGenerationMeta?: FallbackGenerationMeta | null;
  source: "cache" | "fresh_generation";
  cacheStatus: "hit" | "stale" | "forced_refresh";
  basedOnMessageId: string | null;
  currentLatestMessageId: string | null;
  basedOnTimestamp: string | null;
  agentRunMeta: {
    runId: string | null;
    generatedAt: string | null;
    source: "cache" | "fresh_generation" | "reactivation_replies";
    reasoningSource: "state_delta" | "transcript_fallback" | null;
  };
  priorityIntelligence?: {
    recommendedAttention: string | null;
    conversionProbability: number | null;
    dropoffRisk: number | null;
    priorityScore: number | null;
    reasonCodes: string[];
    primaryReasonCode: string | null;
  } | null;
  stageAnalysis: {
    stage: string;
    stageConfidence: number;
    urgency: string;
    paymentIntent: boolean;
    dropoffRisk: string;
    priorityScore: number;
  } | null;
  summary: {
    stage: string;
    stageConfidence: number;
    urgency: string;
    paymentIntent: boolean;
    dropoffRisk: string;
    priorityScore: number;
  } | null;
  strategy: {
    recommendedAction: string;
    commercialPriority: string;
    tone: string;
    pressureLevel: string;
    primaryGoal: string;
    secondaryGoal: string;
  } | null;
  enrichmentStatus: "enriched" | "timeout" | "error" | "no_generation_needed";
  enrichmentSource: "active_ai_cards" | "reactivation_replies";
  enrichmentError: string | null;
  status: "enriched" | "timeout" | "error" | "no_generation_needed";
  pipelineSource: "active_ai_cards" | "reactivation_replies";
  error: string | null;
  provider: string | null;
  model: string | null;
  timestamp: string;
};

type MobileLabLeadCardsDeps = {
  getCachedLeadState: (leadId: string) => ReturnType<typeof getWhatsAppAgentLeadState>;
  getLatestLeadMessage: (leadId: string) => Promise<{ id: string; createdAt: string } | null>;
  persistCachedLeadState: (input: {
    leadId: string;
    latestMessageId?: string | null;
    stageAnalysis?: Record<string, unknown> | null;
    priorityItem?: Record<string, unknown> | null;
    strategy?: Record<string, unknown> | null;
    replyOptions?: Record<string, unknown> | null;
    topReplyCard?: Record<string, unknown> | null;
    providers?: Record<string, unknown> | null;
  }) => ReturnType<typeof upsertWhatsAppAgentLeadState>;
  getActiveReplyContext: (leadId: string) => Promise<ReplyGeneratorResult>;
  runAgentOrchestrator: (input: { leadId: string; messageId: string; trigger?: string | null }) => ReturnType<typeof runWhatsAppAgentOrchestrator>;
  getReactivationReplies: (leadId: string) => ReturnType<typeof buildLeadReactivationReplies>;
  getFallbackCache: (key: string) => MobileLabLeadCardsResult | null;
  setFallbackCache: (key: string, payload: MobileLabLeadCardsResult) => void;
  timeoutMs: () => number;
};

const fallbackCardsMemoryCache = new Map<string, { payload: MobileLabLeadCardsResult; createdAtMs: number }>();
const FALLBACK_CACHE_TTL_MS = 30 * 60 * 1000;
const ORCHESTRATOR_PROMPT_VERSION = "mobile_lab_orchestrator_v1";
const ORCHESTRATOR_CONTEXT_VERSION = "latest_message_anchor_v1";
const ORCHESTRATOR_PROVIDER_MODEL_SET = "orchestrator_default";

type OrchestratorRunResult = Awaited<ReturnType<MobileLabLeadCardsDeps["runAgentOrchestrator"]>>;
type OrchestratorSettledOutcome =
  | { ok: true; result: OrchestratorRunResult }
  | { ok: false; error: unknown };

type OrchestratorInFlightEntry = {
  key: string;
  ownerId: string;
  startedAtMs: number;
  promise: Promise<OrchestratorSettledOutcome>;
};

const orchestratorInFlightRuns = new Map<string, OrchestratorInFlightEntry>();

function parsePositiveInt(value: unknown): number | null {
  const num = Number(value);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num <= 0) return null;
  return num;
}

function resolveTimeoutMs(): number {
  const configured = parsePositiveInt(process.env.WHATSAPP_MOBILE_LAB_SELECTED_CARDS_TIMEOUT_MS);
  const fallback = 10000;
  const raw = configured == null ? fallback : configured;
  return Math.max(200, Math.min(30000, raw));
}

function defaultDeps(): MobileLabLeadCardsDeps {
  return {
    getCachedLeadState: (leadId: string) => getWhatsAppAgentLeadState(leadId),
    getLatestLeadMessage: async (leadId: string) => {
      const messages = await listWhatsAppLeadMessages(leadId, { limit: 1, order: "desc" });
      const latest = messages[0] || null;
      if (!latest) return null;
      return { id: String(latest.id || "").trim(), createdAt: String(latest.createdAt || "").trim() };
    },
    persistCachedLeadState: (input) =>
      upsertWhatsAppAgentLeadState({
        leadId: input.leadId,
        latestMessageId: input.latestMessageId ?? null,
        stageAnalysis: input.stageAnalysis ?? null,
        priorityItem: input.priorityItem ?? null,
        strategy: input.strategy ?? null,
        replyOptions: input.replyOptions ?? null,
        topReplyCard: input.topReplyCard ?? null,
        providers: input.providers ?? null
      }),
    getActiveReplyContext: async (leadId: string) => {
      const transcript = await buildLeadTranscript(leadId, 30);
      const stageDetection = await detectStageFromTranscript({ leadId, transcript });
      const strategicAdvisor = await buildStrategicAdvisorFromContext({
        leadId,
        transcript,
        stageAnalysis: stageDetection.analysis
      });
      return buildReplyGeneratorFromContext({
        leadId,
        transcript,
        stageAnalysis: stageDetection.analysis,
        strategy: strategicAdvisor.strategy
      });
    },
    runAgentOrchestrator: (input) => runWhatsAppAgentOrchestrator(input),
    getReactivationReplies: (leadId: string) => buildLeadReactivationReplies(leadId),
    getFallbackCache: (key: string) => {
      const hit = fallbackCardsMemoryCache.get(String(key || ""));
      if (!hit) return null;
      if (Date.now() - hit.createdAtMs > FALLBACK_CACHE_TTL_MS) {
        fallbackCardsMemoryCache.delete(String(key || ""));
        return null;
      }
      return hit.payload;
    },
    setFallbackCache: (key: string, payload: MobileLabLeadCardsResult) => {
      fallbackCardsMemoryCache.set(String(key || ""), {
        payload,
        createdAtMs: Date.now()
      });
    },
    timeoutMs: () => resolveTimeoutMs()
  };
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    });
    return await Promise.race([work, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function buildOrchestratorRunKey(input: { leadId: string; messageId: string }): string {
  return [
    String(input.leadId || "").trim(),
    String(input.messageId || "").trim(),
    ORCHESTRATOR_PROVIDER_MODEL_SET,
    ORCHESTRATOR_PROMPT_VERSION,
    ORCHESTRATOR_CONTEXT_VERSION
  ].join(":");
}

function runOrchestratorSingleFlight(input: {
  deps: MobileLabLeadCardsDeps;
  leadId: string;
  messageId: string;
  trigger: string;
}): { entry: OrchestratorInFlightEntry; joinedExisting: boolean } {
  const key = buildOrchestratorRunKey({ leadId: input.leadId, messageId: input.messageId });
  const existing = orchestratorInFlightRuns.get(key);
  if (existing) {
    console.info("[mobile-lab-lead-cards] orchestrator_joined_inflight", {
      leadId: input.leadId,
      messageId: input.messageId,
      key,
      ownerId: existing.ownerId
    });
    return { entry: existing, joinedExisting: true };
  }

  const ownerId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const promise: Promise<OrchestratorSettledOutcome> = input.deps
    .runAgentOrchestrator({
      leadId: input.leadId,
      messageId: input.messageId,
      trigger: input.trigger
    })
    .then((result) => ({ ok: true as const, result }))
    .catch((error) => ({ ok: false as const, error }));

  const entry: OrchestratorInFlightEntry = {
    key,
    ownerId,
    startedAtMs: Date.now(),
    promise
  };
  orchestratorInFlightRuns.set(key, entry);
  void promise.finally(() => {
    const current = orchestratorInFlightRuns.get(key);
    if (current && current.ownerId === ownerId) {
      orchestratorInFlightRuns.delete(key);
    }
  });
  console.info("[mobile-lab-lead-cards] orchestrator_started", {
    leadId: input.leadId,
    messageId: input.messageId,
    key,
    ownerId
  });
  return { entry, joinedExisting: false };
}

async function waitForOrchestratorSingleFlight(input: {
  deps: MobileLabLeadCardsDeps;
  leadId: string;
  messageId: string;
  trigger: string;
  timeoutMs: number;
}): Promise<
  | { status: "completed"; result: OrchestratorRunResult; key: string; ownerId: string; joinedExisting: boolean }
  | { status: "failed"; error: unknown; key: string; ownerId: string; joinedExisting: boolean }
  | { status: "timed_out_inflight"; key: string; ownerId: string; joinedExisting: boolean }
> {
  const run = runOrchestratorSingleFlight({
    deps: input.deps,
    leadId: input.leadId,
    messageId: input.messageId,
    trigger: input.trigger
  });
  const timeoutToken = Symbol("orchestrator_timeout");
  let timeout: NodeJS.Timeout | null = null;
  try {
    const raced = await Promise.race<OrchestratorSettledOutcome | typeof timeoutToken>([
      run.entry.promise,
      new Promise<typeof timeoutToken>((resolve) => {
        timeout = setTimeout(() => resolve(timeoutToken), input.timeoutMs);
      })
    ]);
    if (raced === timeoutToken) {
      const stillInFlight = orchestratorInFlightRuns.has(run.entry.key);
      if (stillInFlight) {
        console.warn("[mobile-lab-lead-cards] orchestrator_caller_timed_out_inflight", {
          leadId: input.leadId,
          messageId: input.messageId,
          key: run.entry.key,
          ownerId: run.entry.ownerId,
          joinedExisting: run.joinedExisting
        });
        return {
          status: "timed_out_inflight",
          key: run.entry.key,
          ownerId: run.entry.ownerId,
          joinedExisting: run.joinedExisting
        };
      }
      const settled = await run.entry.promise;
      if (settled.ok) {
        return {
          status: "completed",
          result: settled.result,
          key: run.entry.key,
          ownerId: run.entry.ownerId,
          joinedExisting: run.joinedExisting
        };
      }
      return {
        status: "failed",
        error: settled.error,
        key: run.entry.key,
        ownerId: run.entry.ownerId,
        joinedExisting: run.joinedExisting
      };
    }
    if (raced.ok) {
      return {
        status: "completed",
        result: raced.result,
        key: run.entry.key,
        ownerId: run.entry.ownerId,
        joinedExisting: run.joinedExisting
      };
    }
    return {
      status: "failed",
      error: raced.error,
      key: run.entry.key,
      ownerId: run.entry.ownerId,
      joinedExisting: run.joinedExisting
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function toSafeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error || "cards_failed");
  return text.slice(0, 180);
}

function toMs(value: string | null | undefined): number {
  if (!value) return NaN;
  return new Date(value).getTime();
}

function normalizeTopReplyCard(value: unknown): Card | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const label = String(row.label || "").trim();
  const intent = String(row.intent || "").trim();
  const reasonShort = String(row.reason_short || row.reasonShort || "").trim();
  const messages = Array.isArray(row.messages)
    ? row.messages.map((m) => String(m || "")).map((m) => m.trim()).filter(Boolean)
    : [];
  if (!label || !messages.length) return null;
  return { label, intent, messages, ...(reasonShort ? { reason_short: reasonShort } : {}) };
}

function buildFallbackCacheKey(leadId: string, latestMessage: { id: string; createdAt: string } | null): string {
  if (!latestMessage?.id) return "";
  return [
    "fallback",
    String(leadId || "").trim(),
    String(latestMessage.id || "").trim(),
    String(latestMessage.createdAt || "").trim()
  ].join(":");
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

function decimalOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Number(n.toFixed(6)) : null;
}

function normalizeReasonCodes(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [];
  const out: string[] = [];
  for (const raw of list) {
    const code = String(raw || "").trim().toLowerCase();
    if (!code || out.includes(code)) continue;
    out.push(code);
    if (out.length >= 6) break;
  }
  return out;
}

function normalizePriorityIntelligence(value: unknown): MobileLabLeadCardsResult["priorityIntelligence"] {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const recommendedAttentionRaw = String(row.recommended_attention ?? row.recommendedAttention ?? "").trim().toLowerCase();
  const recommendedAttention = recommendedAttentionRaw || null;
  const conversionProbability = decimalOrNull(row.conversion_probability ?? row.conversionProbability);
  const dropoffRisk = decimalOrNull(row.dropoff_risk ?? row.dropoffRisk);
  const priorityScoreRaw = row.priority_score ?? row.priorityScore;
  const priorityScoreNum = Number(priorityScoreRaw);
  const priorityScore = Number.isFinite(priorityScoreNum) && priorityScoreNum >= 0 ? Math.round(priorityScoreNum) : null;
  const reasonCodes = normalizeReasonCodes(row.reason_codes ?? row.reasonCodes ?? []);
  const primaryReasonCodeRaw = String(row.primary_reason_code ?? row.primaryReasonCode ?? "").trim().toLowerCase();
  const primaryReasonCode = primaryReasonCodeRaw || null;
  return {
    recommendedAttention,
    conversionProbability,
    dropoffRisk,
    priorityScore,
    reasonCodes,
    primaryReasonCode
  };
}

function fallbackMetaFromReplyContext(replyContext: ReplyGeneratorResult): FallbackGenerationMeta {
  const provider = String(replyContext.provider || "").trim() || null;
  const model = String(replyContext.model || "").trim() || null;
  const inputTokens = numberOrNull(replyContext.usage?.inputTokens);
  const outputTokens = numberOrNull(replyContext.usage?.outputTokens);
  const estimated = estimateAiCostUsd({
    provider: provider || "",
    model: model || "",
    usage: replyContext.usage || null
  });
  return {
    path: "direct_generation_fallback",
    provider,
    model,
    inputTokens,
    outputTokens,
    estimatedCostUsd:
      typeof estimated.estimatedCostUsd === "number" && Number.isFinite(estimated.estimatedCostUsd)
        ? Number(estimated.estimatedCostUsd.toFixed(6))
        : null,
    generatedAt: String(replyContext.timestamp || "").trim() || null
  };
}

function generationAnchorFromProviders(input: {
  providers: Record<string, unknown> | null | undefined;
  fallbackBasedOnMessageId: string | null | undefined;
  fallbackCardsGeneratedAt: string | null | undefined;
}): {
  basedOnMessageId: string | null;
  cardsGeneratedAt: string | null;
} {
  const providers = input.providers && typeof input.providers === "object" ? input.providers : null;
  const basedOnMessageIdRaw = String((providers && (providers as Record<string, unknown>).based_on_message_id) || "").trim();
  const cardsGeneratedAtRaw = String((providers && (providers as Record<string, unknown>).cards_generated_at) || "").trim();
  return {
    basedOnMessageId: basedOnMessageIdRaw || (input.fallbackBasedOnMessageId ? String(input.fallbackBasedOnMessageId).trim() : "") || null,
    cardsGeneratedAt: cardsGeneratedAtRaw || (input.fallbackCardsGeneratedAt ? String(input.fallbackCardsGeneratedAt).trim() : "") || null
  };
}

function resolveCacheStatus(input: {
  forceRefresh: boolean;
  hasCachedTopCard: boolean;
  basedOnMessageId: string | null;
  latestMessageId: string | null;
}): "hit" | "stale" | "forced_refresh" {
  if (input.forceRefresh) return "forced_refresh";
  if (!input.hasCachedTopCard) return "stale";
  const latestMessageId = String(input.latestMessageId || "").trim();
  const basedOnMessageId = String(input.basedOnMessageId || "").trim();
  if (!latestMessageId && !basedOnMessageId) return "hit";
  if (latestMessageId && basedOnMessageId && latestMessageId === basedOnMessageId) return "hit";
  return "stale";
}

export async function buildMobileLabLeadCards(
  leadId: string,
  input?: { feedType?: "active" | "reactivation" | null; forceRefresh?: boolean | null },
  depsOverride?: Partial<MobileLabLeadCardsDeps>
): Promise<MobileLabLeadCardsResult> {
  const safeLeadId = String(leadId || "").trim();
  const deps: MobileLabLeadCardsDeps = { ...defaultDeps(), ...(depsOverride || {}) };
  const useFallbackCache = !depsOverride || (Object.prototype.hasOwnProperty.call(depsOverride, "getFallbackCache") || Object.prototype.hasOwnProperty.call(depsOverride, "setFallbackCache"));
  const timeoutMs = deps.timeoutMs();
  const feedType = input?.feedType === "reactivation" ? "reactivation" : "active";
  const forceRefresh = Boolean(input?.forceRefresh);
  let cachedBeforeForceRefresh: Awaited<ReturnType<MobileLabLeadCardsDeps["getCachedLeadState"]>> | null = null;

  try {
    if (forceRefresh) {
      try {
        cachedBeforeForceRefresh = await deps.getCachedLeadState(safeLeadId);
      } catch (error) {
        console.warn("[mobile-lab-lead-cards] cached_state_before_regeneration_unavailable", {
          leadId: safeLeadId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      let latestMessage: { id: string; createdAt: string } | null = null;
      try {
        latestMessage = await deps.getLatestLeadMessage(safeLeadId);
      } catch (error) {
        console.warn("[mobile-lab-lead-cards] latest_message_unavailable", {
          leadId: safeLeadId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      if (!latestMessage?.id) {
        return {
          leadId: safeLeadId,
          replyCards: [],
          topReplyCard: null,
          generationMode: "fresh",
          source: "fresh_generation",
          cacheStatus: "forced_refresh",
          basedOnMessageId: null,
          currentLatestMessageId: null,
          basedOnTimestamp: null,
          agentRunMeta: {
            runId: null,
            generatedAt: null,
            source: "fresh_generation",
            reasoningSource: null
          },
          stageAnalysis: null,
          summary: null,
          strategy: null,
          enrichmentStatus: "error",
          enrichmentSource: "active_ai_cards",
          enrichmentError: "no_messages_for_regeneration",
          status: "error",
          pipelineSource: "active_ai_cards",
          error: "no_messages_for_regeneration",
          provider: null,
          model: null,
          timestamp: new Date().toISOString()
        };
      }
      const orchestratorRun = await waitForOrchestratorSingleFlight({
        deps,
        leadId: safeLeadId,
        messageId: String(latestMessage.id),
        trigger: "mobile_lab_manual_regenerate",
        timeoutMs
      });
      if (orchestratorRun.status === "timed_out_inflight") {
        const cachedBeforeTop = normalizeTopReplyCard(cachedBeforeForceRefresh?.topReplyCard);
        return {
          leadId: safeLeadId,
          replyCards: [],
          topReplyCard: cachedBeforeTop,
          generationMode: "fresh",
          source: "fresh_generation",
          cacheStatus: "forced_refresh",
          basedOnMessageId: latestMessage.id,
          currentLatestMessageId: latestMessage.id,
          basedOnTimestamp: latestMessage.createdAt || null,
          agentRunMeta: {
            runId: null,
            generatedAt: latestMessage.createdAt || null,
            source: "fresh_generation",
            reasoningSource: null
          },
          stageAnalysis: null,
          summary: null,
          strategy: null,
          enrichmentStatus: cachedBeforeTop ? "enriched" : "timeout",
          enrichmentSource: "active_ai_cards",
          enrichmentError: cachedBeforeTop
            ? "Regeneration timed out. Kept previous suggestions."
            : "orchestrator_inflight_timeout",
          status: cachedBeforeTop ? "enriched" : "timeout",
          pipelineSource: "active_ai_cards",
          error: cachedBeforeTop
            ? "Regeneration timed out. Kept previous suggestions."
            : "orchestrator_inflight_timeout",
          provider: null,
          model: null,
          timestamp: new Date().toISOString()
        };
      }
      if (orchestratorRun.status === "failed") {
        throw (orchestratorRun.error instanceof Error ? orchestratorRun.error : new Error(String(orchestratorRun.error || "orchestrator_failed")));
      }
      const regenResult = orchestratorRun.result;
      let refreshed: Awaited<ReturnType<MobileLabLeadCardsDeps["getCachedLeadState"]>> | null = null;
      try {
        refreshed = await deps.getCachedLeadState(safeLeadId);
      } catch (error) {
        console.warn("[mobile-lab-lead-cards] refreshed_state_unavailable", {
          leadId: safeLeadId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      const refreshedRunId = String(refreshed?.latestRunId || "").trim();
      const fromCurrentRun = Boolean(regenResult.runId && refreshedRunId && refreshedRunId === String(regenResult.runId));
      const fromRun = normalizeTopReplyCard(regenResult.topReplyCard);
      const refreshedTop = fromCurrentRun ? normalizeTopReplyCard(refreshed?.topReplyCard) : null;
      const cachedBeforeTop = normalizeTopReplyCard(cachedBeforeForceRefresh?.topReplyCard);
      const topReplyCard = fromRun || refreshedTop || cachedBeforeTop;
      const stageSource =
        fromCurrentRun && refreshed?.stageAnalysis && typeof refreshed.stageAnalysis === "object"
          ? refreshed.stageAnalysis
          : regenResult.stageAnalysis && typeof regenResult.stageAnalysis === "object"
            ? regenResult.stageAnalysis
            : null;
      const strategySource =
        fromCurrentRun && refreshed?.strategy && typeof refreshed.strategy === "object"
          ? refreshed.strategy
          : regenResult.strategy && typeof regenResult.strategy === "object"
            ? regenResult.strategy
            : null;
      const providers = fromCurrentRun && refreshed?.providers && typeof refreshed.providers === "object" ? refreshed.providers : null;
      const prioritySource =
        fromCurrentRun && refreshed?.priorityItem && typeof refreshed.priorityItem === "object"
          ? refreshed.priorityItem
          : regenResult.priority && typeof regenResult.priority === "object"
            ? regenResult.priority
            : null;
      const provider =
        String((providers && (providers.brand_guardian || providers.reply_generator || providers.strategic_advisor || providers.stage_detection)) || "").trim() ||
        null;
      const partialError = regenResult.status === "partial" ? "partial_failure_some_steps_failed" : null;
      const failed = regenResult.status === "failed";
      const usedFallbackCard = Boolean(!fromRun && !refreshedTop && cachedBeforeTop);
      const status = topReplyCard
        ? "enriched"
        : failed
          ? "error"
          : "no_generation_needed";
      const errorText = usedFallbackCard
        ? (failed
            ? "Regeneration failed. Kept previous suggestions."
            : regenResult.status === "partial"
              ? "Regeneration partially failed. Kept previous suggestions."
              : "No new usable suggestions. Kept previous suggestions.")
        : (failed ? "provider_failed" : partialError);
      const cardsGeneratedAt = (fromCurrentRun ? refreshed?.updatedAt : null) || latestMessage.createdAt || new Date().toISOString();
      try {
        await deps.persistCachedLeadState({
          leadId: safeLeadId,
          latestMessageId: latestMessage.id,
          providers: {
            ...((providers && typeof providers === "object") ? providers : {}),
            based_on_message_id: latestMessage.id,
            cards_generated_at: cardsGeneratedAt
          }
        });
      } catch (error) {
        console.warn("[mobile-lab-lead-cards] persist_anchor_failed_on_force_refresh", {
          leadId: safeLeadId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      return {
        leadId: safeLeadId,
        replyCards: [],
        topReplyCard,
        generationMode: "fresh",
        source: "fresh_generation",
        cacheStatus: "forced_refresh",
        basedOnMessageId: latestMessage.id,
        currentLatestMessageId: latestMessage.id,
        basedOnTimestamp: cardsGeneratedAt,
        agentRunMeta: {
          runId: regenResult.runId || (fromCurrentRun ? refreshed?.latestRunId || null : null),
          generatedAt: cardsGeneratedAt,
          source: "fresh_generation",
          reasoningSource: (() => {
            const raw = String((fromCurrentRun ? refreshed?.reasoningSource : regenResult.reasoningSource) || "").trim().toLowerCase();
            return raw === "state_delta" || raw === "transcript_fallback"
              ? (raw as "state_delta" | "transcript_fallback")
              : null;
          })()
        },
        priorityIntelligence: normalizePriorityIntelligence(prioritySource),
        stageAnalysis: stageSource
          ? {
              stage: String((stageSource as Record<string, unknown>).stage || ""),
              stageConfidence: Number((stageSource as Record<string, unknown>).stage_confidence ?? (stageSource as Record<string, unknown>).stageConfidence ?? 0),
              urgency: String((stageSource as Record<string, unknown>).urgency || "low"),
              paymentIntent: Boolean((stageSource as Record<string, unknown>).payment_intent ?? (stageSource as Record<string, unknown>).paymentIntent),
              dropoffRisk: String((stageSource as Record<string, unknown>).dropoff_risk ?? (stageSource as Record<string, unknown>).dropoffRisk ?? "low"),
              priorityScore: Number((stageSource as Record<string, unknown>).priority_score ?? (stageSource as Record<string, unknown>).priorityScore ?? 0)
            }
          : null,
        summary: stageSource
          ? {
              stage: String((stageSource as Record<string, unknown>).stage || ""),
              stageConfidence: Number((stageSource as Record<string, unknown>).stage_confidence ?? (stageSource as Record<string, unknown>).stageConfidence ?? 0),
              urgency: String((stageSource as Record<string, unknown>).urgency || "low"),
              paymentIntent: Boolean((stageSource as Record<string, unknown>).payment_intent ?? (stageSource as Record<string, unknown>).paymentIntent),
              dropoffRisk: String((stageSource as Record<string, unknown>).dropoff_risk ?? (stageSource as Record<string, unknown>).dropoffRisk ?? "low"),
              priorityScore: Number((stageSource as Record<string, unknown>).priority_score ?? (stageSource as Record<string, unknown>).priorityScore ?? 0)
            }
          : null,
        strategy: strategySource
          ? {
              recommendedAction: String((strategySource as Record<string, unknown>).recommended_action ?? (strategySource as Record<string, unknown>).recommendedAction ?? ""),
              commercialPriority: String((strategySource as Record<string, unknown>).commercial_priority ?? (strategySource as Record<string, unknown>).commercialPriority ?? "medium"),
              tone: String((strategySource as Record<string, unknown>).tone || ""),
              pressureLevel: String((strategySource as Record<string, unknown>).pressure_level ?? (strategySource as Record<string, unknown>).pressureLevel ?? "none"),
              primaryGoal: String((strategySource as Record<string, unknown>).primary_goal ?? (strategySource as Record<string, unknown>).primaryGoal ?? ""),
              secondaryGoal: String((strategySource as Record<string, unknown>).secondary_goal ?? (strategySource as Record<string, unknown>).secondaryGoal ?? "")
            }
          : null,
        enrichmentStatus: status,
        enrichmentSource: "active_ai_cards",
        enrichmentError: errorText,
        status,
        pipelineSource: "active_ai_cards",
        error: errorText,
        provider,
        model: null,
        timestamp: new Date().toISOString()
      };
    }

    if (feedType === "active") {
      let cached: Awaited<ReturnType<MobileLabLeadCardsDeps["getCachedLeadState"]>> | null = null;
      try {
        cached = await deps.getCachedLeadState(safeLeadId);
      } catch (error) {
        console.warn("[mobile-lab-lead-cards] cached_state_unavailable", {
          leadId: safeLeadId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      let latestMessage: { id: string; createdAt: string } | null = null;
      try {
        latestMessage = await deps.getLatestLeadMessage(safeLeadId);
      } catch (error) {
        console.warn("[mobile-lab-lead-cards] latest_message_unavailable", {
          leadId: safeLeadId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      const cachedTop = cached?.topReplyCard && typeof cached.topReplyCard === "object" ? cached.topReplyCard : null;
      const cachedMessages = cachedTop && Array.isArray(cachedTop.messages)
        ? cachedTop.messages.map((m) => String(m || "")).filter(Boolean)
        : [];
      const cachedProviders = cached?.providers && typeof cached.providers === "object"
        ? (cached.providers as Record<string, unknown>)
        : null;
      const anchorMeta = generationAnchorFromProviders({
        providers: cachedProviders,
        fallbackBasedOnMessageId: cached?.latestMessageId || null,
        fallbackCardsGeneratedAt: cached?.updatedAt || null
      });
      const cacheStatus = resolveCacheStatus({
        forceRefresh,
        hasCachedTopCard: Boolean(cachedTop && cachedMessages.length > 0),
        basedOnMessageId: anchorMeta.basedOnMessageId,
        latestMessageId: latestMessage?.id || null
      });
      const buildCachedSnapshotResult = (effectiveCacheStatus: "hit" | "stale"): MobileLabLeadCardsResult | null => {
        if (!cachedTop || !cachedMessages.length) return null;
        const topReplyCard = {
          label: String(cachedTop.label || "").trim(),
          intent: String(cachedTop.intent || "").trim(),
          messages: cachedMessages,
          reason_short: String(cachedTop.reason_short || cachedTop.reasonShort || "").trim() || undefined
        };
        const fallbackMetaFromCache = (() => {
          const providers = cached?.providers && typeof cached.providers === "object" ? cached.providers : null;
          const row = providers && typeof (providers as Record<string, unknown>).fallback_generation === "object"
            ? ((providers as Record<string, unknown>).fallback_generation as Record<string, unknown>)
            : null;
          if (!row) return null;
          const estimatedNum = Number(row.estimatedCostUsd);
          return {
            path: "direct_generation_fallback" as const,
            provider: String(row.provider || "").trim() || null,
            model: String(row.model || "").trim() || null,
            inputTokens: numberOrNull(row.inputTokens),
            outputTokens: numberOrNull(row.outputTokens),
            estimatedCostUsd: Number.isFinite(estimatedNum) ? estimatedNum : null,
            generatedAt: String(row.generatedAt || "").trim() || null
          };
        })();
        const stage = cached?.stageAnalysis && typeof cached.stageAnalysis === "object"
          ? cached.stageAnalysis
          : null;
        const strategy = cached?.strategy && typeof cached.strategy === "object"
          ? cached.strategy
          : null;
        const providers = cached?.providers && typeof cached.providers === "object" ? cached.providers : null;
        const provider =
          String((providers && (providers.brand_guardian || providers.reply_generator || providers.strategic_advisor || providers.stage_detection)) || "").trim() ||
          null;
        return {
          leadId: safeLeadId,
          replyCards: [],
          topReplyCard,
          generationMode: "cached",
          generationFallbackUsed: Boolean(fallbackMetaFromCache),
          generationFallbackReason: fallbackMetaFromCache ? "direct_generation_fallback" : null,
          source: "cache",
          fallbackGenerationMeta: fallbackMetaFromCache,
          cacheStatus: effectiveCacheStatus,
          basedOnMessageId: anchorMeta.basedOnMessageId,
          currentLatestMessageId: latestMessage?.id || null,
          basedOnTimestamp: anchorMeta.cardsGeneratedAt || latestMessage?.createdAt || cached?.updatedAt || null,
          agentRunMeta: {
            runId: cached?.latestRunId || null,
            generatedAt: anchorMeta.cardsGeneratedAt || cached?.updatedAt || latestMessage?.createdAt || null,
            source: "cache",
            reasoningSource: (() => {
              const raw = String(cached?.reasoningSource || "").trim().toLowerCase();
              return raw === "state_delta" || raw === "transcript_fallback"
                ? (raw as "state_delta" | "transcript_fallback")
                : null;
            })()
          },
          priorityIntelligence: normalizePriorityIntelligence(cached?.priorityItem || null),
          stageAnalysis: stage
            ? {
                stage: String(stage.stage || ""),
                stageConfidence: Number(stage.stage_confidence ?? stage.stageConfidence ?? 0),
                urgency: String(stage.urgency || "low"),
                paymentIntent: Boolean(stage.payment_intent ?? stage.paymentIntent),
                dropoffRisk: String(stage.dropoff_risk ?? stage.dropoffRisk ?? "low"),
                priorityScore: Number(stage.priority_score ?? stage.priorityScore ?? 0)
              }
            : null,
          summary: stage
            ? {
                stage: String(stage.stage || ""),
                stageConfidence: Number(stage.stage_confidence ?? stage.stageConfidence ?? 0),
                urgency: String(stage.urgency || "low"),
                paymentIntent: Boolean(stage.payment_intent ?? stage.paymentIntent),
                dropoffRisk: String(stage.dropoff_risk ?? stage.dropoffRisk ?? "low"),
                priorityScore: Number(stage.priority_score ?? stage.priorityScore ?? 0)
              }
            : null,
          strategy: strategy
            ? {
                recommendedAction: String(strategy.recommended_action ?? strategy.recommendedAction ?? ""),
                commercialPriority: String(strategy.commercial_priority ?? strategy.commercialPriority ?? "medium"),
                tone: String(strategy.tone || ""),
                pressureLevel: String(strategy.pressure_level ?? strategy.pressureLevel ?? "none"),
                primaryGoal: String(strategy.primary_goal ?? strategy.primaryGoal ?? ""),
                secondaryGoal: String(strategy.secondary_goal ?? strategy.secondaryGoal ?? "")
              }
            : null,
          enrichmentStatus: "enriched",
          enrichmentSource: "active_ai_cards",
          enrichmentError: null,
          status: "enriched",
          pipelineSource: "active_ai_cards",
          error: null,
          provider,
          model: null,
          timestamp: new Date().toISOString()
        };
      };
      if (cacheStatus === "hit" && cachedTop && cachedMessages.length > 0) {
        const hit = buildCachedSnapshotResult("hit");
        if (hit) return hit;
      }

      const fallbackCacheKey = buildFallbackCacheKey(safeLeadId, latestMessage);
      if (useFallbackCache && fallbackCacheKey) {
        const fallbackCached = deps.getFallbackCache(fallbackCacheKey);
        if (fallbackCached && fallbackCached.generationFallbackUsed && fallbackCached.topReplyCard) {
          return {
            ...fallbackCached,
            generationMode: "cached",
            cacheStatus: "hit",
            source: "cache",
            basedOnMessageId: latestMessage?.id || fallbackCached.basedOnMessageId,
            currentLatestMessageId: latestMessage?.id || null,
            basedOnTimestamp: latestMessage?.createdAt || fallbackCached.basedOnTimestamp
          };
        }
      }

      // Fresh generation should be linked to an orchestrator run whenever possible
      // so AI Flow can immediately resolve run details, reasoning source, and costs.
      if (latestMessage?.id) {
        try {
          const orchestratorRun = await waitForOrchestratorSingleFlight({
            deps,
            leadId: safeLeadId,
            messageId: String(latestMessage.id),
            trigger: "mobile_lab_selected_lead_generation",
            timeoutMs
          });
          if (orchestratorRun.status === "timed_out_inflight") {
            console.info("[mobile-lab-lead-cards] fallback_blocked_orchestrator_inflight", {
              leadId: safeLeadId,
              latestMessageId: latestMessage.id,
              key: orchestratorRun.key,
              ownerId: orchestratorRun.ownerId
            });
            const staleSnapshot = buildCachedSnapshotResult("stale");
            if (staleSnapshot) {
              return staleSnapshot;
            }
            return {
              leadId: safeLeadId,
              replyCards: [],
              topReplyCard: null,
              generationMode: null,
              source: "fresh_generation",
              cacheStatus: "stale",
              basedOnMessageId: latestMessage.id,
              currentLatestMessageId: latestMessage.id,
              basedOnTimestamp: latestMessage.createdAt || null,
              agentRunMeta: {
                runId: null,
                generatedAt: latestMessage.createdAt || null,
                source: "fresh_generation",
                reasoningSource: null
              },
              stageAnalysis: null,
              summary: null,
              strategy: null,
              enrichmentStatus: "timeout",
              enrichmentSource: "active_ai_cards",
              enrichmentError: "orchestrator_inflight_timeout",
              status: "timeout",
              pipelineSource: "active_ai_cards",
              error: "orchestrator_inflight_timeout",
              provider: null,
              model: null,
              timestamp: new Date().toISOString()
            };
          }
          if (orchestratorRun.status === "failed") {
            console.info("[mobile-lab-lead-cards] fallback_allowed_orchestrator_failed", {
              leadId: safeLeadId,
              latestMessageId: latestMessage.id,
              key: orchestratorRun.key,
              ownerId: orchestratorRun.ownerId
            });
            throw (orchestratorRun.error instanceof Error ? orchestratorRun.error : new Error(String(orchestratorRun.error || "orchestrator_failed")));
          }
          const regenResult = orchestratorRun.result;
          let refreshed: Awaited<ReturnType<MobileLabLeadCardsDeps["getCachedLeadState"]>> | null = null;
          try {
            refreshed = await deps.getCachedLeadState(safeLeadId);
          } catch (error) {
            console.warn("[mobile-lab-lead-cards] refreshed_state_unavailable_after_fresh", {
              leadId: safeLeadId,
              error: error instanceof Error ? error.message : String(error)
            });
          }
          const fromRun = normalizeTopReplyCard(regenResult.topReplyCard);
          const refreshedTop = normalizeTopReplyCard(refreshed?.topReplyCard);
          const topReplyCard = fromRun || refreshedTop;
          if (!topReplyCard) {
            throw new Error("orchestrator_unusable_result");
          }
          const stageSource =
            refreshed?.stageAnalysis && typeof refreshed.stageAnalysis === "object"
              ? refreshed.stageAnalysis
              : regenResult.stageAnalysis && typeof regenResult.stageAnalysis === "object"
                ? regenResult.stageAnalysis
                : null;
          const strategySource =
            refreshed?.strategy && typeof refreshed.strategy === "object"
              ? refreshed.strategy
              : regenResult.strategy && typeof regenResult.strategy === "object"
                ? regenResult.strategy
                : null;
          const providers = refreshed?.providers && typeof refreshed.providers === "object" ? refreshed.providers : null;
          const prioritySource =
            refreshed?.priorityItem && typeof refreshed.priorityItem === "object"
              ? refreshed.priorityItem
              : regenResult.priority && typeof regenResult.priority === "object"
                ? regenResult.priority
                : null;
          const provider =
            String((providers && (providers.brand_guardian || providers.reply_generator || providers.strategic_advisor || providers.stage_detection)) || "").trim() ||
            null;
          const status = "enriched";
          const errorText = regenResult.status === "partial"
            ? "partial_failure_some_steps_failed"
            : regenResult.status === "failed"
              ? "provider_failed"
              : null;
          const reasoningSourceRaw = String((regenResult.reasoningSource || refreshed?.reasoningSource) || "").trim().toLowerCase();
          const reasoningSource = reasoningSourceRaw === "state_delta" || reasoningSourceRaw === "transcript_fallback"
            ? (reasoningSourceRaw as "state_delta" | "transcript_fallback")
            : null;
          const cardsGeneratedAt = refreshed?.updatedAt || latestMessage.createdAt || new Date().toISOString();
          const providersForPersistence = {
            ...((providers && typeof providers === "object") ? providers : {}),
            based_on_message_id: latestMessage.id,
            cards_generated_at: cardsGeneratedAt
          };
          try {
            await deps.persistCachedLeadState({
              leadId: safeLeadId,
              latestMessageId: latestMessage.id,
              providers: providersForPersistence
            });
          } catch (error) {
            console.warn("[mobile-lab-lead-cards] persist_anchor_failed_after_orchestrator", {
              leadId: safeLeadId,
              error: error instanceof Error ? error.message : String(error)
            });
          }
          return {
            leadId: safeLeadId,
            replyCards: [],
            topReplyCard,
            generationMode: "fresh",
            generationFallbackUsed: false,
            generationFallbackReason: null,
            source: "fresh_generation",
            cacheStatus,
            basedOnMessageId: latestMessage.id,
            currentLatestMessageId: latestMessage.id,
            basedOnTimestamp: cardsGeneratedAt,
            agentRunMeta: {
              runId: regenResult.runId || refreshed?.latestRunId || null,
              generatedAt: cardsGeneratedAt,
              source: "fresh_generation",
              reasoningSource
            },
            priorityIntelligence: normalizePriorityIntelligence(prioritySource),
            stageAnalysis: stageSource
              ? {
                  stage: String((stageSource as Record<string, unknown>).stage || ""),
                  stageConfidence: Number((stageSource as Record<string, unknown>).stage_confidence ?? (stageSource as Record<string, unknown>).stageConfidence ?? 0),
                  urgency: String((stageSource as Record<string, unknown>).urgency || "low"),
                  paymentIntent: Boolean((stageSource as Record<string, unknown>).payment_intent ?? (stageSource as Record<string, unknown>).paymentIntent),
                  dropoffRisk: String((stageSource as Record<string, unknown>).dropoff_risk ?? (stageSource as Record<string, unknown>).dropoffRisk ?? "low"),
                  priorityScore: Number((stageSource as Record<string, unknown>).priority_score ?? (stageSource as Record<string, unknown>).priorityScore ?? 0)
                }
              : null,
            summary: stageSource
              ? {
                  stage: String((stageSource as Record<string, unknown>).stage || ""),
                  stageConfidence: Number((stageSource as Record<string, unknown>).stage_confidence ?? (stageSource as Record<string, unknown>).stageConfidence ?? 0),
                  urgency: String((stageSource as Record<string, unknown>).urgency || "low"),
                  paymentIntent: Boolean((stageSource as Record<string, unknown>).payment_intent ?? (stageSource as Record<string, unknown>).paymentIntent),
                  dropoffRisk: String((stageSource as Record<string, unknown>).dropoff_risk ?? (stageSource as Record<string, unknown>).dropoffRisk ?? "low"),
                  priorityScore: Number((stageSource as Record<string, unknown>).priority_score ?? (stageSource as Record<string, unknown>).priorityScore ?? 0)
                }
              : null,
            strategy: strategySource
              ? {
                  recommendedAction: String((strategySource as Record<string, unknown>).recommended_action ?? (strategySource as Record<string, unknown>).recommendedAction ?? ""),
                  commercialPriority: String((strategySource as Record<string, unknown>).commercial_priority ?? (strategySource as Record<string, unknown>).commercialPriority ?? "medium"),
                  tone: String((strategySource as Record<string, unknown>).tone || ""),
                  pressureLevel: String((strategySource as Record<string, unknown>).pressure_level ?? (strategySource as Record<string, unknown>).pressureLevel ?? "none"),
                  primaryGoal: String((strategySource as Record<string, unknown>).primary_goal ?? (strategySource as Record<string, unknown>).primaryGoal ?? ""),
                  secondaryGoal: String((strategySource as Record<string, unknown>).secondary_goal ?? (strategySource as Record<string, unknown>).secondaryGoal ?? "")
                }
              : null,
            enrichmentStatus: status,
            enrichmentSource: "active_ai_cards",
            enrichmentError: errorText,
            status,
            pipelineSource: "active_ai_cards",
            error: errorText,
            provider,
            model: null,
            timestamp: new Date().toISOString()
          };
        } catch (error) {
          console.warn("[mobile-lab-lead-cards] fresh_orchestrator_failed_fallback_direct", {
            leadId: safeLeadId,
            error: error instanceof Error ? error.message : String(error)
          });
          const staleSnapshot = buildCachedSnapshotResult("stale");
          if (staleSnapshot) {
            console.info("[mobile-lab-lead-cards] snapshot_reused_after_orchestrator_failure", {
              leadId: safeLeadId,
              latestMessageId: latestMessage?.id || null
            });
            return staleSnapshot;
          }
        }
      }

      // Last-resort generation path: reuse partial cached state to recompute only missing steps.
      const cachedStageForRecompute =
        cached?.stageAnalysis && typeof cached.stageAnalysis === "object"
          ? (cached.stageAnalysis as Record<string, unknown>)
          : null;
      const cachedStrategyForRecompute =
        cached?.strategy && typeof cached.strategy === "object"
          ? (cached.strategy as Record<string, unknown>)
          : null;
      let replyContext: ReplyGeneratorResult;
      if (cachedStageForRecompute && cachedStrategyForRecompute) {
        console.info("[mobile-lab-lead-cards] partial_recomputation_after_orchestrator_failure", {
          leadId: safeLeadId,
          recomputedSteps: "reply_generator"
        });
        const transcript = await withTimeout(buildLeadTranscript(safeLeadId, 30), timeoutMs);
        replyContext = await withTimeout(
          buildReplyGeneratorFromContext({
            leadId: safeLeadId,
            transcript,
            stageAnalysis: cachedStageForRecompute as unknown as Parameters<typeof buildReplyGeneratorFromContext>[0]["stageAnalysis"],
            strategy: cachedStrategyForRecompute as unknown as Parameters<typeof buildReplyGeneratorFromContext>[0]["strategy"]
          }),
          timeoutMs
        );
      } else if (cachedStageForRecompute) {
        console.info("[mobile-lab-lead-cards] partial_recomputation_after_orchestrator_failure", {
          leadId: safeLeadId,
          recomputedSteps: "strategic_advisor,reply_generator"
        });
        const transcript = await withTimeout(buildLeadTranscript(safeLeadId, 30), timeoutMs);
        const strategic = await withTimeout(
          buildStrategicAdvisorFromContext({
            leadId: safeLeadId,
            transcript,
            stageAnalysis: cachedStageForRecompute as unknown as Parameters<typeof buildStrategicAdvisorFromContext>[0]["stageAnalysis"]
          }),
          timeoutMs
        );
        replyContext = await withTimeout(
          buildReplyGeneratorFromContext({
            leadId: safeLeadId,
            transcript,
            stageAnalysis: cachedStageForRecompute as unknown as Parameters<typeof buildReplyGeneratorFromContext>[0]["stageAnalysis"],
            strategy: strategic.strategy
          }),
          timeoutMs
        );
      } else {
        console.info("[mobile-lab-lead-cards] full_recomputation_last_resort", {
          leadId: safeLeadId,
          reason: "missing_cached_stage_and_strategy"
        });
        replyContext = await withTimeout(deps.getActiveReplyContext(safeLeadId), timeoutMs);
      }
      const replyCards = Array.isArray(replyContext.replyOptions?.reply_options) ? replyContext.replyOptions.reply_options : [];
      const topReplyCard = replyCards.length
        ? {
            label: String(replyCards[0].label || "").trim(),
            intent: String(replyCards[0].intent || "").trim(),
            messages: Array.isArray(replyCards[0].messages) ? replyCards[0].messages.map((m) => String(m || "")).filter(Boolean) : [],
            reason_short: String(replyCards[0].reason_short || "").trim() || undefined
          }
        : null;
      const status = topReplyCard ? "enriched" : "no_generation_needed";
      const pipelineSource = "active_ai_cards" as const;
      let priorityItem: Record<string, unknown> | null = null;
      const fallbackMeta = fallbackMetaFromReplyContext(replyContext);
      try {
        const priority = await buildLeadPriorityIntelligence(safeLeadId);
        priorityItem = {
          conversion_probability: priority.conversionProbability,
          dropoff_risk: priority.dropoffRisk,
          priority_score: priority.priorityScore,
          priority_band: priority.priorityBand,
          recommended_attention: priority.recommendedAttention,
          reason_codes: priority.reasonCodes,
          primary_reason_code: priority.primaryReasonCode
        };
      } catch (error) {
        console.warn("[mobile-lab-lead-cards] priority_intelligence_refresh_failed", {
          leadId: safeLeadId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      const cardsGeneratedAt = latestMessage?.createdAt || String(replyContext.timestamp || "").trim() || new Date().toISOString();
      try {
        await deps.persistCachedLeadState({
          leadId: safeLeadId,
          latestMessageId: latestMessage?.id || null,
          stageAnalysis: replyContext.stageAnalysis as unknown as Record<string, unknown>,
          priorityItem,
          strategy: replyContext.strategy as unknown as Record<string, unknown>,
          replyOptions: replyContext.replyOptions as unknown as Record<string, unknown>,
          topReplyCard: topReplyCard as unknown as Record<string, unknown> | null,
          providers: {
            reply_generator: replyContext.provider,
            fallback_generation: fallbackMeta,
            based_on_message_id: latestMessage?.id || null,
            cards_generated_at: cardsGeneratedAt
          }
        });
      } catch (error) {
        console.warn("[mobile-lab-lead-cards] persist_cached_state_failed", {
          leadId: safeLeadId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      const fallbackResult: MobileLabLeadCardsResult = {
        leadId: safeLeadId,
        replyCards: [],
        topReplyCard,
        generationMode: "fresh",
        generationFallbackUsed: true,
        generationFallbackReason: "direct_generation_fallback",
        fallbackGenerationMeta: fallbackMeta,
        source: "fresh_generation",
        cacheStatus,
        basedOnMessageId: latestMessage?.id || null,
        currentLatestMessageId: latestMessage?.id || null,
        basedOnTimestamp: cardsGeneratedAt,
        agentRunMeta: {
          runId: null,
          generatedAt: cardsGeneratedAt,
          source: "fresh_generation",
          reasoningSource: null
        },
        priorityIntelligence: normalizePriorityIntelligence(priorityItem),
        stageAnalysis: {
          stage: replyContext.stageAnalysis.stage,
          stageConfidence: replyContext.stageAnalysis.stage_confidence,
          urgency: replyContext.stageAnalysis.urgency,
          paymentIntent: replyContext.stageAnalysis.payment_intent,
          dropoffRisk: replyContext.stageAnalysis.dropoff_risk,
          priorityScore: replyContext.stageAnalysis.priority_score
        },
        summary: {
          stage: replyContext.stageAnalysis.stage,
          stageConfidence: replyContext.stageAnalysis.stage_confidence,
          urgency: replyContext.stageAnalysis.urgency,
          paymentIntent: replyContext.stageAnalysis.payment_intent,
          dropoffRisk: replyContext.stageAnalysis.dropoff_risk,
          priorityScore: replyContext.stageAnalysis.priority_score
        },
        strategy: {
          recommendedAction: replyContext.strategy.recommended_action,
          commercialPriority: replyContext.strategy.commercial_priority,
          tone: replyContext.strategy.tone,
          pressureLevel: replyContext.strategy.pressure_level,
          primaryGoal: replyContext.strategy.primary_goal,
          secondaryGoal: replyContext.strategy.secondary_goal
        },
        enrichmentStatus: status,
        enrichmentSource: pipelineSource,
        enrichmentError: null,
        status,
        pipelineSource,
        error: null,
        provider: replyContext.provider || null,
        model: replyContext.model || null,
        timestamp: new Date().toISOString()
      };
      if (useFallbackCache) {
        const key = buildFallbackCacheKey(safeLeadId, latestMessage);
        if (key && fallbackResult.topReplyCard) deps.setFallbackCache(key, fallbackResult);
      }
      return fallbackResult;
    }

    if (feedType === "reactivation") {
      const reactivation = await withTimeout(deps.getReactivationReplies(safeLeadId), timeoutMs);
      const replyCards = Array.isArray(reactivation.replyOptions)
        ? reactivation.replyOptions.map((option) => ({
            label: String(option.label || "").trim(),
            intent: String(option.intent || "").trim(),
            messages: Array.isArray(option.messages) ? option.messages.map((m) => String(m || "")).filter(Boolean) : [],
            reason_short: String(option.reason_short || "").trim() || undefined
          }))
        : [];
      const status = reactivation.shouldGenerate && replyCards.length ? "enriched" : "no_generation_needed";
      const source = "reactivation_replies" as const;
      const topReplyCard = replyCards.length ? replyCards[0] : null;
      return {
        leadId: safeLeadId,
        replyCards: [],
        topReplyCard,
        generationMode: "fresh",
        source: "fresh_generation",
        cacheStatus: "stale",
        basedOnMessageId: null,
        currentLatestMessageId: null,
        basedOnTimestamp: null,
        agentRunMeta: {
          runId: null,
          generatedAt: null,
          source: "reactivation_replies",
          reasoningSource: null
        },
        stageAnalysis: null,
        summary: null,
        strategy: null,
        enrichmentStatus: status,
        enrichmentSource: source,
        enrichmentError: null,
        status,
        pipelineSource: source,
        error: null,
        provider: reactivation.provider || null,
        model: reactivation.model || null,
        timestamp: new Date().toISOString()
      };
    }

    return {
      leadId: safeLeadId,
      replyCards: [],
      topReplyCard: null,
      generationMode: null,
      source: "fresh_generation",
      cacheStatus: "stale",
      basedOnMessageId: null,
      currentLatestMessageId: null,
      basedOnTimestamp: null,
      agentRunMeta: {
        runId: null,
        generatedAt: null,
        source: "fresh_generation",
        reasoningSource: null
      },
      stageAnalysis: null,
      summary: null,
      strategy: null,
      enrichmentStatus: "no_generation_needed",
      enrichmentSource: "active_ai_cards",
      enrichmentError: null,
      status: "no_generation_needed",
      pipelineSource: "active_ai_cards",
      error: null,
      provider: null,
      model: null,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    const isTimeout = error instanceof Error && error.message === "timeout";
    const status = isTimeout ? "timeout" : "error";
    const source = feedType === "reactivation" ? "reactivation_replies" : "active_ai_cards";
    const safeError = toSafeError(error);
    const cachedBeforeTop = forceRefresh ? normalizeTopReplyCard(cachedBeforeForceRefresh?.topReplyCard) : null;
    const preserved = Boolean(cachedBeforeTop);
    const fallbackMessage = isTimeout
      ? "Regeneration timed out. Kept previous suggestions."
      : "Regeneration failed. Kept previous suggestions.";
    return {
      leadId: safeLeadId,
      replyCards: [],
      topReplyCard: cachedBeforeTop,
      generationMode: forceRefresh ? "fresh" : null,
      generationFallbackUsed: feedType === "active",
      generationFallbackReason: feedType === "active" ? "direct_generation_fallback_error" : null,
      source: "fresh_generation",
      cacheStatus: forceRefresh ? "forced_refresh" : "stale",
      basedOnMessageId: null,
      currentLatestMessageId: null,
      basedOnTimestamp: null,
      agentRunMeta: {
        runId: null,
        generatedAt: null,
        source: feedType === "reactivation" ? "reactivation_replies" : "fresh_generation",
        reasoningSource: null
      },
      stageAnalysis: null,
      summary: null,
      strategy: null,
      enrichmentStatus: preserved ? "enriched" : status,
      enrichmentSource: source,
      enrichmentError: preserved ? fallbackMessage : safeError,
      status: preserved ? "enriched" : status,
      pipelineSource: source,
      error: preserved ? fallbackMessage : safeError,
      provider: null,
      model: null,
      timestamp: new Date().toISOString()
    };
  }
}
