import { buildPriorityDeskView, type PriorityDeskViewResponse, type PriorityDeskViewItem } from "./whatsappPriorityDeskViewService.js";
import {
  buildReactivationQueueView,
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
  getActiveSkips: () => Promise<Array<{ leadId: string; feedType: FeedType; skippedUntil: string }>>;
  nowIso: () => string;
};

function defaultDeps(): MobileLabFeedDeps {
  return {
    getPriorityView: (options) => buildPriorityDeskView(options),
    getReactivationView: (options) => buildReactivationQueueView(options),
    getActiveSkips: async () => {
      const rows = await listActiveSkippedItems();
      return rows.map((row) => ({
        leadId: row.leadId,
        feedType: row.feedType,
        skippedUntil: row.skippedUntil
      }));
    },
    nowIso: () => new Date().toISOString()
  };
}

function priorityWeight(value: ReactivationPriority): number {
  return value === "high" ? 3 : value === "medium" ? 2 : 1;
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
  const hasMaxReactivation = maxReactivationRaw !== undefined && maxReactivationRaw !== null;
  const parsedMaxReactivation = hasMaxReactivation ? Number(maxReactivationRaw) : null;
  if (
    hasMaxReactivation &&
    (!Number.isFinite(parsedMaxReactivation) || !Number.isInteger(parsedMaxReactivation) || parsedMaxReactivation < 0)
  ) {
    throw new MobileLabFeedError("merge", "Invalid maxReactivation: must be an integer >= 0");
  }
  const maxReactivation = hasMaxReactivation ? (parsedMaxReactivation as number) : null;

  const sourceLimit = Math.max(limit, Math.min(100, Math.max(limit * 3, limit + 20)));
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
      .filter((item) => item.needsReply)
      .slice()
      .sort((a, b) => b.priorityScore - a.priorityScore || b.waitingSinceMinutes - a.waitingSinceMinutes || a.leadId.localeCompare(b.leadId))
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

    return {
      items: merged,
      meta: {
        count: merged.length,
        activeCount: merged.filter((item) => item.feedType === "active").length,
        reactivationCount: merged.filter((item) => item.feedType === "reactivation").length,
        limit,
        generatedAt: new Date().toISOString()
      }
    };
  } catch (error) {
    throw new MobileLabFeedError("merge", error instanceof Error ? error.message : "Feed merge failed", { cause: error });
  }
}
