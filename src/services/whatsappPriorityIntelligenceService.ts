import { getWhatsAppLeadById, listWhatsAppLeads } from "../db/whatsappLeadsRepo.js";
import { getWhatsAppLeadOutcome } from "../db/whatsappLeadOutcomesRepo.js";
import { getWhatsAppAgentLeadState } from "../db/whatsappAgentRunsRepo.js";
import { buildAiCardsViewModel, type AiCardsViewModel } from "./whatsappAiCardsService.js";
import { buildLeadPriorityScore, mapPriorityBand, type PriorityBand, type PriorityDeskItem } from "./whatsappPriorityDeskService.js";
import { buildLeadReactivationCheck, type ReactivationDecision } from "./whatsappReactivationEngineService.js";

export type PriorityAttentionAction = "reply_now" | "reactivate_now" | "wait" | "monitor" | "close_out";
export type PrioritySurface = "mobile_lab" | "priority_desk" | "reactivation_queue";

export const PRIORITY_INTELLIGENCE_REASON_CODES_V1 = {
  product_interest_detected: "product_interest_detected",
  price_request_detected: "price_request_detected",
  payment_intent_detected: "payment_intent_detected",
  shipping_question_detected: "shipping_question_detected",
  event_date_detected: "event_date_detected",
  event_date_near: "event_date_near",
  awaiting_reply: "awaiting_reply",
  long_silence_detected: "long_silence_detected",
  price_sent_then_silence: "price_sent_then_silence",
  deposit_pending_then_silence: "deposit_pending_then_silence",
  high_ticket_context: "high_ticket_context",
  repeat_customer_detected: "repeat_customer_detected",
  dropoff_risk_high: "dropoff_risk_high",
  stage_deposit_pending: "stage_deposit_pending",
  stage_stalled: "stage_stalled"
} as const;

export type PriorityIntelligenceReasonCode =
  (typeof PRIORITY_INTELLIGENCE_REASON_CODES_V1)[keyof typeof PRIORITY_INTELLIGENCE_REASON_CODES_V1];

export type PriorityIntelligenceDecision = {
  leadId: string;
  priorityScore: number;
  priorityBand: PriorityBand;
  conversionProbability: number;
  dropoffRisk: number;
  recommendedAttention: PriorityAttentionAction;
  recommendedSurface: PrioritySurface;
  reasonCodes: PriorityIntelligenceReasonCode[];
  primaryReasonCode: PriorityIntelligenceReasonCode | null;
  operatorGuidance: string;
};

export type PriorityIntelligenceQueueResponse = {
  items: PriorityIntelligenceDecision[];
  meta: {
    count: number;
    limit: number;
    days: number;
    generatedAt: string;
  };
};

export type ComputePriorityIntelligenceInput = {
  leadId: string;
  stage: string;
  awaitingReply: boolean;
  waitingMinutes: number;
  silenceMinutes: number;
  reactivationState: {
    shouldReactivate: boolean;
    reactivationPriority: "low" | "medium" | "high";
    stalledStage: string | null;
  };
  signals: {
    product_interest_detected: boolean;
    price_request_detected: boolean;
    payment_intent_detected: boolean;
    deposit_intent_detected: boolean;
    shipping_question_detected: boolean;
    delivery_timing_detected: boolean;
    customization_request_detected: boolean;
    video_interest_detected: boolean;
    event_date_detected: boolean;
    event_date_near: boolean;
    high_ticket_context: boolean;
    repeat_customer_detected: boolean;
    price_objection_detected: boolean;
    timing_objection_detected: boolean;
    trust_friction_detected: boolean;
    fit_uncertainty_detected: boolean;
    fabric_uncertainty_detected: boolean;
    external_approval_delay_detected: boolean;
    recent_inbound_message: boolean;
  };
};

export class PriorityIntelligenceError extends Error {
  step:
    | "invalid_lead_id"
    | "lead_metadata"
    | "lead_state"
    | "ai_cards"
    | "priority_score"
    | "reactivation"
    | "outcome"
    | "queue";

  constructor(
    step:
      | "invalid_lead_id"
      | "lead_metadata"
      | "lead_state"
      | "ai_cards"
      | "priority_score"
      | "reactivation"
      | "outcome"
      | "queue",
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message);
    this.step = step;
    if (options && "cause" in options) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

type PriorityIntelligenceDeps = {
  getLeadById: typeof getWhatsAppLeadById;
  getLeadState: typeof getWhatsAppAgentLeadState;
  getAiCards: (leadId: string) => Promise<AiCardsViewModel>;
  getPriorityScore: (leadId: string) => Promise<PriorityDeskItem>;
  getReactivation: (leadId: string) => Promise<ReactivationDecision>;
  getLeadOutcome: typeof getWhatsAppLeadOutcome;
  listLeads: typeof listWhatsAppLeads;
  nowIso: () => string;
  nowMs: () => number;
};

function defaultDeps(): PriorityIntelligenceDeps {
  return {
    getLeadById: (leadId) => getWhatsAppLeadById(leadId),
    getLeadState: (leadId) => getWhatsAppAgentLeadState(leadId),
    getAiCards: (leadId) => buildAiCardsViewModel(leadId),
    getPriorityScore: (leadId) => buildLeadPriorityScore(leadId),
    getReactivation: (leadId) => buildLeadReactivationCheck(leadId),
    getLeadOutcome: (leadId) => getWhatsAppLeadOutcome(leadId),
    listLeads: (input) => listWhatsAppLeads(input),
    nowIso: () => new Date().toISOString(),
    nowMs: () => Date.now()
  };
}

const STAGE_WEIGHTS: Record<string, number> = {
  NEW: 0.02,
  PRODUCT_INTEREST: 0.05,
  QUALIFICATION_PENDING: 0.1,
  QUALIFIED: 0.18,
  PRICE_SENT: 0.28,
  VIDEO_PROPOSED: 0.34,
  VIDEO_DONE: 0.42,
  DEPOSIT_PENDING: 0.6,
  CONFIRMED: 0.85,
  CONVERTED: 1
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function stageKey(stage: string): string {
  return String(stage || "").trim().toUpperCase();
}

function eventDateNear(eventDate: string | null | undefined, nowMs: number): boolean {
  if (!eventDate) return false;
  const eventMs = new Date(`${eventDate}T00:00:00.000Z`).getTime();
  if (!Number.isFinite(eventMs)) return false;
  const days = Math.floor((eventMs - nowMs) / 86400000);
  return days >= 0 && days <= 10;
}

function hasSignalType(signals: unknown, type: string): boolean {
  if (!Array.isArray(signals)) return false;
  return signals.some((row) => {
    if (!row || typeof row !== "object") return false;
    return String((row as Record<string, unknown>).type || "").toLowerCase() === type;
  });
}

function hasObjectionType(objections: unknown, type: string): boolean {
  if (!Array.isArray(objections)) return false;
  return objections.some((row) => {
    if (!row || typeof row !== "object") return false;
    return String((row as Record<string, unknown>).type || "").toLowerCase() === type;
  });
}

function hasAnyTag(tags: unknown, values: string[]): boolean {
  if (!Array.isArray(tags)) return false;
  const normalized = new Set(values.map((v) => v.toLowerCase()));
  return tags.some((tag) => normalized.has(String(tag || "").toLowerCase()));
}

function pickSurface(attention: PriorityAttentionAction, awaitingReply: boolean): PrioritySurface {
  if (attention === "reactivate_now") return "reactivation_queue";
  if (attention === "reply_now") return awaitingReply ? "mobile_lab" : "priority_desk";
  return "priority_desk";
}

function guidanceForAttention(action: PriorityAttentionAction): string {
  if (action === "reply_now") return "Respond now with a concise next-step message and clear CTA.";
  if (action === "reactivate_now") return "Lead is stalled. Send a gentle reactivation follow-up now.";
  if (action === "monitor") return "Monitor this lead and watch for new inbound signals before intervening.";
  if (action === "close_out") return "Lead appears closed. Close out and remove from active attention queues.";
  return "No immediate action required. Keep this lead under light observation.";
}

function silenceRiskBoost(silenceMinutes: number): number {
  if (silenceMinutes > 4320) return 0.6;
  if (silenceMinutes > 2880) return 0.45;
  if (silenceMinutes > 1440) return 0.3;
  if (silenceMinutes > 360) return 0.18;
  if (silenceMinutes > 120) return 0.08;
  if (silenceMinutes > 30) return 0.03;
  return 0;
}

export function mapPriorityBandFromScore(score: number): PriorityBand {
  const safe = Math.max(0, Math.min(100, Math.round(Number(score || 0))));
  if (safe <= 25) return "low";
  if (safe <= 50) return "medium";
  if (safe <= 75) return "high";
  return "critical";
}

export function computePriorityIntelligence(input: ComputePriorityIntelligenceInput): PriorityIntelligenceDecision {
  const stage = stageKey(input.stage);
  const waitingMinutes = Math.max(0, Math.round(Number(input.waitingMinutes || 0)));
  const silenceMinutes = Math.max(0, Math.round(Number(input.silenceMinutes || 0)));

  const longSilenceDetected = silenceMinutes > 1440;
  const priceSentThenSilence =
    (input.reactivationState.shouldReactivate && input.reactivationState.stalledStage === "PRICE_SENT") ||
    (stage === "PRICE_SENT" && silenceMinutes > 360);
  const videoProposedThenSilence =
    (input.reactivationState.shouldReactivate && input.reactivationState.stalledStage === "VIDEO_PROPOSED") ||
    (stage === "VIDEO_PROPOSED" && silenceMinutes > 360);
  const depositPendingThenSilence =
    (input.reactivationState.shouldReactivate && input.reactivationState.stalledStage === "DEPOSIT_PENDING") ||
    (stage === "DEPOSIT_PENDING" && silenceMinutes > 120);
  const qualifiedLeadStalled =
    (input.reactivationState.shouldReactivate && input.reactivationState.stalledStage === "QUALIFIED") ||
    (stage === "QUALIFIED" && silenceMinutes > 1440);

  let conversion = 0.08;
  conversion += STAGE_WEIGHTS[stage] ?? 0;
  if (input.signals.payment_intent_detected) conversion += 0.2;
  if (input.signals.deposit_intent_detected) conversion += 0.25;
  if (input.signals.shipping_question_detected) conversion += 0.08;
  if (input.signals.delivery_timing_detected) conversion += 0.1;
  if (input.signals.customization_request_detected) conversion += 0.07;
  if (input.signals.video_interest_detected) conversion += 0.12;
  if (input.signals.price_request_detected) conversion += 0.09;
  if (input.signals.event_date_detected) conversion += 0.06;
  if (input.signals.event_date_near) conversion += 0.12;
  if (input.signals.high_ticket_context) conversion += 0.08;
  if (input.signals.repeat_customer_detected) conversion += 0.15;
  if (input.signals.price_objection_detected) conversion -= 0.1;
  if (input.signals.timing_objection_detected) conversion -= 0.07;
  if (input.signals.trust_friction_detected) conversion -= 0.08;
  if (longSilenceDetected) conversion -= 0.12;
  if (stage === "LOST") conversion = 0;
  if (stage === "CONVERTED") conversion = 1;
  const conversionProbability = round4(clamp01(conversion));

  let dropoff = 0.05;
  dropoff += silenceRiskBoost(silenceMinutes);
  if (priceSentThenSilence) dropoff += 0.25;
  if (videoProposedThenSilence) dropoff += 0.2;
  if (depositPendingThenSilence) dropoff += 0.35;
  if (qualifiedLeadStalled) dropoff += 0.2;
  if (input.signals.price_objection_detected) dropoff += 0.18;
  if (input.signals.fit_uncertainty_detected) dropoff += 0.1;
  if (input.signals.fabric_uncertainty_detected) dropoff += 0.08;
  if (input.signals.external_approval_delay_detected) dropoff += 0.15;
  if (input.signals.recent_inbound_message) dropoff -= 0.25;
  if (input.signals.payment_intent_detected) dropoff -= 0.18;
  if (input.signals.deposit_intent_detected) dropoff -= 0.25;
  if (input.signals.event_date_near) dropoff -= 0.1;
  if (stage === "LOST" || stage === "CONVERTED") dropoff = 0;
  const dropoffRisk = round4(clamp01(dropoff));

  const priorityScore = Math.max(0, Math.min(100, Math.round(conversionProbability * 70 + dropoffRisk * 30)));
  const priorityBand = mapPriorityBandFromScore(priorityScore);

  let recommendedAttention: PriorityAttentionAction = "wait";
  if (stage === "LOST" || stage === "CONVERTED") {
    recommendedAttention = "close_out";
  } else if (conversionProbability > 0.65 && input.awaitingReply) {
    recommendedAttention = "reply_now";
  } else if (dropoffRisk > 0.55) {
    recommendedAttention = "reactivate_now";
  } else if (conversionProbability < 0.25 && dropoffRisk < 0.25) {
    recommendedAttention = "monitor";
  }

  const reasonFlags: Record<PriorityIntelligenceReasonCode, boolean> = {
    product_interest_detected: input.signals.product_interest_detected,
    price_request_detected: input.signals.price_request_detected,
    payment_intent_detected: input.signals.payment_intent_detected,
    shipping_question_detected: input.signals.shipping_question_detected,
    event_date_detected: input.signals.event_date_detected,
    event_date_near: input.signals.event_date_near,
    awaiting_reply: input.awaitingReply,
    long_silence_detected: longSilenceDetected,
    price_sent_then_silence: priceSentThenSilence,
    deposit_pending_then_silence: depositPendingThenSilence,
    high_ticket_context: input.signals.high_ticket_context,
    repeat_customer_detected: input.signals.repeat_customer_detected,
    dropoff_risk_high: dropoffRisk > 0.55,
    stage_deposit_pending: stage === "DEPOSIT_PENDING",
    stage_stalled: stage === "STALLED" || input.reactivationState.shouldReactivate || qualifiedLeadStalled
  };

  const reasonCodes = Object.values(PRIORITY_INTELLIGENCE_REASON_CODES_V1).filter((code) => reasonFlags[code]);
  const primaryOrder: PriorityIntelligenceReasonCode[] = [
    PRIORITY_INTELLIGENCE_REASON_CODES_V1.awaiting_reply,
    PRIORITY_INTELLIGENCE_REASON_CODES_V1.deposit_pending_then_silence,
    PRIORITY_INTELLIGENCE_REASON_CODES_V1.price_sent_then_silence,
    PRIORITY_INTELLIGENCE_REASON_CODES_V1.dropoff_risk_high,
    PRIORITY_INTELLIGENCE_REASON_CODES_V1.payment_intent_detected,
    PRIORITY_INTELLIGENCE_REASON_CODES_V1.stage_deposit_pending,
    PRIORITY_INTELLIGENCE_REASON_CODES_V1.event_date_near,
    PRIORITY_INTELLIGENCE_REASON_CODES_V1.long_silence_detected,
    PRIORITY_INTELLIGENCE_REASON_CODES_V1.stage_stalled,
    PRIORITY_INTELLIGENCE_REASON_CODES_V1.high_ticket_context,
    PRIORITY_INTELLIGENCE_REASON_CODES_V1.price_request_detected,
    PRIORITY_INTELLIGENCE_REASON_CODES_V1.product_interest_detected,
    PRIORITY_INTELLIGENCE_REASON_CODES_V1.repeat_customer_detected,
    PRIORITY_INTELLIGENCE_REASON_CODES_V1.shipping_question_detected,
    PRIORITY_INTELLIGENCE_REASON_CODES_V1.event_date_detected
  ];
  const primaryReasonCode = primaryOrder.find((code) => reasonFlags[code]) ?? null;

  return {
    leadId: input.leadId,
    priorityScore,
    priorityBand,
    conversionProbability,
    dropoffRisk,
    recommendedAttention,
    recommendedSurface: pickSurface(recommendedAttention, input.awaitingReply),
    reasonCodes,
    primaryReasonCode,
    operatorGuidance: guidanceForAttention(recommendedAttention)
  };
}

function signalFromFactsList(input: unknown): boolean {
  return Array.isArray(input) && input.some((item) => String(item || "").trim().length > 0);
}

function signalFromString(input: unknown): boolean {
  return String(input || "").trim().length > 0;
}

function mergeFacts(leadState: Record<string, unknown> | null): Record<string, unknown> {
  const facts = leadState?.facts;
  if (facts && typeof facts === "object" && !Array.isArray(facts)) return facts as Record<string, unknown>;
  const stageAnalysis = leadState?.stageAnalysis;
  if (!stageAnalysis || typeof stageAnalysis !== "object" || Array.isArray(stageAnalysis)) return {};
  const stageFacts = (stageAnalysis as Record<string, unknown>).facts;
  if (stageFacts && typeof stageFacts === "object" && !Array.isArray(stageFacts)) {
    return stageFacts as Record<string, unknown>;
  }
  return {};
}

function recentFromIso(nowMs: number, days: number): { from: string; to: string } {
  const safeDays = Math.max(1, Math.min(365, Math.round(Number(days || 30))));
  return {
    from: new Date(nowMs - safeDays * 86400000).toISOString(),
    to: new Date(nowMs).toISOString()
  };
}

export async function buildLeadPriorityIntelligence(
  leadId: string,
  depsOverride?: Partial<PriorityIntelligenceDeps>
): Promise<PriorityIntelligenceDecision> {
  const safeLeadId = String(leadId || "").trim();
  if (!safeLeadId) {
    throw new PriorityIntelligenceError("invalid_lead_id", "Lead ID is required");
  }
  const deps: PriorityIntelligenceDeps = { ...defaultDeps(), ...(depsOverride || {}) };

  const [lead, leadState, aiCards, priority, reactivation, outcome] = await Promise.all([
    deps.getLeadById(safeLeadId).catch((error) => {
      throw new PriorityIntelligenceError("lead_metadata", error instanceof Error ? error.message : "Lead metadata failed", { cause: error });
    }),
    deps.getLeadState(safeLeadId).catch((error) => {
      throw new PriorityIntelligenceError("lead_state", error instanceof Error ? error.message : "Lead state failed", { cause: error });
    }),
    deps.getAiCards(safeLeadId).catch((error) => {
      throw new PriorityIntelligenceError("ai_cards", error instanceof Error ? error.message : "AI cards failed", { cause: error });
    }),
    deps.getPriorityScore(safeLeadId).catch((error) => {
      throw new PriorityIntelligenceError("priority_score", error instanceof Error ? error.message : "Priority score failed", { cause: error });
    }),
    deps.getReactivation(safeLeadId).catch((error) => {
      throw new PriorityIntelligenceError("reactivation", error instanceof Error ? error.message : "Reactivation check failed", { cause: error });
    }),
    deps.getLeadOutcome(safeLeadId).catch((error) => {
      throw new PriorityIntelligenceError("outcome", error instanceof Error ? error.message : "Lead outcome failed", { cause: error });
    })
  ]);

  if (!lead) {
    throw new PriorityIntelligenceError("lead_metadata", "Lead not found");
  }

  const nowMs = deps.nowMs();
  const stageSource = leadState?.stageAnalysis && typeof leadState.stageAnalysis === "object"
    ? (leadState.stageAnalysis as Record<string, unknown>)
    : null;
  const facts = mergeFacts(leadState as unknown as Record<string, unknown> | null);
  const stageSignals = stageSource?.signals;
  const objections = stageSource?.objections;

  const stage = String(aiCards.summary.stage || lead.stage || "NEW");
  const waitingMinutes = Math.max(0, Math.round(Number(priority.waitingSinceMinutes || 0)));
  const silenceMinutes = Math.max(0, Math.round(Number(reactivation.silenceHours || 0) * 60));

  const decision = computePriorityIntelligence({
    leadId: safeLeadId,
    stage,
    awaitingReply: Boolean(priority.needsReply),
    waitingMinutes,
    silenceMinutes,
    reactivationState: {
      shouldReactivate: Boolean(reactivation.shouldReactivate),
      reactivationPriority: reactivation.reactivationPriority,
      stalledStage: reactivation.stalledStage || null
    },
    signals: {
      product_interest_detected: Boolean(lead.hasProductInterest || hasSignalType(stageSignals, "product_interest")),
      price_request_detected: Boolean(
        lead.priceIntent ||
          lead.hasPriceSent ||
          hasSignalType(stageSignals, "price_request") ||
          signalFromFactsList(facts.price_points_detected)
      ),
      payment_intent_detected: Boolean(aiCards.summary.paymentIntent || lead.paymentIntent || hasSignalType(stageSignals, "payment_intent")),
      deposit_intent_detected: Boolean(lead.depositIntent || stageKey(stage) === "DEPOSIT_PENDING"),
      shipping_question_detected: Boolean(
        hasSignalType(stageSignals, "shipping_question") ||
          signalFromString(facts.destination_country) ||
          signalFromString(lead.shipCountry) ||
          signalFromString(lead.shipCity) ||
          hasAnyTag(lead.detectedSignals?.tags, ["shipping_question", "delivery_question", "destination_question"])
      ),
      delivery_timing_detected: Boolean(
        signalFromString(facts.delivery_deadline) ||
          hasSignalType(stageSignals, "deadline_risk") ||
          hasAnyTag(lead.detectedSignals?.tags, ["delivery_timing", "deadline_risk", "urgent_delivery"])
      ),
      customization_request_detected: Boolean(
        hasSignalType(stageSignals, "customization_request") || signalFromFactsList(facts.customization_requests)
      ),
      video_interest_detected: Boolean(hasSignalType(stageSignals, "video_interest") || lead.videoIntent || stageKey(stage).includes("VIDEO")),
      event_date_detected: Boolean(signalFromString(facts.event_date) || signalFromString(lead.eventDate)),
      event_date_near: eventDateNear(String(facts.event_date || lead.eventDate || "") || null, nowMs),
      high_ticket_context: Number(lead.ticketValue || 0) >= 1500,
      repeat_customer_detected: hasAnyTag(lead.detectedSignals?.tags, ["repeat_customer", "returning_customer", "existing_customer"]),
      price_objection_detected: hasObjectionType(objections, "price"),
      timing_objection_detected: hasObjectionType(objections, "timing"),
      trust_friction_detected: hasObjectionType(objections, "trust"),
      fit_uncertainty_detected: hasObjectionType(objections, "fit") || hasObjectionType(objections, "uncertainty"),
      fabric_uncertainty_detected: hasObjectionType(objections, "fabric"),
      external_approval_delay_detected: hasObjectionType(objections, "external_approval"),
      recent_inbound_message: Boolean(priority.needsReply && waitingMinutes <= 120)
    }
  });

  if (outcome?.outcome === "converted" || outcome?.outcome === "lost") {
    return {
      ...decision,
      recommendedAttention: "close_out",
      recommendedSurface: "priority_desk",
      operatorGuidance: guidanceForAttention("close_out")
    };
  }

  return decision;
}

export async function buildPriorityIntelligenceQueue(
  options?: { limit?: number; days?: number },
  depsOverride?: Partial<PriorityIntelligenceDeps>
): Promise<PriorityIntelligenceQueueResponse> {
  const limit = Math.max(1, Math.min(100, Math.round(Number(options?.limit || 20))));
  const days = Math.max(1, Math.min(365, Math.round(Number(options?.days || 30))));
  const deps: PriorityIntelligenceDeps = { ...defaultDeps(), ...(depsOverride || {}) };

  try {
    const nowMs = deps.nowMs();
    recentFromIso(nowMs, days);
    const leads = await deps.listLeads({ limit, days, stage: "ALL" });
    const decisions = await Promise.all(leads.map((lead) => buildLeadPriorityIntelligence(lead.id, deps)));
    const items = decisions
      .slice()
      .sort((a, b) => b.priorityScore - a.priorityScore || b.dropoffRisk - a.dropoffRisk || b.conversionProbability - a.conversionProbability);

    return {
      items,
      meta: {
        count: items.length,
        limit,
        days,
        generatedAt: deps.nowIso()
      }
    };
  } catch (error) {
    throw new PriorityIntelligenceError("queue", error instanceof Error ? error.message : "Queue leads failed", { cause: error });
  }
}

export { mapPriorityBand };
