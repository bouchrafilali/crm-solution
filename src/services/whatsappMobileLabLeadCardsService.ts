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

type Card = {
  label: string;
  intent: string;
  messages: string[];
};

export type MobileLabLeadCardsResult = {
  leadId: string;
  replyCards: Card[];
  topReplyCard: Card | null;
  generationMode: "cached" | "fresh" | null;
  source: "cache" | "fresh_generation";
  cacheStatus: "hit" | "miss" | "stale";
  basedOnMessageId: string | null;
  basedOnTimestamp: string | null;
  agentRunMeta: {
    runId: string | null;
    generatedAt: string | null;
    source: "cache" | "fresh_generation" | "reactivation_replies";
  };
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
  timeoutMs: () => number;
};

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
  const messages = Array.isArray(row.messages)
    ? row.messages.map((m) => String(m || "")).map((m) => m.trim()).filter(Boolean)
    : [];
  if (!label || !messages.length) return null;
  return { label, intent, messages };
}

function resolveCacheStatus(input: {
  forceRefresh: boolean;
  hasCachedTopCard: boolean;
  cachedLatestMessageId: string | null;
  cachedUpdatedAt: string | null;
  latestMessageId: string | null;
  latestMessageAt: string | null;
}): "hit" | "miss" | "stale" {
  if (input.forceRefresh) return "stale";
  if (!input.hasCachedTopCard) return "miss";
  if (!input.latestMessageId && !input.latestMessageAt) return "hit";
  if (input.cachedLatestMessageId && input.latestMessageId && input.cachedLatestMessageId !== input.latestMessageId) return "stale";
  const latestMs = toMs(input.latestMessageAt);
  const cachedMs = toMs(input.cachedUpdatedAt);
  if (Number.isFinite(latestMs) && Number.isFinite(cachedMs) && latestMs > cachedMs) return "stale";
  return "hit";
}

export async function buildMobileLabLeadCards(
  leadId: string,
  input?: { feedType?: "active" | "reactivation" | null; forceRefresh?: boolean | null },
  depsOverride?: Partial<MobileLabLeadCardsDeps>
): Promise<MobileLabLeadCardsResult> {
  const safeLeadId = String(leadId || "").trim();
  const deps: MobileLabLeadCardsDeps = { ...defaultDeps(), ...(depsOverride || {}) };
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
          cacheStatus: "stale",
          basedOnMessageId: null,
          basedOnTimestamp: null,
          agentRunMeta: {
            runId: null,
            generatedAt: null,
            source: "fresh_generation"
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
      const regenResult = await withTimeout(
        deps.runAgentOrchestrator({
          leadId: safeLeadId,
          messageId: String(latestMessage.id),
          trigger: "mobile_lab_manual_regenerate"
        }),
        timeoutMs
      );
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
      return {
        leadId: safeLeadId,
        replyCards: [],
        topReplyCard,
        generationMode: "fresh",
        source: "fresh_generation",
        cacheStatus: "stale",
        basedOnMessageId: latestMessage.id,
        basedOnTimestamp: latestMessage.createdAt || null,
        agentRunMeta: {
          runId: regenResult.runId || (fromCurrentRun ? refreshed?.latestRunId || null : null),
          generatedAt: (fromCurrentRun ? refreshed?.updatedAt : null) || latestMessage.createdAt || null,
          source: "fresh_generation"
        },
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
      const cacheStatus = resolveCacheStatus({
        forceRefresh,
        hasCachedTopCard: Boolean(cachedTop && cachedMessages.length > 0),
        cachedLatestMessageId: cached?.latestMessageId || null,
        cachedUpdatedAt: cached?.updatedAt || null,
        latestMessageId: latestMessage?.id || null,
        latestMessageAt: latestMessage?.createdAt || null
      });
      if (cacheStatus === "hit" && cachedTop && cachedMessages.length > 0) {
        const topReplyCard = {
          label: String(cachedTop.label || "").trim(),
          intent: String(cachedTop.intent || "").trim(),
          messages: cachedMessages
        };
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
          source: "cache",
          cacheStatus: "hit",
          basedOnMessageId: cached?.latestMessageId || latestMessage?.id || null,
          basedOnTimestamp: latestMessage?.createdAt || cached?.updatedAt || null,
          agentRunMeta: {
            runId: cached?.latestRunId || null,
            generatedAt: cached?.updatedAt || latestMessage?.createdAt || null,
            source: "cache"
          },
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
      }

      const replyContext = await withTimeout(deps.getActiveReplyContext(safeLeadId), timeoutMs);
      const replyCards = Array.isArray(replyContext.replyOptions?.reply_options) ? replyContext.replyOptions.reply_options : [];
      const topReplyCard = replyCards.length
        ? {
            label: String(replyCards[0].label || "").trim(),
            intent: String(replyCards[0].intent || "").trim(),
            messages: Array.isArray(replyCards[0].messages) ? replyCards[0].messages.map((m) => String(m || "")).filter(Boolean) : []
          }
        : null;
      const status = topReplyCard ? "enriched" : "no_generation_needed";
      const pipelineSource = "active_ai_cards" as const;
      let priorityItem: Record<string, unknown> | null = null;
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
      try {
        await deps.persistCachedLeadState({
          leadId: safeLeadId,
          latestMessageId: latestMessage?.id || null,
          stageAnalysis: replyContext.stageAnalysis as unknown as Record<string, unknown>,
          priorityItem,
          strategy: replyContext.strategy as unknown as Record<string, unknown>,
          replyOptions: replyContext.replyOptions as unknown as Record<string, unknown>,
          topReplyCard: topReplyCard as unknown as Record<string, unknown> | null,
          providers: { reply_generator: replyContext.provider }
        });
      } catch (error) {
        console.warn("[mobile-lab-lead-cards] persist_cached_state_failed", {
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
        cacheStatus,
        basedOnMessageId: latestMessage?.id || null,
        basedOnTimestamp: latestMessage?.createdAt || null,
        agentRunMeta: {
          runId: null,
          generatedAt: latestMessage?.createdAt || null,
          source: "fresh_generation"
        },
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
    }

    if (feedType === "reactivation") {
      const reactivation = await withTimeout(deps.getReactivationReplies(safeLeadId), timeoutMs);
      const replyCards = Array.isArray(reactivation.replyOptions)
        ? reactivation.replyOptions.map((option) => ({
            label: String(option.label || "").trim(),
            intent: String(option.intent || "").trim(),
            messages: Array.isArray(option.messages) ? option.messages.map((m) => String(m || "")).filter(Boolean) : []
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
        cacheStatus: "miss",
        basedOnMessageId: null,
        basedOnTimestamp: null,
        agentRunMeta: {
          runId: null,
          generatedAt: null,
          source: "reactivation_replies"
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
      cacheStatus: "miss",
      basedOnMessageId: null,
      basedOnTimestamp: null,
      agentRunMeta: {
        runId: null,
        generatedAt: null,
        source: "fresh_generation"
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
      source: "fresh_generation",
      cacheStatus: "stale",
      basedOnMessageId: null,
      basedOnTimestamp: null,
      agentRunMeta: {
        runId: null,
        generatedAt: null,
        source: feedType === "reactivation" ? "reactivation_replies" : "fresh_generation"
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
