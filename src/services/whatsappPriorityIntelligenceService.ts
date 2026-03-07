import { listWhatsAppLeadMessages, listWhatsAppLeads, getWhatsAppLeadById } from "../db/whatsappLeadsRepo.js";
import { listWhatsAppOperatorEventsByRange } from "../db/whatsappOperatorEventsRepo.js";
import { getWhatsAppLeadOutcome } from "../db/whatsappLeadOutcomesRepo.js";
import { buildAiCardsViewModel, type AiCardsViewModel } from "./whatsappAiCardsService.js";
import { buildLeadPriorityScore, mapPriorityBand, type PriorityBand, type PriorityDeskItem } from "./whatsappPriorityDeskService.js";
import { buildLeadReactivationCheck, type ReactivationDecision } from "./whatsappReactivationEngineService.js";

export type PriorityAttentionAction = "reply_now" | "reactivate_now" | "wait" | "monitor" | "close_out";
export type PrioritySurface = "mobile_lab" | "priority_desk" | "reactivation_queue";

export type PriorityIntelligenceDecision = {
  leadId: string;
  priorityScore: number;
  priorityBand: PriorityBand;
  conversionProbability: number;
  dropoffRisk: number;
  recommendedAttention: PriorityAttentionAction;
  recommendedSurface: PrioritySurface;
  reasonCodes: string[];
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

export class PriorityIntelligenceError extends Error {
  step:
    | "invalid_lead_id"
    | "lead_metadata"
    | "ai_cards"
    | "priority_score"
    | "reactivation"
    | "messages"
    | "outcome"
    | "operator_events"
    | "queue";

  constructor(
    step:
      | "invalid_lead_id"
      | "lead_metadata"
      | "ai_cards"
      | "priority_score"
      | "reactivation"
      | "messages"
      | "outcome"
      | "operator_events"
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
  getAiCards: (leadId: string) => Promise<AiCardsViewModel>;
  getPriorityScore: (leadId: string) => Promise<PriorityDeskItem>;
  getReactivation: (leadId: string) => Promise<ReactivationDecision>;
  getLeadOutcome: typeof getWhatsAppLeadOutcome;
  getLeadMessages: (leadId: string) => Promise<Array<{ direction: "IN" | "OUT"; createdAt: string }>>;
  listOperatorEventsByRange: typeof listWhatsAppOperatorEventsByRange;
  listLeads: typeof listWhatsAppLeads;
  nowIso: () => string;
  nowMs: () => number;
};

function defaultDeps(): PriorityIntelligenceDeps {
  return {
    getLeadById: (leadId) => getWhatsAppLeadById(leadId),
    getAiCards: (leadId) => buildAiCardsViewModel(leadId),
    getPriorityScore: (leadId) => buildLeadPriorityScore(leadId),
    getReactivation: (leadId) => buildLeadReactivationCheck(leadId),
    getLeadOutcome: (leadId) => getWhatsAppLeadOutcome(leadId),
    getLeadMessages: async (leadId) => {
      const rows = await listWhatsAppLeadMessages(leadId, { limit: 80, order: "asc" });
      return rows.map((row) => ({ direction: row.direction, createdAt: row.createdAt }));
    },
    listOperatorEventsByRange: (input) => listWhatsAppOperatorEventsByRange(input),
    listLeads: (input) => listWhatsAppLeads(input),
    nowIso: () => new Date().toISOString(),
    nowMs: () => Date.now()
  };
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function riskPointsFromLabel(value: string): number {
  const key = String(value || "").trim().toLowerCase();
  if (key === "high") return 80;
  if (key === "medium") return 55;
  if (key === "low") return 25;
  return 40;
}

function stagePoints(stage: string): number {
  const key = String(stage || "").trim().toUpperCase();
  if (key === "DEPOSIT_PENDING") return 24;
  if (key === "PRICE_SENT") return 18;
  if (key === "QUALIFIED") return 14;
  if (key === "VIDEO_PROPOSED") return 16;
  if (key === "CONFIRMED") return 20;
  if (key === "CONVERTED") return -20;
  if (key === "LOST") return -35;
  return 8;
}

function urgencyPoints(urgency: string): number {
  const key = String(urgency || "").trim().toLowerCase();
  if (key === "high") return 15;
  if (key === "medium") return 8;
  return 2;
}

function paymentPoints(paymentIntent: boolean): number {
  return paymentIntent ? 18 : 0;
}

function waitingPoints(waitingSinceMinutes: number): number {
  const waiting = Math.max(0, Math.round(Number(waitingSinceMinutes || 0)));
  if (waiting >= 240) return 18;
  if (waiting >= 60) return 12;
  if (waiting >= 15) return 6;
  return 0;
}

function silencePoints(silenceHours: number): number {
  const silence = Math.max(0, Number(silenceHours || 0));
  if (silence >= 96) return 22;
  if (silence >= 48) return 14;
  if (silence >= 24) return 8;
  return 0;
}

function reactivationPoints(priority: "low" | "medium" | "high"): number {
  if (priority === "high") return 16;
  if (priority === "medium") return 8;
  return 2;
}

function guidanceForAttention(action: PriorityAttentionAction): string {
  if (action === "reply_now") return "Respond now with a concise next-step message and clear CTA.";
  if (action === "reactivate_now") return "Lead is stalled. Send a gentle reactivation follow-up now.";
  if (action === "monitor") return "Monitor closely. Risk is rising but immediate outreach is not yet required.";
  if (action === "close_out") return "Lead appears closed. Close out and remove from active attention queues.";
  return "No immediate action required. Keep this lead under light observation.";
}

function pickSurface(attention: PriorityAttentionAction, needsReply: boolean): PrioritySurface {
  if (attention === "reactivate_now") return "reactivation_queue";
  if (attention === "reply_now") return needsReply ? "mobile_lab" : "priority_desk";
  return "priority_desk";
}

function recentFromIso(nowMs: number, days: number): { from: string; to: string } {
  const safeDays = Math.max(1, Math.min(365, Math.round(Number(days || 30))));
  return {
    from: new Date(nowMs - safeDays * 86400000).toISOString(),
    to: new Date(nowMs).toISOString()
  };
}

function countLeadOperatorSignals(input: {
  events: Array<{ leadId: string; actionType: string }>;
  leadId: string;
}): { sent: number; dismissed: number; skipped: number } {
  let sent = 0;
  let dismissed = 0;
  let skipped = 0;
  for (const event of input.events) {
    if (String(event.leadId) !== String(input.leadId)) continue;
    const action = String(event.actionType || "").trim().toLowerCase();
    if (action === "reply_card_sent" || action === "reactivation_card_sent") sent += 1;
    if (action === "reply_card_dismissed" || action === "reactivation_card_dismissed") dismissed += 1;
    if (action === "feed_item_skipped") skipped += 1;
  }
  return { sent, dismissed, skipped };
}

function computeDecision(input: {
  leadId: string;
  stage: string;
  urgency: string;
  paymentIntent: boolean;
  dropoffRiskLabel: string;
  priority: PriorityDeskItem;
  reactivation: ReactivationDecision;
  conversionScore: number | null;
  outcome: "open" | "converted" | "lost" | "stalled" | null;
  operatorSignals: { sent: number; dismissed: number; skipped: number };
}): PriorityIntelligenceDecision {
  const reasonCodes: string[] = [];
  const needsReply = Boolean(input.priority.needsReply);
  const waitingSinceMinutes = Math.max(0, Math.round(Number(input.priority.waitingSinceMinutes || 0)));
  const silenceHours = Math.max(0, Number(input.reactivation.silenceHours || 0));

  if (input.paymentIntent) reasonCodes.push("PAYMENT_INTENT");
  if (needsReply) reasonCodes.push("NEEDS_REPLY");
  if (waitingSinceMinutes >= 60) reasonCodes.push("WAITING_OVER_60_MIN");
  if (silenceHours >= 48) reasonCodes.push("SILENCE_OVER_48H");
  if (input.reactivation.shouldReactivate) reasonCodes.push("REACTIVATION_SIGNAL");
  if (input.reactivation.reactivationPriority === "high") reasonCodes.push("HIGH_REACTIVATION_PRIORITY");
  if (String(input.urgency || "").toLowerCase() === "high") reasonCodes.push("HIGH_URGENCY");
  if (String(input.dropoffRiskLabel || "").toLowerCase() === "high") reasonCodes.push("HIGH_DROPOFF_LABEL");
  if (input.operatorSignals.dismissed >= 2) reasonCodes.push("OPERATOR_DISMISSALS");
  if (input.operatorSignals.sent >= 3) reasonCodes.push("MULTIPLE_OUTREACH_ATTEMPTS");
  if (input.operatorSignals.skipped >= 2) reasonCodes.push("REPEATED_SKIPS");
  if (input.outcome === "converted") reasonCodes.push("OUTCOME_CONVERTED");
  if (input.outcome === "lost") reasonCodes.push("OUTCOME_LOST");
  if (input.outcome === "stalled") reasonCodes.push("OUTCOME_STALLED");

  let conversion = Number(input.conversionScore ?? input.priority.priorityScore ?? 0);
  conversion += stagePoints(input.stage);
  conversion += urgencyPoints(input.urgency);
  conversion += paymentPoints(input.paymentIntent);
  conversion -= Math.round(riskPointsFromLabel(input.dropoffRiskLabel) * 0.2);
  conversion -= silencePoints(silenceHours);
  if (input.reactivation.shouldReactivate) conversion -= reactivationPoints(input.reactivation.reactivationPriority);
  conversion -= input.operatorSignals.dismissed * 5;
  conversion -= input.operatorSignals.skipped * 4;
  if (input.outcome === "converted") conversion = 100;
  if (input.outcome === "lost") conversion = 0;
  if (input.outcome === "stalled") conversion = Math.max(0, conversion - 20);
  const conversionProbability = clampPercent(conversion);

  let dropoff = riskPointsFromLabel(input.dropoffRiskLabel);
  dropoff += silencePoints(silenceHours);
  dropoff += input.operatorSignals.dismissed * 7;
  dropoff += input.operatorSignals.skipped * 5;
  if (input.reactivation.shouldReactivate) dropoff += reactivationPoints(input.reactivation.reactivationPriority);
  if (input.paymentIntent) dropoff -= 8;
  if (input.outcome === "converted" || input.outcome === "lost") dropoff = 0;
  if (input.outcome === "stalled") dropoff += 12;
  const dropoffRisk = clampPercent(dropoff);

  let priority = Number(input.priority.priorityScore || 0);
  priority += paymentPoints(input.paymentIntent);
  priority += waitingPoints(waitingSinceMinutes);
  priority += silencePoints(silenceHours);
  if (input.reactivation.shouldReactivate) priority += reactivationPoints(input.reactivation.reactivationPriority);
  if (input.operatorSignals.dismissed >= 2) priority += 6;
  if (input.outcome === "converted" || input.outcome === "lost") priority = 0;
  const priorityScore = clampPercent(priority);
  const priorityBand = mapPriorityBand(priorityScore);

  let recommendedAttention: PriorityAttentionAction = "wait";
  if (input.outcome === "converted" || input.outcome === "lost") {
    recommendedAttention = "close_out";
  } else if (needsReply && (input.paymentIntent || waitingSinceMinutes >= 15 || priorityScore >= 60)) {
    recommendedAttention = "reply_now";
  } else if (input.reactivation.shouldReactivate && (input.reactivation.reactivationPriority === "high" || silenceHours >= 48)) {
    recommendedAttention = "reactivate_now";
  } else if (priorityBand === "critical" || dropoffRisk >= 70) {
    recommendedAttention = "monitor";
  } else {
    recommendedAttention = "wait";
  }

  const recommendedSurface = pickSurface(recommendedAttention, needsReply);
  const operatorGuidance = guidanceForAttention(recommendedAttention);

  return {
    leadId: input.leadId,
    priorityScore,
    priorityBand,
    conversionProbability,
    dropoffRisk,
    recommendedAttention,
    recommendedSurface,
    reasonCodes,
    operatorGuidance
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

  const nowMs = deps.nowMs();
  const operatorRange = recentFromIso(nowMs, 30);

  const [lead, aiCards, priority, reactivation, outcome, events] = await Promise.all([
    deps.getLeadById(safeLeadId).catch((error) => {
      throw new PriorityIntelligenceError("lead_metadata", error instanceof Error ? error.message : "Lead metadata failed", { cause: error });
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
    }),
    deps.listOperatorEventsByRange(operatorRange).catch((error) => {
      throw new PriorityIntelligenceError("operator_events", error instanceof Error ? error.message : "Operator events failed", { cause: error });
    })
  ]);

  if (!lead) {
    throw new PriorityIntelligenceError("lead_metadata", "Lead not found");
  }

  const operatorSignals = countLeadOperatorSignals({
    events: events.map((evt) => ({ leadId: evt.leadId, actionType: evt.actionType })),
    leadId: safeLeadId
  });

  return computeDecision({
    leadId: safeLeadId,
    stage: aiCards.summary.stage || lead.stage,
    urgency: aiCards.summary.urgency || "low",
    paymentIntent: Boolean(aiCards.summary.paymentIntent || lead.paymentIntent),
    dropoffRiskLabel: aiCards.summary.dropoffRisk || "medium",
    priority,
    reactivation,
    conversionScore: lead.conversionScore,
    outcome: outcome?.outcome || null,
    operatorSignals
  });
}

export async function buildPriorityIntelligenceQueue(
  options?: { limit?: number; days?: number },
  depsOverride?: Partial<PriorityIntelligenceDeps>
): Promise<PriorityIntelligenceQueueResponse> {
  const limit = Math.max(1, Math.min(100, Math.round(Number(options?.limit || 20))));
  const days = Math.max(1, Math.min(365, Math.round(Number(options?.days || 30))));
  const deps: PriorityIntelligenceDeps = { ...defaultDeps(), ...(depsOverride || {}) };

  let leads: Awaited<ReturnType<PriorityIntelligenceDeps["listLeads"]>>;
  try {
    leads = await deps.listLeads({ limit, days, stage: "ALL" });
  } catch (error) {
    throw new PriorityIntelligenceError("queue", error instanceof Error ? error.message : "Queue leads failed", { cause: error });
  }

  const decisions = await Promise.all(
    leads.map((lead) => buildLeadPriorityIntelligence(lead.id, deps))
  );

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
}
