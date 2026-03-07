import {
  listWhatsAppOperatorEventsByRange,
  type WhatsAppOperatorActionType,
  type WhatsAppOperatorEventRow,
  type WhatsAppOperatorFeedType,
  type WhatsAppOperatorSurface
} from "../db/whatsappOperatorEventsRepo.js";

type OperatorSummaryInput = {
  from: string;
  to: string;
};

export type WhatsAppOperatorAnalyticsSummary = {
  summary: {
    totalEvents: number;
    bySurface: Record<WhatsAppOperatorSurface, number>;
    byActionType: Record<string, number>;
    byFeedType: Record<WhatsAppOperatorFeedType, number>;
    byMode: Record<string, number>;
  };
  topCards: Array<{
    cardLabel: string;
    cardIntent: string | null;
    count: number;
  }>;
  meta: {
    from: string;
    to: string;
    generatedAt: string;
  };
};

export class WhatsAppOperatorAnalyticsError extends Error {
  code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message);
    this.code = code;
    if (options && "cause" in options) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

type OperatorAnalyticsDeps = {
  listEvents: (input: { from: string; to: string }) => Promise<WhatsAppOperatorEventRow[]>;
  nowIso: () => string;
};

function defaultDeps(): OperatorAnalyticsDeps {
  return {
    listEvents: (input) => listWhatsAppOperatorEventsByRange(input),
    nowIso: () => new Date().toISOString()
  };
}

function parseIsoDate(value: string, field: "from" | "to"): string {
  const normalized = String(value || "").trim();
  const ms = new Date(normalized).getTime();
  if (!normalized || !Number.isFinite(ms)) {
    throw new WhatsAppOperatorAnalyticsError("operator_events_summary_invalid_date", `${field} must be a valid ISO date`);
  }
  return new Date(ms).toISOString();
}

export function validateOperatorSummaryRange(input: Partial<OperatorSummaryInput>): { from: string; to: string } {
  const fromRaw = String(input.from || "").trim();
  const toRaw = String(input.to || "").trim();
  if (!fromRaw || !toRaw) {
    throw new WhatsAppOperatorAnalyticsError("operator_events_summary_missing_range", "from and to are required");
  }
  const from = parseIsoDate(fromRaw, "from");
  const to = parseIsoDate(toRaw, "to");
  if (new Date(from).getTime() > new Date(to).getTime()) {
    throw new WhatsAppOperatorAnalyticsError("operator_events_summary_invalid_range", "from must be before or equal to to");
  }
  return { from, to };
}

export async function buildWhatsAppOperatorEventsSummary(
  input: Partial<OperatorSummaryInput>,
  depsOverride?: Partial<OperatorAnalyticsDeps>
): Promise<WhatsAppOperatorAnalyticsSummary> {
  const deps: OperatorAnalyticsDeps = { ...defaultDeps(), ...(depsOverride || {}) };
  const range = validateOperatorSummaryRange(input);

  const events = await deps.listEvents({
    from: range.from,
    to: range.to
  });

  const bySurface: Record<WhatsAppOperatorSurface, number> = {
    priority_desk: 0,
    reactivation_queue: 0,
    mobile_lab: 0,
    chat: 0
  };
  const byActionType: Record<string, number> = {};
  const byFeedType: Record<WhatsAppOperatorFeedType, number> = {
    active: 0,
    reactivation: 0
  };
  const byMode: Record<string, number> = {};

  const topCardActionSet = new Set<WhatsAppOperatorActionType>([
    "reply_card_inserted",
    "reply_card_sent",
    "reactivation_card_inserted",
    "reactivation_card_sent"
  ]);
  const topCardCounter = new Map<string, { cardLabel: string; cardIntent: string | null; count: number }>();

  for (const event of events) {
    bySurface[event.surface] = (bySurface[event.surface] || 0) + 1;
    byActionType[event.actionType] = (byActionType[event.actionType] || 0) + 1;
    if (event.feedType) {
      byFeedType[event.feedType] = (byFeedType[event.feedType] || 0) + 1;
    }
    if (event.mode) {
      byMode[event.mode] = (byMode[event.mode] || 0) + 1;
    }

    if (topCardActionSet.has(event.actionType) && event.cardLabel) {
      const cardLabel = String(event.cardLabel || "").trim();
      if (!cardLabel) continue;
      const cardIntent = event.cardIntent ? String(event.cardIntent).trim() || null : null;
      const key = `${cardLabel}::${cardIntent || ""}`;
      const current = topCardCounter.get(key);
      if (current) {
        current.count += 1;
      } else {
        topCardCounter.set(key, { cardLabel, cardIntent, count: 1 });
      }
    }
  }

  const topCards = Array.from(topCardCounter.values())
    .sort((a, b) => b.count - a.count || a.cardLabel.localeCompare(b.cardLabel))
    .slice(0, 10);

  return {
    summary: {
      totalEvents: events.length,
      bySurface,
      byActionType,
      byFeedType,
      byMode
    },
    topCards,
    meta: {
      from: range.from,
      to: range.to,
      generatedAt: deps.nowIso()
    }
  };
}
