import { listRecentMessagesByLeadIds, listWhatsAppLeads } from "../db/whatsappLeadsRepo.js";
import {
  buildReactivationQueue,
  ReactivationEngineError,
  type ReactivationDecision
} from "./whatsappReactivationEngineService.js";
import {
  buildLeadReactivationReplies,
  ReactivationReplyError,
  type ReactivationReplyResult
} from "./whatsappReactivationReplyService.js";

type LatestMessage = {
  direction: "IN" | "OUT";
  text: string;
  createdAt: string;
};

export type ReactivationQueueViewItem = {
  leadId: string;
  clientName: string | null;
  lastMessagePreview: string | null;
  lastMessageAt: string | null;
  latestMessageDirection: "inbound" | "outbound" | null;
  silenceHours: number;
  stalledStage: string | null;
  shouldReactivate: boolean;
  reactivationPriority: "low" | "medium" | "high";
  reactivationReason: string;
  recommendedAction: "reactivate_gently" | "wait" | "close_out";
  tone: "soft_luxury" | "reassuring" | "warm_refined" | "calm_urgent" | null;
  timing: "now" | "later_today" | "tomorrow" | "monitor";
  signals: string[];
  topReplyCard: {
    label: string;
    intent: string;
    messages: string[];
  } | null;
};

export type ReactivationQueueViewResponse = {
  items: ReactivationQueueViewItem[];
  meta: {
    count: number;
    limit: number;
    days: number;
    generatedAt: string;
  };
};

export class ReactivationQueueViewError extends Error {
  step: "reactivation_queue" | "lead_metadata" | "message_metadata" | "reactivation_replies";

  constructor(
    step: "reactivation_queue" | "lead_metadata" | "message_metadata" | "reactivation_replies",
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

type ReactivationQueueViewDeps = {
  getReactivationQueue: (options: { limit: number; days: number }) => Promise<ReactivationDecision[]>;
  getLeadsMeta: (options: { limit: number; days: number }) => Promise<Array<{ id: string; clientName: string | null }>>;
  getLatestMessagesByLead: (leadIds: string[]) => Promise<Map<string, LatestMessage | null>>;
  getReactivationReplies: (leadId: string) => Promise<ReactivationReplyResult>;
};

function defaultDeps(): ReactivationQueueViewDeps {
  return {
    getReactivationQueue: (options) => buildReactivationQueue(options),
    getLeadsMeta: async (options) => {
      const leads = await listWhatsAppLeads({ limit: options.limit, days: options.days, stage: "ALL" });
      return leads.map((lead) => ({ id: lead.id, clientName: lead.clientName || null }));
    },
    getLatestMessagesByLead: async (leadIds) => {
      const byLead = await listRecentMessagesByLeadIds(leadIds, 1);
      const out = new Map<string, LatestMessage | null>();
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
    getReactivationReplies: (leadId) => buildLeadReactivationReplies(leadId)
  };
}

export async function buildReactivationQueueView(
  options?: { limit?: number; days?: number },
  depsOverride?: Partial<ReactivationQueueViewDeps>
): Promise<ReactivationQueueViewResponse> {
  const limit = Math.max(1, Math.min(100, Math.round(Number(options?.limit || 20))));
  const days = Math.max(1, Math.min(365, Math.round(Number(options?.days || 30))));
  const deps: ReactivationQueueViewDeps = { ...defaultDeps(), ...(depsOverride || {}) };

  let queue: ReactivationDecision[];
  try {
    queue = await deps.getReactivationQueue({ limit, days });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Reactivation queue failed";
    if (error instanceof ReactivationEngineError) {
      throw new ReactivationQueueViewError("reactivation_queue", message, { cause: error });
    }
    throw new ReactivationQueueViewError("reactivation_queue", message, { cause: error });
  }

  const leadIds = queue.map((item) => item.leadId);

  let leadsMeta: Array<{ id: string; clientName: string | null }>;
  try {
    leadsMeta = await deps.getLeadsMeta({ limit, days });
  } catch (error) {
    throw new ReactivationQueueViewError(
      "lead_metadata",
      error instanceof Error ? error.message : "Lead metadata failed",
      { cause: error }
    );
  }
  const leadNameById = new Map(leadsMeta.map((lead) => [lead.id, lead.clientName]));

  let latestMessagesByLead: Map<string, LatestMessage | null>;
  try {
    latestMessagesByLead = await deps.getLatestMessagesByLead(leadIds);
  } catch (error) {
    throw new ReactivationQueueViewError(
      "message_metadata",
      error instanceof Error ? error.message : "Latest messages failed",
      { cause: error }
    );
  }

  const reactivationRepliesByLead = new Map<string, ReactivationReplyResult>();
  for (const leadId of leadIds) {
    try {
      reactivationRepliesByLead.set(leadId, await deps.getReactivationReplies(leadId));
    } catch (error) {
      const message = error instanceof Error ? error.message : `Reactivation replies failed for ${leadId}`;
      if (error instanceof ReactivationReplyError) {
        throw new ReactivationQueueViewError("reactivation_replies", message, { cause: error });
      }
      throw new ReactivationQueueViewError("reactivation_replies", message, { cause: error });
    }
  }

  const items: ReactivationQueueViewItem[] = queue.map((item) => {
    const latest = latestMessagesByLead.get(item.leadId) || null;
    const latestMessageDirection: "inbound" | "outbound" | null = latest
      ? latest.direction === "IN"
        ? "inbound"
        : "outbound"
      : null;
    const lastMessagePreview = latest ? String(latest.text || "").trim() || null : null;

    const replies = reactivationRepliesByLead.get(item.leadId);
    const top = replies?.shouldGenerate && replies.replyOptions.length > 0 ? replies.replyOptions[0] : null;
    const topReplyCard = top
      ? {
          label: String(top.label || "").trim(),
          intent: String(top.intent || "").trim(),
          messages: Array.isArray(top.messages) ? top.messages.map((m) => String(m || "")).filter(Boolean) : []
        }
      : null;

    return {
      leadId: item.leadId,
      clientName: leadNameById.get(item.leadId) ?? null,
      lastMessagePreview,
      lastMessageAt: latest?.createdAt || null,
      latestMessageDirection,
      silenceHours: item.silenceHours,
      stalledStage: item.stalledStage,
      shouldReactivate: item.shouldReactivate,
      reactivationPriority: item.reactivationPriority,
      reactivationReason: item.reactivationReason,
      recommendedAction: item.recommendedAction,
      tone: item.tone,
      timing: item.timing,
      signals: item.signals,
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
