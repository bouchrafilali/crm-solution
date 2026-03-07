import { listRecentMessagesByLeadIds, listWhatsAppLeadMessages, listWhatsAppLeads, type WhatsAppDirection } from "../db/whatsappLeadsRepo.js";
import { buildAiCardsViewModel, type AiCardsViewModel } from "./whatsappAiCardsService.js";

export type ReactivationPriority = "low" | "medium" | "high";
export type ReactivationAction = "reactivate_gently" | "wait" | "close_out";
export type ReactivationTone = "soft_luxury" | "reassuring" | "warm_refined" | "calm_urgent" | null;
export type ReactivationTiming = "now" | "later_today" | "tomorrow" | "monitor";

export type ReactivationDecision = {
  leadId: string;
  shouldReactivate: boolean;
  reactivationPriority: ReactivationPriority;
  reactivationReason: string;
  stalledStage: string | null;
  silenceHours: number;
  signals: string[];
  recommendedAction: ReactivationAction;
  tone: ReactivationTone;
  timing: ReactivationTiming;
};

type ConversationMeta = {
  latestInboundAt: string | null;
  latestOutboundAt: string | null;
  latestDirection: WhatsAppDirection | null;
  silenceHours: number;
  needsReply: boolean;
};

type ReactivationInput = {
  leadId: string;
  stage: string;
  urgency: string;
  paymentIntent: boolean;
  recommendedAction: string;
  eventDate: string | null;
  latestDirection: WhatsAppDirection | null;
  silenceHours: number;
  needsReply: boolean;
};

export class ReactivationEngineError extends Error {
  step: "ai_cards" | "messages_metadata" | "leads_list";

  constructor(step: "ai_cards" | "messages_metadata" | "leads_list", message: string, options?: { cause?: unknown }) {
    super(message);
    this.step = step;
    if (options && "cause" in options) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

function toMs(value: string | null | undefined): number {
  if (!value) return NaN;
  return new Date(value).getTime();
}

function daysUntilEvent(eventDate: string | null, nowMs: number): number | null {
  if (!eventDate) return null;
  const parsed = new Date(`${eventDate}T00:00:00.000Z`).getTime();
  if (!Number.isFinite(parsed)) return null;
  return Math.floor((parsed - nowMs) / 86400000);
}

function extractConversationMeta(messages: Array<{ direction: WhatsAppDirection; createdAt: string }>, nowMs: number): ConversationMeta {
  const sorted = messages.slice().sort((a, b) => toMs(a.createdAt) - toMs(b.createdAt));
  const latest = sorted.length ? sorted[sorted.length - 1] : null;
  const latestInbound = [...sorted].reverse().find((m) => m.direction === "IN") || null;
  const latestOutbound = [...sorted].reverse().find((m) => m.direction === "OUT") || null;

  const latestDirection = latest ? latest.direction : null;
  const needsReply = latestDirection === "IN";

  const anchor = latestDirection === "OUT" ? latestOutbound?.createdAt || null : latestInbound?.createdAt || latest?.createdAt || null;
  const anchorMs = toMs(anchor);
  const silenceHours = Number.isFinite(anchorMs) ? Math.max(0, Math.round(((nowMs - anchorMs) / 3600000) * 10) / 10) : 0;

  return {
    latestInboundAt: latestInbound?.createdAt || null,
    latestOutboundAt: latestOutbound?.createdAt || null,
    latestDirection,
    silenceHours,
    needsReply
  };
}

export function mapReactivationTiming(input: {
  shouldReactivate: boolean;
  priority: ReactivationPriority;
  eventNear: boolean;
}): ReactivationTiming {
  if (!input.shouldReactivate) return "monitor";
  if (input.priority === "high" || input.eventNear) return "now";
  if (input.priority === "medium") return "later_today";
  return "tomorrow";
}

export function assessReactivationDeterministic(input: ReactivationInput, nowMs = Date.now()): ReactivationDecision {
  const stage = String(input.stage || "").trim().toUpperCase();
  const urgency = String(input.urgency || "").trim().toLowerCase();
  const action = String(input.recommendedAction || "").trim().toLowerCase();
  const silenceHours = Math.max(0, Number(input.silenceHours || 0));
  const eventDays = daysUntilEvent(input.eventDate, nowMs);
  const eventNear = eventDays != null && eventDays >= 0 && eventDays <= 10;

  const signals: string[] = [];
  let shouldReactivate = false;
  let priority: ReactivationPriority = "low";
  let recommended: ReactivationAction = "wait";
  let reason = "Lead remains active or not yet stale.";

  if (input.needsReply) {
    return {
      leadId: input.leadId,
      shouldReactivate: false,
      reactivationPriority: "low",
      reactivationReason: "Latest inbound message requires normal reply, not reactivation.",
      stalledStage: null,
      silenceHours,
      signals: ["needs_reply_now"],
      recommendedAction: "wait",
      tone: null,
      timing: "monitor"
    };
  }

  const stalledThresholdByStage: Record<string, number> = {
    PRICE_SENT: 48,
    VIDEO_PROPOSED: 48,
    DEPOSIT_PENDING: 24,
    QUALIFIED: 72,
    STALLED: 24
  };
  const threshold = stalledThresholdByStage[stage] ?? Infinity;

  if (stage === "CONVERTED" || stage === "LOST") {
    shouldReactivate = false;
    priority = "low";
    recommended = "close_out";
    reason = "Lead stage is closed.";
    signals.push("closed_stage");
  } else if (Number.isFinite(threshold) && silenceHours >= threshold && input.latestDirection === "OUT") {
    shouldReactivate = true;
    signals.push("stalled_after_outbound");

    if (stage === "DEPOSIT_PENDING") {
      priority = "high";
      reason = "Deposit-pending lead is stalled after outbound follow-up.";
      signals.push("deposit_pending_stall");
    } else if (stage === "PRICE_SENT") {
      priority = "medium";
      reason = "Price-sent lead has no client reply after outbound message.";
      signals.push("price_sent_stall");
    } else if (stage === "VIDEO_PROPOSED") {
      priority = "medium";
      reason = "Video-proposed lead has no reply and may lose momentum.";
      signals.push("video_proposed_stall");
    } else if (stage === "QUALIFIED") {
      priority = "medium";
      reason = "Qualified lead with no progress after outbound follow-up.";
      signals.push("qualified_stall");
    } else {
      priority = "low";
      reason = "Lead appears stalled and requires gentle reactivation.";
      signals.push("general_stall");
    }

    recommended = "reactivate_gently";
  }

  if (shouldReactivate && (eventNear || urgency === "high")) {
    priority = "high";
    signals.push(eventNear ? "event_date_near" : "high_urgency");
    reason = eventNear
      ? "Event date is approaching and conversation is stalled."
      : "Urgency is high and conversation is stalled.";
  }

  if (shouldReactivate && Boolean(input.paymentIntent)) {
    signals.push("payment_intent_detected");
    if (priority === "low") priority = "medium";
  }

  if (shouldReactivate && action === "close_out") {
    recommended = "close_out";
    priority = "low";
    reason = "Strategic action suggests closing out the conversation.";
    signals.push("strategy_close_out");
  }

  const tone: ReactivationTone = shouldReactivate
    ? eventNear || urgency === "high"
      ? "calm_urgent"
      : stage === "PRICE_SENT" || stage === "DEPOSIT_PENDING"
        ? "reassuring"
        : "warm_refined"
    : null;

  const timing = mapReactivationTiming({ shouldReactivate, priority, eventNear: Boolean(eventNear) });

  return {
    leadId: input.leadId,
    shouldReactivate,
    reactivationPriority: priority,
    reactivationReason: reason,
    stalledStage: shouldReactivate ? stage : null,
    silenceHours,
    signals,
    recommendedAction: shouldReactivate ? recommended : "wait",
    tone,
    timing
  };
}

type SingleDeps = {
  getAiCards: (leadId: string) => Promise<AiCardsViewModel>;
  getMessages: (leadId: string) => Promise<Array<{ direction: WhatsAppDirection; createdAt: string }>>;
  nowMs: () => number;
};

function defaultSingleDeps(): SingleDeps {
  return {
    getAiCards: (leadId: string) => buildAiCardsViewModel(leadId),
    getMessages: async (leadId: string) => {
      const messages = await listWhatsAppLeadMessages(leadId, { limit: 60, order: "asc" });
      return messages.map((m) => ({ direction: m.direction, createdAt: m.createdAt }));
    },
    nowMs: () => Date.now()
  };
}

export async function buildLeadReactivationCheck(
  leadId: string,
  depsOverride?: Partial<SingleDeps>
): Promise<ReactivationDecision> {
  const safeLeadId = String(leadId || "").trim();
  if (!safeLeadId) {
    throw new ReactivationEngineError("messages_metadata", "Lead ID is required");
  }

  const deps: SingleDeps = { ...defaultSingleDeps(), ...(depsOverride || {}) };

  let aiCards: AiCardsViewModel;
  try {
    aiCards = await deps.getAiCards(safeLeadId);
  } catch (error) {
    throw new ReactivationEngineError("ai_cards", error instanceof Error ? error.message : "AI cards failed", { cause: error });
  }

  let messages: Array<{ direction: WhatsAppDirection; createdAt: string }>;
  try {
    messages = await deps.getMessages(safeLeadId);
  } catch (error) {
    throw new ReactivationEngineError("messages_metadata", error instanceof Error ? error.message : "Messages metadata failed", { cause: error });
  }

  const timing = extractConversationMeta(messages, deps.nowMs());
  return assessReactivationDeterministic({
    leadId: safeLeadId,
    stage: aiCards.summary.stage,
    urgency: aiCards.summary.urgency,
    paymentIntent: aiCards.summary.paymentIntent,
    recommendedAction: aiCards.strategy.recommendedAction,
    eventDate: aiCards.facts.eventDate,
    latestDirection: timing.latestDirection,
    silenceHours: timing.silenceHours,
    needsReply: timing.needsReply
  }, deps.nowMs());
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
      const byLead = await listRecentMessagesByLeadIds(leadIds, 60);
      const out = new Map<string, Array<{ direction: WhatsAppDirection; createdAt: string }>>();
      for (const leadId of leadIds) {
        const rows = byLead.get(leadId) || [];
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

export async function buildReactivationQueue(
  options?: { limit?: number; days?: number },
  depsOverride?: Partial<QueueDeps>
): Promise<ReactivationDecision[]> {
  const limit = Math.max(1, Math.min(100, Math.round(Number(options?.limit || 20))));
  const days = Math.max(1, Math.min(365, Math.round(Number(options?.days || 30))));
  const deps: QueueDeps = { ...defaultQueueDeps(), ...(depsOverride || {}) };
  const nowMs = deps.nowMs();

  let leadIds: string[];
  try {
    leadIds = await deps.listLeadIds({ limit, days });
  } catch (error) {
    throw new ReactivationEngineError("leads_list", error instanceof Error ? error.message : "Leads list failed", { cause: error });
  }

  let byMessages: Map<string, Array<{ direction: WhatsAppDirection; createdAt: string }>>;
  try {
    byMessages = await deps.getMessagesByLeadIds(leadIds);
  } catch (error) {
    throw new ReactivationEngineError("messages_metadata", error instanceof Error ? error.message : "Messages metadata failed", { cause: error });
  }

  const decisions: ReactivationDecision[] = [];
  for (const leadId of leadIds) {
    let aiCards: AiCardsViewModel;
    try {
      aiCards = await deps.getAiCards(leadId);
    } catch (error) {
      throw new ReactivationEngineError("ai_cards", error instanceof Error ? error.message : "AI cards failed", { cause: error });
    }

    const meta = extractConversationMeta(byMessages.get(leadId) || [], nowMs);
    decisions.push(
      assessReactivationDeterministic(
        {
          leadId,
          stage: aiCards.summary.stage,
          urgency: aiCards.summary.urgency,
          paymentIntent: aiCards.summary.paymentIntent,
          recommendedAction: aiCards.strategy.recommendedAction,
          eventDate: aiCards.facts.eventDate,
          latestDirection: meta.latestDirection,
          silenceHours: meta.silenceHours,
          needsReply: meta.needsReply
        },
        nowMs
      )
    );
  }

  return decisions
    .filter((item) => item.shouldReactivate)
    .sort((a, b) => {
      const priorityOrder: Record<ReactivationPriority, number> = { high: 3, medium: 2, low: 1 };
      return priorityOrder[b.reactivationPriority] - priorityOrder[a.reactivationPriority] || b.silenceHours - a.silenceHours;
    });
}
