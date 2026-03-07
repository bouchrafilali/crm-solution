import {
  buildReplyGeneratorFromContext,
  type ReplyGeneratorResult
} from "./whatsappReplyGeneratorService.js";
import { getWhatsAppAgentLeadState } from "../db/whatsappAgentRunsRepo.js";
import { detectStageFromTranscript } from "./whatsappStageDetectionService.js";
import { buildStrategicAdvisorFromContext } from "./whatsappStrategicAdvisorService.js";
import { buildLeadTranscript } from "./whatsappTranscriptFormatter.js";
import { buildLeadReactivationReplies } from "./whatsappReactivationReplyService.js";

type Card = {
  label: string;
  intent: string;
  messages: string[];
};

export type MobileLabLeadCardsResult = {
  leadId: string;
  replyCards: Card[];
  topReplyCard: Card | null;
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
  source: "active_ai_cards" | "reactivation_replies";
  error: string | null;
  provider: string | null;
  model: string | null;
  timestamp: string;
};

type MobileLabLeadCardsDeps = {
  getCachedLeadState: (leadId: string) => ReturnType<typeof getWhatsAppAgentLeadState>;
  getActiveReplyContext: (leadId: string) => Promise<ReplyGeneratorResult>;
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

export async function buildMobileLabLeadCards(
  leadId: string,
  input?: { feedType?: "active" | "reactivation" | null },
  depsOverride?: Partial<MobileLabLeadCardsDeps>
): Promise<MobileLabLeadCardsResult> {
  const safeLeadId = String(leadId || "").trim();
  const deps: MobileLabLeadCardsDeps = { ...defaultDeps(), ...(depsOverride || {}) };
  const timeoutMs = deps.timeoutMs();
  const feedType = input?.feedType === "reactivation" ? "reactivation" : "active";

  try {
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
      const cachedTop = cached?.topReplyCard && typeof cached.topReplyCard === "object" ? cached.topReplyCard : null;
      const cachedMessages = cachedTop && Array.isArray(cachedTop.messages)
        ? cachedTop.messages.map((m) => String(m || "")).filter(Boolean)
        : [];
      if (cachedTop && cachedMessages.length > 0) {
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
          source: "active_ai_cards",
          error: null,
          provider,
          model: null,
          timestamp: new Date().toISOString()
        };
      }
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
        stageAnalysis: null,
        summary: null,
        strategy: null,
        enrichmentStatus: status,
        enrichmentSource: source,
        enrichmentError: null,
        status,
        source,
        error: null,
        provider: reactivation.provider || null,
        model: reactivation.model || null,
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
    const source = "active_ai_cards" as const;
    return {
      leadId: safeLeadId,
      replyCards: [],
      topReplyCard,
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
      enrichmentSource: source,
      enrichmentError: null,
      status,
      source,
      error: null,
      provider: replyContext.provider || null,
      model: replyContext.model || null,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    const isTimeout = error instanceof Error && error.message === "timeout";
    const status = isTimeout ? "timeout" : "error";
    const source = feedType === "reactivation" ? "reactivation_replies" : "active_ai_cards";
    const safeError = toSafeError(error);
    return {
      leadId: safeLeadId,
      replyCards: [],
      topReplyCard: null,
      stageAnalysis: null,
      summary: null,
      strategy: null,
      enrichmentStatus: status,
      enrichmentSource: source,
      enrichmentError: safeError,
      status,
      source,
      error: safeError,
      provider: null,
      model: null,
      timestamp: new Date().toISOString()
    };
  }
}
