import { createMlEvent } from "../db/mlRepo.js";
import { getDbPool, isDbEnabled } from "../db/client.js";
import {
  createSuggestionFeedbackDraft,
  getLearningLoopStats,
  getSuggestionFeedbackById,
  markSuggestionAction,
  markSuggestionOutcome,
  upsertSuggestionLearningSignal,
  type SuggestionDecisionType,
  type SuggestionOutcomeStatus,
  type SuggestionSource
} from "../db/whatsappSuggestionFeedbackRepo.js";

type OperatorLearningLoopDeps = {
  createSuggestionFeedbackDraft: typeof createSuggestionFeedbackDraft;
  getLearningLoopStats: typeof getLearningLoopStats;
  getSuggestionFeedbackById: typeof getSuggestionFeedbackById;
  markSuggestionAction: typeof markSuggestionAction;
  markSuggestionOutcome: typeof markSuggestionOutcome;
  upsertSuggestionLearningSignal: typeof upsertSuggestionLearningSignal;
  createMlEvent: typeof createMlEvent;
  getDbPool: typeof getDbPool;
  isDbEnabled: typeof isDbEnabled;
};

const defaultDeps: OperatorLearningLoopDeps = {
  createSuggestionFeedbackDraft,
  getLearningLoopStats,
  getSuggestionFeedbackById,
  markSuggestionAction,
  markSuggestionOutcome,
  upsertSuggestionLearningSignal,
  createMlEvent,
  getDbPool,
  isDbEnabled
};

const POSITIVE_OUTCOMES = new Set(["CLIENT_REPLIED", "STAGE_ADVANCED", "DEPOSIT_SIGNAL", "CONVERTED"]);
const STAGE_ORDER = [
  "NEW",
  "PRODUCT_INTEREST",
  "QUALIFICATION_PENDING",
  "QUALIFIED",
  "PRICE_SENT",
  "VIDEO_PROPOSED",
  "DEPOSIT_PENDING",
  "CONFIRMED",
  "CONVERTED",
  "LOST"
];

type CanonicalSuggestionInput = {
  leadId: string;
  conversationId?: string | null;
  operatorId?: string | null;
  source: SuggestionSource;
  suggestionType: string | null;
  suggestionText: string;
  suggestionPayload?: Record<string, unknown> | null;
  stageBeforeReply?: string | null;
  wasAiGenerated?: boolean;
};

type TrackDecisionInput = {
  leadId: string;
  conversationId?: string | null;
  operatorId?: string | null;
  stageBeforeReply?: string | null;
  stageAfterReply?: string | null;
  suggestionFeedback?: {
    id?: string | null;
    source?: string | null;
    suggestion_type?: string | null;
    suggested_text?: string | null;
    accepted?: boolean | null;
    decision_type?: SuggestionDecisionType | null;
  } | null;
  finalText: string;
  sendMessageId: string;
  actedAt?: string;
};

export type TrackDecisionResult = {
  suggestionId: string | null;
  decisionType: SuggestionDecisionType;
  similarityScore: number | null;
  editDistance: number | null;
  flags: Record<string, boolean>;
};

export type OutcomeEvaluationContext = {
  leadOutcome: string | null;
  hasDepositSignal: boolean;
  movedUp: boolean;
  hasInboundAfterReply: boolean;
  hoursSinceReply: number;
};

function normalizeText(value: string | null | undefined): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function levenshteinDistance(a: string, b: string): number {
  const aa = String(a || "");
  const bb = String(b || "");
  const m = aa.length;
  const n = bb.length;
  if (!m) return n;
  if (!n) return m;
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i += 1) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const tmp = dp[j];
      const cost = aa[i - 1] === bb[j - 1] ? 0 : 1;
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
      prev = tmp;
    }
  }
  return dp[n];
}

function computeSimilarity(a: string, b: string): number {
  const aa = normalizeText(a);
  const bb = normalizeText(b);
  if (!aa && !bb) return 1;
  const distance = levenshteinDistance(aa, bb);
  const maxLen = Math.max(aa.length, bb.length, 1);
  const score = 1 - distance / maxLen;
  return Math.max(0, Math.min(1, Number(score.toFixed(5))));
}

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function extractLearningFlags(suggestionText: string, finalText: string): Record<string, boolean> {
  const suggestion = String(suggestionText || "");
  const final = String(finalText || "");
  const suggestionNorm = normalizeText(suggestion);
  const finalNorm = normalizeText(final);
  const suggestionLen = suggestionNorm.length;
  const finalLen = finalNorm.length;

  const pricePattern = /\b(price|prix|tarif|budget|cost|dhs|mad|eur|usd|€|\$)\b/i;
  const qualificationPattern = /\?/;
  const depositPattern = /\b(deposit|acompte|paiement|payment|checkout|invoice|facture)\b/i;
  const videoPattern = /\b(video|visio|zoom|call)\b/i;
  const urgencyPattern = /\b(today|now|urgent|asap|imm[ée]diat|maintenant)\b/i;

  const suggestionHasPrice = pricePattern.test(suggestionNorm);
  const finalHasPrice = pricePattern.test(finalNorm);
  const suggestionHasQualification = qualificationPattern.test(suggestion);
  const finalHasQualification = qualificationPattern.test(final);
  const suggestionHasDeposit = depositPattern.test(suggestionNorm);
  const finalHasDeposit = depositPattern.test(finalNorm);
  const suggestionHasVideo = videoPattern.test(suggestionNorm);
  const finalHasVideo = videoPattern.test(finalNorm);
  const suggestionUrgent = urgencyPattern.test(suggestionNorm);
  const finalUrgent = urgencyPattern.test(finalNorm);

  return {
    final_text_shorter_than_suggestion: finalLen > 0 && suggestionLen > 0 && finalLen < suggestionLen,
    final_text_expanded_vs_suggestion: finalLen > 0 && suggestionLen > 0 && finalLen > suggestionLen,
    qualification_question_added: !suggestionHasQualification && finalHasQualification,
    qualification_question_removed: suggestionHasQualification && !finalHasQualification,
    price_removed: suggestionHasPrice && !finalHasPrice,
    price_added: !suggestionHasPrice && finalHasPrice,
    deposit_cta_added: !suggestionHasDeposit && finalHasDeposit,
    video_call_cta_added: !suggestionHasVideo && finalHasVideo,
    urgency_reduced: suggestionUrgent && !finalUrgent,
    urgency_increased: !suggestionUrgent && finalUrgent,
    tone_more_concise: finalLen > 0 && suggestionLen > 0 && finalLen <= Math.round(suggestionLen * 0.75)
  };
}

function stageRank(stage: string | null | undefined): number {
  const key = String(stage || "").trim().toUpperCase();
  const idx = STAGE_ORDER.indexOf(key);
  return idx >= 0 ? idx : -1;
}

async function emitLearningEvent(input: {
  eventType:
    | "SUGGESTION_GENERATED"
    | "SUGGESTION_ACCEPTED"
    | "SUGGESTION_EDITED"
    | "SUGGESTION_REJECTED"
    | "SUGGESTION_IGNORED"
    | "MANUAL_REPLY_SENT";
  leadId: string;
  source: "OUTBOUND_MANUAL" | "OUTBOUND_SUGGESTION" | "SYSTEM";
  payload: Record<string, unknown>;
}, deps: OperatorLearningLoopDeps = defaultDeps): Promise<void> {
  await deps.createMlEvent({
    eventType: input.eventType,
    leadId: input.leadId,
    source: input.source,
    payload: input.payload
  });
}

export async function createCanonicalSuggestionRecord(
  input: CanonicalSuggestionInput,
  deps: OperatorLearningLoopDeps = defaultDeps
): Promise<string | null> {
  const suggestionId = await deps.createSuggestionFeedbackDraft({
    leadId: input.leadId,
    conversationId: input.conversationId ?? input.leadId,
    operatorId: input.operatorId ?? null,
    source: input.source,
    suggestionType: input.suggestionType,
    suggestionText: input.suggestionText,
    suggestionPayload: input.suggestionPayload ?? null,
    stageBeforeReply: input.stageBeforeReply ?? null,
    wasAiGenerated: input.wasAiGenerated == null ? input.source !== "manual" : input.wasAiGenerated
  });

  if (suggestionId) {
    await emitLearningEvent({
      eventType: "SUGGESTION_GENERATED",
      leadId: input.leadId,
      source: "SYSTEM",
      payload: {
        suggestion_id: suggestionId,
        suggestion_type: input.suggestionType || null,
        suggestion_source: input.source,
        conversation_id: input.conversationId ?? input.leadId,
        stage_before_reply: input.stageBeforeReply || null
      }
    }, deps);
  }

  return suggestionId;
}

function classifyDecision(params: {
  explicitAccepted?: boolean | null;
  explicitDecision?: SuggestionDecisionType | null;
  similarityScore: number;
}): "ACCEPTED" | "EDITED" | "REJECTED" {
  if (params.explicitDecision) {
    if (params.explicitDecision === "MANUAL") return "REJECTED";
    return params.explicitDecision;
  }
  if (params.explicitAccepted === true) return "ACCEPTED";
  if (params.explicitAccepted === false) {
    return params.similarityScore < 0.35 ? "REJECTED" : "EDITED";
  }
  if (params.similarityScore >= 0.98) return "ACCEPTED";
  if (params.similarityScore < 0.35) return "REJECTED";
  return "EDITED";
}

export async function trackOperatorReplyDecision(
  input: TrackDecisionInput,
  deps: OperatorLearningLoopDeps = defaultDeps
): Promise<TrackDecisionResult> {
  const finalText = String(input.finalText || "").trim();
  const suggestionId = String(input.suggestionFeedback?.id || "").trim() || null;

  if (!suggestionId) {
    await emitLearningEvent({
      eventType: "MANUAL_REPLY_SENT",
      leadId: input.leadId,
      source: "OUTBOUND_MANUAL",
      payload: {
        send_message_id: input.sendMessageId,
        conversation_id: input.conversationId ?? input.leadId,
        stage_before_reply: input.stageBeforeReply ?? null,
        stage_after_reply: input.stageAfterReply ?? null,
        final_text: finalText
      }
    }, deps);
    return {
      suggestionId: null,
      decisionType: "MANUAL",
      similarityScore: null,
      editDistance: null,
      flags: {
        manual_without_suggestion_id: true
      }
    };
  }

  const suggestion = await deps.getSuggestionFeedbackById(suggestionId);
  const suggestionText = String(
    suggestion?.suggestionText || input.suggestionFeedback?.suggested_text || ""
  ).trim();

  const similarityScore = computeSimilarity(suggestionText, finalText);
  const editDistance = levenshteinDistance(normalizeText(suggestionText), normalizeText(finalText));
  const decisionType = classifyDecision({
    explicitAccepted: input.suggestionFeedback?.accepted,
    explicitDecision: input.suggestionFeedback?.decision_type ?? null,
    similarityScore
  });
  const flags = extractLearningFlags(suggestionText, finalText);

  await deps.markSuggestionAction({
    id: suggestionId,
    suggestionStatus: decisionType,
    finalHumanText: finalText,
    sendMessageId: input.sendMessageId,
    stageBeforeReply: input.stageBeforeReply || suggestion?.stageBeforeReply || null,
    stageAfterReply: input.stageAfterReply ?? null,
    actedAt: input.actedAt ?? new Date().toISOString(),
    operatorId: input.operatorId ?? null,
    conversationId: input.conversationId ?? input.leadId,
    accepted: decisionType === "ACCEPTED"
  });

  await deps.upsertSuggestionLearningSignal({
    suggestionFeedbackId: suggestionId,
    leadId: input.leadId,
    conversationId: input.conversationId ?? input.leadId,
    decisionType,
    similarityScore,
    editDistance,
    flags,
    outcomePositive: null,
    outcomeStatus: null
  });

  await emitLearningEvent({
    eventType:
      decisionType === "ACCEPTED"
        ? "SUGGESTION_ACCEPTED"
        : decisionType === "EDITED"
          ? "SUGGESTION_EDITED"
          : "SUGGESTION_REJECTED",
    leadId: input.leadId,
    source: "OUTBOUND_SUGGESTION",
    payload: {
      suggestion_id: suggestionId,
      suggestion_type: input.suggestionFeedback?.suggestion_type || suggestion?.suggestionType || null,
      send_message_id: input.sendMessageId,
      conversation_id: input.conversationId ?? input.leadId,
      decision_type: decisionType,
      similarity_score: similarityScore,
      edit_distance: editDistance
    }
  }, deps);

  return {
    suggestionId,
    decisionType,
    similarityScore,
    editDistance,
    flags
  };
}

function mapLegacyOutcomeLabel(status: SuggestionOutcomeStatus):
  | "NO_REPLY"
  | "REPLIED"
  | "PAYMENT_QUESTION"
  | "DEPOSIT_LINK_SENT"
  | "CONFIRMED"
  | "CONVERTED"
  | "LOST" {
  if (status === "CLIENT_REPLIED") return "REPLIED";
  if (status === "DEPOSIT_SIGNAL") return "DEPOSIT_LINK_SENT";
  if (status === "CONVERTED") return "CONVERTED";
  if (status === "LOST") return "LOST";
  if (status === "STAGE_ADVANCED") return "CONFIRMED";
  if (status === "NO_RESPONSE_24H" || status === "NO_RESPONSE_72H") return "NO_REPLY";
  return "NO_REPLY";
}

export function deriveOutcomeStatus(context: OutcomeEvaluationContext): SuggestionOutcomeStatus {
  const normalizedOutcome = String(context.leadOutcome || "").trim().toLowerCase();
  if (normalizedOutcome === "converted") return "CONVERTED";
  if (normalizedOutcome === "lost") return "LOST";
  if (context.hasDepositSignal) return "DEPOSIT_SIGNAL";
  if (context.movedUp) return "STAGE_ADVANCED";
  if (context.hasInboundAfterReply) return "CLIENT_REPLIED";
  if (context.hoursSinceReply >= 72) return "NO_RESPONSE_72H";
  if (context.hoursSinceReply >= 24) return "NO_RESPONSE_24H";
  return "UNKNOWN";
}

export async function evaluateSuggestionOutcomes(input?: {
  limit?: number;
  nowIso?: string;
}, deps: OperatorLearningLoopDeps = defaultDeps): Promise<{ scanned: number; updated: number }> {
  const db = deps.getDbPool();
  if (!db) return { scanned: 0, updated: 0 };
  const now = new Date(input?.nowIso || new Date().toISOString());
  const limit = Math.max(1, Math.min(1000, Math.round(input?.limit || 300)));

  const q = await db.query<{
    id: string;
    lead_id: string;
    conversation_id: string | null;
    send_message_id: string | null;
    acted_at: string | null;
    stage_before_reply: string | null;
    suggestion_status: string;
  }>(
    `
      select
        id,
        lead_id,
        conversation_id,
        send_message_id,
        acted_at,
        stage_before_reply,
        suggestion_status
      from whatsapp_suggestion_feedback
      where acted_at is not null
        and suggestion_status in ('ACCEPTED', 'EDITED', 'REJECTED')
        and (
          outcome_status is null
          or outcome_status = 'UNKNOWN'
          or (outcome_status = 'NO_RESPONSE_24H' and acted_at <= now() - interval '72 hours')
        )
      order by acted_at asc
      limit $1::int
    `,
    [limit]
  );

  let updated = 0;

  const expiredRows = await db.query<{ id: string; lead_id: string; suggestion_type: string | null }>(
    `
      update whatsapp_suggestion_feedback
      set
        suggestion_status = 'EXPIRED',
        updated_at = now()
      where suggestion_status = 'GENERATED'
        and acted_at is null
        and generated_at <= now() - interval '24 hours'
      returning id, lead_id, suggestion_type
    `
  );
  for (const item of expiredRows.rows) {
    await emitLearningEvent({
      eventType: "SUGGESTION_IGNORED",
      leadId: item.lead_id,
      source: "SYSTEM",
      payload: {
        suggestion_id: item.id,
        suggestion_type: item.suggestion_type || null,
        reason: "expired_24h_without_action"
      }
    }, deps);
  }

  for (const row of q.rows) {
    const actedAt = row.acted_at ? new Date(row.acted_at) : null;
    if (!actedAt) continue;

    const inboundQ = await db.query<{ created_at: string }>(
      `
        select created_at
        from whatsapp_lead_messages
        where lead_id = $1::uuid
          and direction = 'IN'
          and created_at > $2::timestamptz
        order by created_at asc
        limit 1
      `,
      [row.lead_id, actedAt.toISOString()]
    );

    const leadQ = await db.query<{
      stage: string;
      has_payment_question: boolean;
      has_deposit_link_sent: boolean;
      payment_intent: boolean;
      deposit_intent: boolean;
    }>(
      `
        select
          stage,
          has_payment_question,
          has_deposit_link_sent,
          payment_intent,
          deposit_intent
        from whatsapp_leads
        where id = $1::uuid
        limit 1
      `,
      [row.lead_id]
    );

    const outcomeQ = await db.query<{ outcome: string; final_stage: string | null }>(
      `
        select outcome, final_stage
        from whatsapp_lead_outcomes
        where lead_id = $1::uuid
        limit 1
      `,
      [row.lead_id]
    );

    const currentStage = String(leadQ.rows[0]?.stage || "").trim().toUpperCase() || null;
    const beforeStage = String(row.stage_before_reply || "").trim().toUpperCase() || null;
    const movedUp = beforeStage && currentStage ? stageRank(currentStage) > stageRank(beforeStage) : false;

    const hasDepositSignal =
      Boolean(leadQ.rows[0]?.has_payment_question) ||
      Boolean(leadQ.rows[0]?.has_deposit_link_sent) ||
      Boolean(leadQ.rows[0]?.payment_intent) ||
      Boolean(leadQ.rows[0]?.deposit_intent);

    const outcome = String(outcomeQ.rows[0]?.outcome || "").trim().toLowerCase();
    const elapsedMs = now.getTime() - actedAt.getTime();
    const hours = elapsedMs / 3600000;

    const outcomeStatus = deriveOutcomeStatus({
      leadOutcome: outcome,
      hasDepositSignal,
      movedUp,
      hasInboundAfterReply: Boolean(inboundQ.rows[0]),
      hoursSinceReply: hours
    });

    const ok = await deps.markSuggestionOutcome({
      id: row.id,
      outcomeLabel: mapLegacyOutcomeLabel(outcomeStatus),
      outcomeStatus,
      stageAfterReply: currentStage,
      evaluatedAt: now.toISOString()
    });

    if (ok) {
      updated += 1;
      await db.query(
        `
          update whatsapp_suggestion_learning_signals
          set
            outcome_positive = $2::boolean,
            outcome_status = $3::text
          where suggestion_feedback_id = $1::uuid
        `,
        [row.id, POSITIVE_OUTCOMES.has(outcomeStatus), outcomeStatus]
      );
    }
  }

  return {
    scanned: q.rows.length + expiredRows.rows.length,
    updated
  };
}

export async function computeLearningLoopStats(input?: {
  days?: number;
  suggestionType?: string | null;
}, deps: OperatorLearningLoopDeps = defaultDeps) {
  return deps.getLearningLoopStats({
    days: input?.days,
    suggestionType: input?.suggestionType
  });
}

let workerStarted = false;

export function startOperatorLearningLoopWorker(): void {
  if (workerStarted) return;
  if (!defaultDeps.isDbEnabled()) return;
  workerStarted = true;

  const tickMs = 30 * 60 * 1000;
  void evaluateSuggestionOutcomes().catch((error) => {
    console.error("[operator-learning-loop] startup evaluation failed", error);
  });

  setInterval(() => {
    void evaluateSuggestionOutcomes().catch((error) => {
      console.error("[operator-learning-loop] evaluation failed", error);
    });
  }, tickMs);

  console.log("[operator-learning-loop] worker started (every 30 minutes)");
}
