import { listRecentMessagesByLeadIds, listWhatsAppLeads } from "../db/whatsappLeadsRepo.js";
import {
  computePriorityScoreDeterministic,
  type PriorityDeskItem
} from "./whatsappPriorityDeskService.js";
import {
  assessReactivationDeterministic,
  type ReactivationDecision
} from "./whatsappReactivationEngineService.js";
import { buildAiCardsViewModel } from "./whatsappAiCardsService.js";
import { buildLeadReactivationReplies } from "./whatsappReactivationReplyService.js";
import {
  type PriorityDeskViewItem,
  type PriorityDeskViewResponse
} from "./whatsappPriorityDeskViewService.js";
import {
  type ReactivationQueueViewItem,
  type ReactivationQueueViewResponse
} from "./whatsappReactivationQueueViewService.js";
import { listActiveSkippedItems } from "./whatsappMobileLabSkipService.js";

type FeedType = "active" | "reactivation";
type ReactivationPriority = "low" | "medium" | "high";
export type MobileLabFeedMode = "balanced" | "active_first" | "reactivation_first" | "active_only" | "reactivation_only";

type FeedReplyCard = {
  label: string;
  intent: string;
  messages: string[];
} | null;

export type MobileLabEnrichmentStatus =
  | "enriched"
  | "timeout"
  | "error"
  | "skipped_by_limit"
  | "no_generation_needed";

export type MobileLabEnrichmentSource = "active_ai_cards" | "reactivation_replies" | null;

export type MobileLabFeedItem = {
  feedType: FeedType;
  leadId: string;
  queueRank: number;
  clientName: string | null;
  lastMessagePreview: string | null;
  lastMessageAt: string | null;
  latestMessageDirection: "inbound" | "outbound" | null;
  stage: string | null;
  urgency: string | null;
  priorityBand: string | null;
  estimatedHeat: string | null;
  recommendedAction: string | null;
  tone: string | null;
  needsReply: boolean;
  waitingSinceMinutes: number;
  reactivationPriority: ReactivationPriority | null;
  timing: "now" | "later_today" | "tomorrow" | "monitor" | null;
  topReplyCard: FeedReplyCard;
  enrichmentStatus: MobileLabEnrichmentStatus;
  enrichmentSource: MobileLabEnrichmentSource;
  enrichmentError: string | null;
  skipAllowed: boolean;
  skipReason: string | null;
};

export type MobileLabFeedResponse = {
  items: MobileLabFeedItem[];
  meta: {
    count: number;
    activeCount: number;
    reactivationCount: number;
    limit: number;
    generatedAt: string;
  };
};

export class MobileLabFeedError extends Error {
  step: "priority_view" | "reactivation_view" | "merge";

  constructor(step: "priority_view" | "reactivation_view" | "merge", message: string, options?: { cause?: unknown }) {
    super(message);
    this.step = step;
    if (options && "cause" in options) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

type MobileLabFeedDeps = {
  getPriorityView: (options: { limit: number; days: number }) => Promise<PriorityDeskViewResponse>;
  getReactivationView: (options: { limit: number; days: number }) => Promise<ReactivationQueueViewResponse>;
  enrichActiveLead: (leadId: string) => Promise<{
    topReplyCard: FeedReplyCard;
    tone: string | null;
    status: Extract<MobileLabEnrichmentStatus, "enriched">;
  }>;
  enrichReactivationLead: (leadId: string) => Promise<{
    topReplyCard: FeedReplyCard;
    status: Extract<MobileLabEnrichmentStatus, "enriched" | "no_generation_needed">;
  }>;
  getActiveSkips: () => Promise<Array<{ leadId: string; feedType: FeedType; skippedUntil: string }>>;
  enrichmentLeadLimit: (limit: number) => number;
  enrichmentTimeoutMs: () => number;
  nowIso: () => string;
};

function parsePositiveInt(value: unknown): number | null {
  const num = Number(value);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num <= 0) return null;
  return num;
}

function resolveDefaultEnrichmentLeadLimit(limit: number): number {
  const configured = parsePositiveInt(process.env.WHATSAPP_MOBILE_LAB_ENRICHMENT_LEAD_LIMIT);
  const fallback = Math.max(0, Math.min(20, Math.round(Number(limit || 0))));
  if (configured == null) return fallback;
  return Math.max(0, Math.min(30, configured));
}

function resolveDefaultEnrichmentTimeoutMs(): number {
  const configured = parsePositiveInt(process.env.WHATSAPP_MOBILE_LAB_ENRICHMENT_TIMEOUT_MS);
  const fallback = 2500;
  const raw = configured == null ? fallback : configured;
  return Math.max(100, Math.min(10000, raw));
}

function toSafeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error || "enrichment_failed");
  return text.slice(0, 160);
}

function normalizeUrgency(input: string): "low" | "medium" | "high" {
  const key = String(input || "").trim().toLowerCase();
  if (key === "high") return "high";
  if (key === "low") return "low";
  return "medium";
}

function deriveUrgencyFromLead(lead: Awaited<ReturnType<typeof listWhatsAppLeads>>[number]): "low" | "medium" | "high" {
  if (lead.risk?.isAtRisk) return "high";
  const stage = String(lead.stage || "").toUpperCase();
  if (stage === "DEPOSIT_PENDING" || stage === "CONFIRMED") return "high";
  if (stage === "PRICE_SENT" || stage === "QUALIFIED" || stage === "VIDEO_PROPOSED") return "medium";
  return "low";
}

function deriveCommercialPriority(stage: string, paymentIntent: boolean): "low" | "medium" | "high" | "critical" {
  const key = String(stage || "").trim().toUpperCase();
  if (key === "DEPOSIT_PENDING" || key === "CONFIRMED") return "critical";
  if (key === "PRICE_SENT" || key === "VIDEO_PROPOSED" || paymentIntent) return "high";
  if (key === "QUALIFIED" || key === "QUALIFICATION_PENDING" || key === "STALLED") return "medium";
  return "low";
}

function deriveRecommendedAction(stage: string, needsReply: boolean, shouldReactivate = false): string {
  if (shouldReactivate) return "reactivate_gently";
  const key = String(stage || "").trim().toUpperCase();
  if (needsReply && (key === "PRICE_SENT" || key === "DEPOSIT_PENDING" || key === "CONFIRMED")) return "answer_precisely";
  if (key === "DEPOSIT_PENDING") return "push_softly_to_deposit";
  if (key === "PRICE_SENT") return "clarify_timing";
  if (key === "VIDEO_PROPOSED") return "propose_video";
  if (key === "QUALIFICATION_PENDING" || key === "NEW") return "qualify";
  if (key === "LOST" || key === "CONVERTED") return "close_out";
  return "answer_precisely";
}

type LatestMessageMeta = {
  direction: "inbound" | "outbound" | null;
  text: string | null;
  createdAt: string | null;
  waitingSinceMinutes: number;
  needsReply: boolean;
  silenceHours: number;
};

function toMs(value: string | null | undefined): number {
  if (!value) return NaN;
  return new Date(value).getTime();
}

function computeLatestMessageMeta(
  messages: Array<{ direction: "IN" | "OUT"; text: string; createdAt: string }>,
  nowMs: number
): LatestMessageMeta {
  const sorted = messages.slice().sort((a, b) => toMs(a.createdAt) - toMs(b.createdAt));
  const latest = sorted.length ? sorted[sorted.length - 1] : null;
  const latestInbound = [...sorted].reverse().find((m) => m.direction === "IN") || null;
  const latestOutbound = [...sorted].reverse().find((m) => m.direction === "OUT") || null;
  const latestDirection: "inbound" | "outbound" | null = latest ? (latest.direction === "IN" ? "inbound" : "outbound") : null;
  const needsReply = latestDirection === "inbound";
  const waitingAnchorMs = needsReply ? toMs(latest?.createdAt || null) : NaN;
  const waitingSinceMinutes = Number.isFinite(waitingAnchorMs) ? Math.max(0, Math.round((nowMs - waitingAnchorMs) / 60000)) : 0;
  const silenceAnchor = latestDirection === "outbound" ? latestOutbound?.createdAt : latestInbound?.createdAt || latest?.createdAt;
  const silenceMs = toMs(silenceAnchor || null);
  const silenceHours = Number.isFinite(silenceMs) ? Math.max(0, Math.round(((nowMs - silenceMs) / 3600000) * 10) / 10) : 0;

  return {
    direction: latestDirection,
    text: latest ? String(latest.text || "").trim() || null : null,
    createdAt: latest?.createdAt || null,
    waitingSinceMinutes,
    needsReply,
    silenceHours
  };
}

async function buildPriorityViewFast(options: { limit: number; days: number }): Promise<PriorityDeskViewResponse> {
  const leads = await listWhatsAppLeads({ limit: options.limit, days: options.days, stage: "ALL" });
  const leadIds = leads.map((lead) => lead.id);
  const byLead = await listRecentMessagesByLeadIds(leadIds, 30);
  const nowMs = Date.now();

  const items: PriorityDeskViewItem[] = leads.map((lead) => {
    const rows = byLead.get(lead.id) || [];
    const latest = computeLatestMessageMeta(rows, nowMs);
    const urgency = deriveUrgencyFromLead(lead);
    const commercialPriority = deriveCommercialPriority(lead.stage, Boolean(lead.paymentIntent));
    const recommendedAction = deriveRecommendedAction(lead.stage, latest.needsReply);
    const scored = computePriorityScoreDeterministic({
      stage: lead.stage,
      urgency,
      paymentIntent: Boolean(lead.paymentIntent),
      dropoffRisk: lead.risk?.isAtRisk ? "high" : "low",
      recommendedAction,
      commercialPriority,
      needsReply: latest.needsReply,
      waitingSinceMinutes: latest.waitingSinceMinutes
    });

    return {
      leadId: lead.id,
      clientName: lead.clientName || null,
      lastMessagePreview: latest.text,
      lastMessageAt: latest.createdAt,
      latestMessageDirection: latest.direction,
      needsReply: latest.needsReply,
      waitingSinceMinutes: latest.waitingSinceMinutes,
      priorityScore: scored.priorityScore,
      priorityBand: scored.priorityBand,
      estimatedHeat: scored.estimatedHeat,
      stage: lead.stage,
      urgency,
      paymentIntent: Boolean(lead.paymentIntent),
      dropoffRisk: lead.risk?.isAtRisk ? "high" : "low",
      recommendedAction,
      commercialPriority,
      tone: null,
      reasons: scored.reasons,
      topReplyCard: null
    };
  });

  return {
    items,
    meta: {
      count: items.length,
      limit: options.limit,
      days: options.days,
      generatedAt: new Date().toISOString()
    }
  };
}

async function buildReactivationViewFast(options: { limit: number; days: number }): Promise<ReactivationQueueViewResponse> {
  const leads = await listWhatsAppLeads({ limit: options.limit, days: options.days, stage: "ALL" });
  const leadIds = leads.map((lead) => lead.id);
  const byLead = await listRecentMessagesByLeadIds(leadIds, 30);
  const nowMs = Date.now();

  const items: ReactivationQueueViewItem[] = leads
    .map((lead) => {
      const rows = byLead.get(lead.id) || [];
      const latest = computeLatestMessageMeta(rows, nowMs);
      const urgency = deriveUrgencyFromLead(lead);
      const recommendedAction = deriveRecommendedAction(lead.stage, latest.needsReply, true);
      const decision: ReactivationDecision = assessReactivationDeterministic(
        {
          leadId: lead.id,
          stage: lead.stage,
          urgency,
          paymentIntent: Boolean(lead.paymentIntent),
          recommendedAction,
          eventDate: lead.eventDate,
          latestDirection: latest.direction === "inbound" ? "IN" : latest.direction === "outbound" ? "OUT" : null,
          silenceHours: latest.silenceHours,
          needsReply: latest.needsReply
        },
        nowMs
      );
      return {
        leadId: lead.id,
        clientName: lead.clientName || null,
        lastMessagePreview: latest.text,
        lastMessageAt: latest.createdAt,
        latestMessageDirection: latest.direction,
        silenceHours: latest.silenceHours,
        stalledStage: decision.stalledStage,
        shouldReactivate: decision.shouldReactivate,
        reactivationPriority: decision.reactivationPriority,
        reactivationReason: decision.reactivationReason,
        recommendedAction: decision.recommendedAction,
        tone: decision.tone,
        timing: decision.timing,
        signals: decision.signals,
        topReplyCard: null
      };
    })
    .filter((item) => item.shouldReactivate);

  return {
    items,
    meta: {
      count: items.length,
      limit: options.limit,
      days: options.days,
      generatedAt: new Date().toISOString()
    }
  };
}

function defaultDeps(): MobileLabFeedDeps {
  return {
    getPriorityView: (options) => buildPriorityViewFast(options),
    getReactivationView: (options) => buildReactivationViewFast(options),
    enrichActiveLead: async (leadId: string) => {
      const aiCards = await buildAiCardsViewModel(leadId);
      const top = aiCards.replyCards && aiCards.replyCards.length > 0 ? aiCards.replyCards[0] : null;
      return {
        topReplyCard: top
          ? {
              label: String(top.label || "").trim(),
              intent: String(top.intent || "").trim(),
              messages: Array.isArray(top.messages) ? top.messages.map((msg) => String(msg || "")).filter(Boolean) : []
            }
          : null,
        tone: aiCards.strategy?.tone ? String(aiCards.strategy.tone) : null,
        status: "enriched"
      };
    },
    enrichReactivationLead: async (leadId: string) => {
      const replies = await buildLeadReactivationReplies(leadId);
      const top = replies.shouldGenerate && Array.isArray(replies.replyOptions) && replies.replyOptions.length > 0
        ? replies.replyOptions[0]
        : null;
      return {
        topReplyCard: top
          ? {
              label: String(top.label || "").trim(),
              intent: String(top.intent || "").trim(),
              messages: Array.isArray(top.messages) ? top.messages.map((msg) => String(msg || "")).filter(Boolean) : []
            }
          : null,
        status: replies.shouldGenerate ? "enriched" : "no_generation_needed"
      };
    },
    getActiveSkips: async () => {
      const rows = await listActiveSkippedItems();
      return rows.map((row) => ({
        leadId: row.leadId,
        feedType: row.feedType,
        skippedUntil: row.skippedUntil
      }));
    },
    enrichmentLeadLimit: (limit: number) => resolveDefaultEnrichmentLeadLimit(limit),
    enrichmentTimeoutMs: () => resolveDefaultEnrichmentTimeoutMs(),
    nowIso: () => new Date().toISOString()
  };
}

function priorityWeight(value: ReactivationPriority): number {
  return value === "high" ? 3 : value === "medium" ? 2 : 1;
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

function toActiveFeedItem(item: PriorityDeskViewItem): MobileLabFeedItem {
  return {
    feedType: "active",
    leadId: item.leadId,
    queueRank: 0,
    clientName: item.clientName,
    lastMessagePreview: item.lastMessagePreview,
    lastMessageAt: item.lastMessageAt,
    latestMessageDirection: item.latestMessageDirection,
    stage: item.stage,
    urgency: item.urgency,
    priorityBand: item.priorityBand,
    estimatedHeat: item.estimatedHeat,
    recommendedAction: item.recommendedAction,
    tone: item.tone,
    needsReply: item.needsReply,
    waitingSinceMinutes: item.waitingSinceMinutes,
    reactivationPriority: null,
    timing: null,
    topReplyCard: item.topReplyCard,
    enrichmentStatus: item.topReplyCard ? "enriched" : "skipped_by_limit",
    enrichmentSource: "active_ai_cards",
    enrichmentError: null,
    skipAllowed: true,
    skipReason: null
  };
}

function toReactivationFeedItem(item: ReactivationQueueViewItem): MobileLabFeedItem {
  return {
    feedType: "reactivation",
    leadId: item.leadId,
    queueRank: 0,
    clientName: item.clientName,
    lastMessagePreview: item.lastMessagePreview,
    lastMessageAt: item.lastMessageAt,
    latestMessageDirection: item.latestMessageDirection,
    stage: item.stalledStage,
    urgency: null,
    priorityBand: null,
    estimatedHeat: null,
    recommendedAction: item.recommendedAction,
    tone: item.tone,
    needsReply: false,
    waitingSinceMinutes: Math.max(0, Math.round(Number(item.silenceHours || 0) * 60)),
    reactivationPriority: item.reactivationPriority,
    timing: item.timing,
    topReplyCard: item.topReplyCard,
    enrichmentStatus: item.topReplyCard ? "enriched" : "skipped_by_limit",
    enrichmentSource: "reactivation_replies",
    enrichmentError: null,
    skipAllowed: true,
    skipReason: null
  };
}

export async function buildMobileLabFeed(
  options?: { limit?: number; days?: number; mode?: MobileLabFeedMode; maxReactivation?: number },
  depsOverride?: Partial<MobileLabFeedDeps>
): Promise<MobileLabFeedResponse> {
  const limit = Math.max(1, Math.min(100, Math.round(Number(options?.limit || 20))));
  const days = Math.max(1, Math.min(365, Math.round(Number(options?.days || 30))));
  const modeRaw = String(options?.mode || "balanced").trim().toLowerCase();
  const allowedModes: MobileLabFeedMode[] = ["balanced", "active_first", "reactivation_first", "active_only", "reactivation_only"];
  if (!allowedModes.includes(modeRaw as MobileLabFeedMode)) {
    throw new MobileLabFeedError("merge", `Invalid mode: ${modeRaw}`);
  }
  const mode = modeRaw as MobileLabFeedMode;

  const maxReactivationRaw = options?.maxReactivation;
  const maxReactivation = maxReactivationRaw !== undefined && maxReactivationRaw !== null ? Number(maxReactivationRaw) : null;
  if (maxReactivation !== null && (!Number.isFinite(maxReactivation) || !Number.isInteger(maxReactivation) || maxReactivation < 0)) {
    throw new MobileLabFeedError("merge", "Invalid maxReactivation: must be an integer >= 0");
  }

  const sourceLimit = Math.max(limit, Math.min(40, Math.max(limit + 10, Math.round(limit * 1.5))));
  const deps: MobileLabFeedDeps = { ...defaultDeps(), ...(depsOverride || {}) };

  let priorityView: PriorityDeskViewResponse;
  try {
    priorityView = await deps.getPriorityView({ limit: sourceLimit, days });
  } catch (error) {
    throw new MobileLabFeedError("priority_view", error instanceof Error ? error.message : "Priority view failed", { cause: error });
  }

  let reactivationView: ReactivationQueueViewResponse;
  try {
    reactivationView = await deps.getReactivationView({ limit: sourceLimit, days });
  } catch (error) {
    throw new MobileLabFeedError("reactivation_view", error instanceof Error ? error.message : "Reactivation view failed", { cause: error });
  }

  try {
    const nowMs = new Date(deps.nowIso()).getTime();
    const skips = await deps.getActiveSkips();
    const skippedSet = new Set<string>();
    for (const skip of skips) {
      const untilMs = new Date(skip.skippedUntil).getTime();
      if (Number.isFinite(untilMs) && untilMs > nowMs) {
        skippedSet.add(`${skip.feedType}:${skip.leadId}`);
      }
    }

    const activeItems = priorityView.items
      .slice()
      .sort(
        (a, b) =>
          Number(b.needsReply) - Number(a.needsReply) ||
          b.priorityScore - a.priorityScore ||
          b.waitingSinceMinutes - a.waitingSinceMinutes ||
          a.leadId.localeCompare(b.leadId)
      )
      .map(toActiveFeedItem)
      .filter((item) => !skippedSet.has(`active:${item.leadId}`));

    const reactivationItems = reactivationView.items
      .slice()
      .sort(
        (a, b) =>
          priorityWeight(b.reactivationPriority) - priorityWeight(a.reactivationPriority) ||
          b.silenceHours - a.silenceHours ||
          a.leadId.localeCompare(b.leadId)
      )
      .map(toReactivationFeedItem)
      .filter((item) => !skippedSet.has(`reactivation:${item.leadId}`));

    const mixedModes = mode === "balanced" || mode === "active_first" || mode === "reactivation_first";
    const cappedReactivationItems = mixedModes && maxReactivation != null
      ? reactivationItems.slice(0, maxReactivation)
      : reactivationItems;

    let ordered: MobileLabFeedItem[];
    if (mode === "active_only") {
      ordered = activeItems;
    } else if (mode === "reactivation_only") {
      ordered = reactivationItems;
    } else if (mode === "reactivation_first") {
      ordered = [...cappedReactivationItems, ...activeItems];
    } else {
      ordered = [...activeItems, ...cappedReactivationItems];
    }

    const merged = ordered.slice(0, limit).map((item, index) => ({
      ...item,
      queueRank: index + 1
    }));

    const enrichmentLimit = Math.max(0, Math.min(merged.length, deps.enrichmentLeadLimit(limit)));
    const timeoutMs = Math.max(50, Math.min(2000, Math.round(deps.enrichmentTimeoutMs())));
    const enriched = merged.slice();
    const targets = enriched.slice(0, enrichmentLimit);

    for (let index = enrichmentLimit; index < enriched.length; index += 1) {
      enriched[index].enrichmentStatus = "skipped_by_limit";
      enriched[index].enrichmentError = null;
    }

    await Promise.all(
      targets.map(async (item) => {
        item.enrichmentSource = item.feedType === "active" ? "active_ai_cards" : "reactivation_replies";
        try {
          if (item.feedType === "active") {
            const enrichment = await withTimeout(deps.enrichActiveLead(item.leadId), timeoutMs);
            item.topReplyCard = enrichment?.topReplyCard || null;
            item.enrichmentStatus = enrichment?.status || (item.topReplyCard ? "enriched" : "error");
            item.enrichmentError = null;
            item.tone = enrichment?.tone || item.tone || null;
            return;
          }
          const enrichment = await withTimeout(deps.enrichReactivationLead(item.leadId), timeoutMs);
          item.topReplyCard = enrichment?.topReplyCard || null;
          item.enrichmentStatus = enrichment?.status || (item.topReplyCard ? "enriched" : "no_generation_needed");
          item.enrichmentError = null;
        } catch (error) {
          item.topReplyCard = null;
          item.enrichmentStatus = error instanceof Error && error.message === "timeout" ? "timeout" : "error";
          item.enrichmentError = toSafeError(error);
        }
      })
    );

    return {
      items: enriched,
      meta: {
        count: enriched.length,
        activeCount: enriched.filter((item) => item.feedType === "active").length,
        reactivationCount: enriched.filter((item) => item.feedType === "reactivation").length,
        limit,
        generatedAt: new Date().toISOString()
      }
    };
  } catch (error) {
    throw new MobileLabFeedError("merge", error instanceof Error ? error.message : "Feed merge failed", { cause: error });
  }
}
