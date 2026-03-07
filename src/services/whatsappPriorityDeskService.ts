import { listRecentMessagesByLeadIds, listWhatsAppLeadMessages, listWhatsAppLeads, type WhatsAppDirection } from "../db/whatsappLeadsRepo.js";
import { buildAiCardsViewModel, type AiCardsViewModel } from "./whatsappAiCardsService.js";

export type PriorityBand = "low" | "medium" | "high" | "critical";
export type EstimatedHeat = "cold" | "warm" | "hot";

export type PriorityDeskItem = {
  leadId: string;
  priorityScore: number;
  priorityBand: PriorityBand;
  needsReply: boolean;
  waitingSinceMinutes: number;
  stage: string;
  urgency: string;
  paymentIntent: boolean;
  dropoffRisk: string;
  recommendedAction: string;
  commercialPriority: string;
  estimatedHeat: EstimatedHeat;
  reasons: string[];
};

type ConversationTimingMeta = {
  latestInboundAt: string | null;
  latestOutboundAt: string | null;
  latestDirection: WhatsAppDirection | null;
  waitingSinceMinutes: number;
  needsReply: boolean;
};

type ScoringInput = {
  stage: string;
  urgency: string;
  paymentIntent: boolean;
  dropoffRisk: string;
  recommendedAction: string;
  commercialPriority: string;
  needsReply: boolean;
  waitingSinceMinutes: number;
};

export class PriorityDeskError extends Error {
  step: "ai_cards" | "messages_metadata" | "leads_list";

  constructor(step: "ai_cards" | "messages_metadata" | "leads_list", message: string, options?: { cause?: unknown }) {
    super(message);
    this.step = step;
    if (options && "cause" in options) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function mapPriorityBand(score: number): PriorityBand {
  if (score >= 80) return "critical";
  if (score >= 60) return "high";
  if (score >= 35) return "medium";
  return "low";
}

function mapEstimatedHeat(score: number): EstimatedHeat {
  if (score >= 70) return "hot";
  if (score >= 40) return "warm";
  return "cold";
}

export function computePriorityScoreDeterministic(input: ScoringInput): {
  priorityScore: number;
  priorityBand: PriorityBand;
  estimatedHeat: EstimatedHeat;
  reasons: string[];
} {
  let score = 0;
  const reasons: string[] = [];

  if (input.needsReply) {
    score += 25;
    reasons.push("Latest message is inbound and awaiting reply");
  } else {
    score -= 8;
  }

  const waiting = Math.max(0, Math.round(Number(input.waitingSinceMinutes || 0)));
  if (waiting >= 15) {
    score += 5;
    reasons.push("Waiting time above 15 minutes");
  }
  if (waiting >= 60) {
    score += 8;
    reasons.push("Waiting time above 60 minutes");
  }
  if (waiting >= 180) {
    score += 12;
    reasons.push("Waiting time above 3 hours");
  }
  if (waiting >= 720) {
    score += 18;
    reasons.push("Waiting time above 12 hours");
  }

  const stageKey = String(input.stage || "").trim().toUpperCase();
  const stagePoints: Record<string, number> = {
    NEW: 4,
    PRODUCT_INTEREST: 10,
    QUALIFICATION_PENDING: 16,
    QUALIFIED: 20,
    PRICE_SENT: 26,
    VIDEO_PROPOSED: 22,
    VIDEO_DONE: 24,
    DEPOSIT_PENDING: 34,
    CONFIRMED: 30,
    STALLED: 22,
    CONVERTED: -30,
    LOST: -45
  };
  const stageScore = stagePoints[stageKey] ?? 0;
  score += stageScore;
  if (stageScore !== 0) reasons.push(`Stage weight: ${stageKey}`);

  const urgencyKey = String(input.urgency || "").trim().toLowerCase();
  if (urgencyKey === "high") {
    score += 18;
    reasons.push("High urgency");
  } else if (urgencyKey === "medium") {
    score += 9;
    reasons.push("Medium urgency");
  }

  if (Boolean(input.paymentIntent)) {
    score += 14;
    reasons.push("Payment intent detected");
  }

  const dropoffKey = String(input.dropoffRisk || "").trim().toLowerCase();
  if (dropoffKey === "high") {
    score += 10;
    reasons.push("High drop-off risk");
  } else if (dropoffKey === "medium") {
    score += 5;
    reasons.push("Medium drop-off risk");
  }

  const commercialPriorityKey = String(input.commercialPriority || "").trim().toLowerCase();
  if (commercialPriorityKey === "critical") {
    score += 16;
    reasons.push("Critical commercial priority");
  } else if (commercialPriorityKey === "high") {
    score += 10;
    reasons.push("High commercial priority");
  } else if (commercialPriorityKey === "medium") {
    score += 5;
  }

  const actionKey = String(input.recommendedAction || "").trim().toLowerCase();
  if (actionKey === "reduce_friction_to_payment" || actionKey === "push_softly_to_deposit") {
    score += 10;
    reasons.push("Action targets conversion close");
  } else if (actionKey === "clarify_deadline" || actionKey === "clarify_timing") {
    score += 6;
  } else if (actionKey === "reactivate_gently") {
    score += 5;
  } else if (actionKey === "wait") {
    score -= 6;
  } else if (actionKey === "close_out") {
    score -= 20;
  }

  const finalScore = clampScore(score);
  return {
    priorityScore: finalScore,
    priorityBand: mapPriorityBand(finalScore),
    estimatedHeat: mapEstimatedHeat(finalScore),
    reasons
  };
}

function toTimeMs(value: string | null | undefined): number {
  if (!value) return NaN;
  return new Date(value).getTime();
}

function extractConversationTiming(messages: Array<{ direction: WhatsAppDirection; createdAt: string }>, nowMs: number): ConversationTimingMeta {
  const sorted = messages
    .slice()
    .sort((a, b) => toTimeMs(a.createdAt) - toTimeMs(b.createdAt));

  const latest = sorted.length ? sorted[sorted.length - 1] : null;
  const latestInbound = [...sorted].reverse().find((m) => m.direction === "IN") || null;
  const latestOutbound = [...sorted].reverse().find((m) => m.direction === "OUT") || null;

  const latestDirection = latest ? latest.direction : null;
  const needsReply = latestDirection === "IN";
  const waitingAnchorMs = needsReply ? toTimeMs(latest?.createdAt) : NaN;
  const waitingSinceMinutes = Number.isFinite(waitingAnchorMs) ? Math.max(0, Math.round((nowMs - waitingAnchorMs) / 60000)) : 0;

  return {
    latestInboundAt: latestInbound?.createdAt || null,
    latestOutboundAt: latestOutbound?.createdAt || null,
    latestDirection,
    waitingSinceMinutes,
    needsReply
  };
}

function buildPriorityDeskItem(leadId: string, aiCards: AiCardsViewModel, timing: ConversationTimingMeta): PriorityDeskItem {
  const scored = computePriorityScoreDeterministic({
    stage: aiCards.summary.stage,
    urgency: aiCards.summary.urgency,
    paymentIntent: aiCards.summary.paymentIntent,
    dropoffRisk: aiCards.summary.dropoffRisk,
    recommendedAction: aiCards.strategy.recommendedAction,
    commercialPriority: aiCards.strategy.commercialPriority,
    needsReply: timing.needsReply,
    waitingSinceMinutes: timing.waitingSinceMinutes
  });

  return {
    leadId,
    priorityScore: scored.priorityScore,
    priorityBand: scored.priorityBand,
    needsReply: timing.needsReply,
    waitingSinceMinutes: timing.waitingSinceMinutes,
    stage: aiCards.summary.stage,
    urgency: aiCards.summary.urgency,
    paymentIntent: aiCards.summary.paymentIntent,
    dropoffRisk: aiCards.summary.dropoffRisk,
    recommendedAction: aiCards.strategy.recommendedAction,
    commercialPriority: aiCards.strategy.commercialPriority,
    estimatedHeat: scored.estimatedHeat,
    reasons: scored.reasons
  };
}

type SingleDeps = {
  getAiCards: (leadId: string) => Promise<AiCardsViewModel>;
  getMessagesForLead: (leadId: string) => Promise<Array<{ direction: WhatsAppDirection; createdAt: string }>>;
  nowMs: () => number;
};

function defaultSingleDeps(): SingleDeps {
  return {
    getAiCards: (leadId: string) => buildAiCardsViewModel(leadId),
    getMessagesForLead: async (leadId: string) => {
      const messages = await listWhatsAppLeadMessages(leadId, { limit: 50, order: "asc" });
      return messages.map((m) => ({ direction: m.direction, createdAt: m.createdAt }));
    },
    nowMs: () => Date.now()
  };
}

export async function buildLeadPriorityScore(
  leadId: string,
  depsOverride?: Partial<SingleDeps>
): Promise<PriorityDeskItem> {
  const safeLeadId = String(leadId || "").trim();
  if (!safeLeadId) {
    throw new PriorityDeskError("messages_metadata", "Lead ID is required");
  }

  const deps: SingleDeps = { ...defaultSingleDeps(), ...(depsOverride || {}) };

  let aiCards: AiCardsViewModel;
  try {
    aiCards = await deps.getAiCards(safeLeadId);
  } catch (error) {
    throw new PriorityDeskError("ai_cards", error instanceof Error ? error.message : "AI cards failed", { cause: error });
  }

  let messages: Array<{ direction: WhatsAppDirection; createdAt: string }>;
  try {
    messages = await deps.getMessagesForLead(safeLeadId);
  } catch (error) {
    throw new PriorityDeskError("messages_metadata", error instanceof Error ? error.message : "Messages metadata failed", { cause: error });
  }

  const timing = extractConversationTiming(messages, deps.nowMs());
  return buildPriorityDeskItem(safeLeadId, aiCards, timing);
}

type QueueDeps = {
  listLeadIds: (input: { limit: number; days: number }) => Promise<string[]>;
  getAiCards: (leadId: string) => Promise<AiCardsViewModel>;
  getMessagesByLeadIds: (leadIds: string[]) => Promise<Map<string, Array<{ direction: WhatsAppDirection; createdAt: string }>>>;
  nowMs: () => number;
};

function defaultQueueDeps(): QueueDeps {
  return {
    listLeadIds: async (input) => {
      const leads = await listWhatsAppLeads({ limit: input.limit, days: input.days, stage: "ALL" });
      return leads.map((lead) => lead.id);
    },
    getAiCards: (leadId: string) => buildAiCardsViewModel(leadId),
    getMessagesByLeadIds: async (leadIds: string[]) => {
      const mapped = await listRecentMessagesByLeadIds(leadIds, 50);
      const out = new Map<string, Array<{ direction: WhatsAppDirection; createdAt: string }>>();
      for (const leadId of leadIds) {
        const rows = mapped.get(leadId) || [];
        out.set(
          leadId,
          rows.map((row) => ({ direction: row.direction, createdAt: row.createdAt }))
        );
      }
      return out;
    },
    nowMs: () => Date.now()
  };
}

export async function buildPriorityDeskQueue(
  options?: { limit?: number; days?: number },
  depsOverride?: Partial<QueueDeps>
): Promise<PriorityDeskItem[]> {
  const limit = Math.max(1, Math.min(100, Math.round(Number(options?.limit || 20))));
  const days = Math.max(1, Math.min(365, Math.round(Number(options?.days || 30))));

  const deps: QueueDeps = { ...defaultQueueDeps(), ...(depsOverride || {}) };
  const nowMs = deps.nowMs();

  let leadIds: string[];
  try {
    leadIds = await deps.listLeadIds({ limit, days });
  } catch (error) {
    throw new PriorityDeskError("leads_list", error instanceof Error ? error.message : "Leads list failed", { cause: error });
  }

  let messagesByLead: Map<string, Array<{ direction: WhatsAppDirection; createdAt: string }>>;
  try {
    messagesByLead = await deps.getMessagesByLeadIds(leadIds);
  } catch (error) {
    throw new PriorityDeskError("messages_metadata", error instanceof Error ? error.message : "Messages metadata failed", { cause: error });
  }

  const items: PriorityDeskItem[] = [];
  for (const leadId of leadIds) {
    let aiCards: AiCardsViewModel;
    try {
      aiCards = await deps.getAiCards(leadId);
    } catch (error) {
      throw new PriorityDeskError("ai_cards", error instanceof Error ? error.message : "AI cards failed", { cause: error });
    }

    const timing = extractConversationTiming(messagesByLead.get(leadId) || [], nowMs);
    items.push(buildPriorityDeskItem(leadId, aiCards, timing));
  }

  return items.sort((a, b) => b.priorityScore - a.priorityScore || b.waitingSinceMinutes - a.waitingSinceMinutes);
}
