import { listRecentMessagesByLeadIds, listWhatsAppLeads } from "../db/whatsappLeadsRepo.js";
import { buildAiCardsViewModel, type AiCardsViewModel } from "./whatsappAiCardsService.js";
import {
  buildPriorityDeskQueue,
  PriorityDeskError,
  type PriorityDeskItem
} from "./whatsappPriorityDeskService.js";

export type PriorityDeskViewItem = {
  leadId: string;
  clientName: string | null;
  lastMessagePreview: string | null;
  lastMessageAt: string | null;
  latestMessageDirection: "inbound" | "outbound" | null;
  needsReply: boolean;
  waitingSinceMinutes: number;
  priorityScore: number;
  priorityBand: "low" | "medium" | "high" | "critical";
  estimatedHeat: "cold" | "warm" | "hot";
  stage: string;
  urgency: string;
  paymentIntent: boolean;
  dropoffRisk: string;
  recommendedAction: string;
  commercialPriority: string;
  tone: string | null;
  reasons: string[];
  topReplyCard: {
    label: string;
    intent: string;
    messages: string[];
  } | null;
};

export type PriorityDeskViewResponse = {
  items: PriorityDeskViewItem[];
  meta: {
    count: number;
    limit: number;
    days: number;
    generatedAt: string;
  };
};

export class PriorityDeskViewError extends Error {
  step: "priority_queue" | "lead_metadata" | "message_metadata" | "ai_cards";

  constructor(step: "priority_queue" | "lead_metadata" | "message_metadata" | "ai_cards", message: string, options?: { cause?: unknown }) {
    super(message);
    this.step = step;
    if (options && "cause" in options) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

type PriorityDeskViewDeps = {
  getPriorityQueue: (options: { limit: number; days: number }) => Promise<PriorityDeskItem[]>;
  getLeadsMeta: (options: { limit: number; days: number }) => Promise<Array<{ id: string; clientName: string | null }>>;
  getLatestMessagesByLead: (leadIds: string[]) => Promise<Map<string, { direction: "IN" | "OUT"; text: string; createdAt: string } | null>>;
  getAiCards: (leadId: string) => Promise<AiCardsViewModel>;
};

function defaultDeps(): PriorityDeskViewDeps {
  return {
    getPriorityQueue: (options) => buildPriorityDeskQueue(options),
    getLeadsMeta: async (options) => {
      const leads = await listWhatsAppLeads({ limit: options.limit, days: options.days, stage: "ALL" });
      return leads.map((lead) => ({ id: lead.id, clientName: lead.clientName || null }));
    },
    getLatestMessagesByLead: async (leadIds) => {
      const byLead = await listRecentMessagesByLeadIds(leadIds, 1);
      const out = new Map<string, { direction: "IN" | "OUT"; text: string; createdAt: string } | null>();
      for (const leadId of leadIds) {
        const row = (byLead.get(leadId) || [])[0];
        if (!row) {
          out.set(leadId, null);
          continue;
        }
        out.set(leadId, {
          direction: row.direction,
          text: String(row.text || ""),
          createdAt: row.createdAt
        });
      }
      return out;
    },
    getAiCards: (leadId) => buildAiCardsViewModel(leadId)
  };
}

export async function buildPriorityDeskView(
  options?: { limit?: number; days?: number },
  depsOverride?: Partial<PriorityDeskViewDeps>
): Promise<PriorityDeskViewResponse> {
  const limit = Math.max(1, Math.min(100, Math.round(Number(options?.limit || 20))));
  const days = Math.max(1, Math.min(365, Math.round(Number(options?.days || 30))));
  const deps: PriorityDeskViewDeps = { ...defaultDeps(), ...(depsOverride || {}) };

  let queue: PriorityDeskItem[];
  try {
    queue = await deps.getPriorityQueue({ limit, days });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Priority queue failed";
    if (error instanceof PriorityDeskError) {
      throw new PriorityDeskViewError("priority_queue", message, { cause: error });
    }
    throw new PriorityDeskViewError("priority_queue", message, { cause: error });
  }

  const leadIds = queue.map((item) => item.leadId);

  let leadsMeta: Array<{ id: string; clientName: string | null }>;
  try {
    leadsMeta = await deps.getLeadsMeta({ limit, days });
  } catch (error) {
    throw new PriorityDeskViewError(
      "lead_metadata",
      error instanceof Error ? error.message : "Lead metadata failed",
      { cause: error }
    );
  }
  const leadNameById = new Map(leadsMeta.map((lead) => [lead.id, lead.clientName]));

  let latestMessagesByLead: Map<string, { direction: "IN" | "OUT"; text: string; createdAt: string } | null>;
  try {
    latestMessagesByLead = await deps.getLatestMessagesByLead(leadIds);
  } catch (error) {
    throw new PriorityDeskViewError(
      "message_metadata",
      error instanceof Error ? error.message : "Latest messages failed",
      { cause: error }
    );
  }

  const aiCardsByLead = new Map<string, AiCardsViewModel>();
  for (const leadId of leadIds) {
    try {
      aiCardsByLead.set(leadId, await deps.getAiCards(leadId));
    } catch (error) {
      throw new PriorityDeskViewError("ai_cards", error instanceof Error ? error.message : "AI cards failed", { cause: error });
    }
  }

  const items: PriorityDeskViewItem[] = queue.map((item) => {
    const latest = latestMessagesByLead.get(item.leadId) || null;
    const direction: "inbound" | "outbound" | null = latest
      ? latest.direction === "IN"
        ? "inbound"
        : "outbound"
      : null;
    const preview = latest ? String(latest.text || "").trim() || null : null;
    const aiCards = aiCardsByLead.get(item.leadId);
    const topReplyCard = aiCards?.replyCards && aiCards.replyCards.length > 0
      ? {
          label: String(aiCards.replyCards[0].label || "").trim(),
          intent: String(aiCards.replyCards[0].intent || "").trim(),
          messages: Array.isArray(aiCards.replyCards[0].messages)
            ? aiCards.replyCards[0].messages.map((message) => String(message || "")).filter(Boolean)
            : []
        }
      : null;

    return {
      leadId: item.leadId,
      clientName: leadNameById.get(item.leadId) ?? null,
      lastMessagePreview: preview,
      lastMessageAt: latest?.createdAt || null,
      latestMessageDirection: direction,
      needsReply: item.needsReply,
      waitingSinceMinutes: item.waitingSinceMinutes,
      priorityScore: item.priorityScore,
      priorityBand: item.priorityBand,
      estimatedHeat: item.estimatedHeat,
      stage: item.stage,
      urgency: item.urgency,
      paymentIntent: item.paymentIntent,
      dropoffRisk: item.dropoffRisk,
      recommendedAction: item.recommendedAction,
      commercialPriority: item.commercialPriority,
      tone: aiCards?.strategy?.tone || null,
      reasons: item.reasons,
      topReplyCard
    };
  });

  return {
    items,
    meta: {
      count: items.length,
      limit,
      days,
      generatedAt: new Date().toISOString()
    }
  };
}
