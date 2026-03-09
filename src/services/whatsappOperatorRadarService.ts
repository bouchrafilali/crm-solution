import {
  listWhatsAppPriorityRadarRows,
  type WhatsAppPriorityRadarRow
} from "../db/whatsappPriorityIntelligenceRepo.js";

export type OperatorRadarItem = {
  leadId: string;
  clientName: string | null;
  phoneNumber: string | null;
  stage: string;
  priorityScore: number;
  priorityBand: "critical" | "high" | "medium" | "low";
  conversionProbability: number;
  dropoffRisk: number;
  recommendedAttention: string;
  reasonCodes: string[];
  awaitingReply: boolean;
  ticketValueEstimate: number | null;
  silenceHours: number;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  updatedAt: string;
};

export type OperatorRadarResponse = {
  hotOpportunities: OperatorRadarItem[];
  atRisk: OperatorRadarItem[];
  waitingReply: OperatorRadarItem[];
  highValue: OperatorRadarItem[];
  reactivation: OperatorRadarItem[];
};

export class OperatorRadarError extends Error {
  step: "radar_query";

  constructor(step: "radar_query", message: string, options?: { cause?: unknown }) {
    super(message);
    this.step = step;
    if (options && "cause" in options) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

type OperatorRadarDeps = {
  listRows: (limit?: number) => Promise<WhatsAppPriorityRadarRow[]>;
  nowMs: () => number;
};

const HIGH_VALUE_TICKET_THRESHOLD = 1500;

function defaultDeps(): OperatorRadarDeps {
  return {
    listRows: (limit) => listWhatsAppPriorityRadarRows(limit),
    nowMs: () => Date.now()
  };
}

function toTimeMs(value: string | null | undefined): number {
  if (!value) return NaN;
  return new Date(value).getTime();
}

function stageClosed(stage: string): boolean {
  const key = String(stage || "").trim().toUpperCase();
  return key === "CONVERTED" || key === "LOST";
}

function mapItem(row: WhatsAppPriorityRadarRow, nowMs: number): OperatorRadarItem {
  const inboundMs = toTimeMs(row.lastInboundAt);
  const outboundMs = toTimeMs(row.lastOutboundAt);
  const anchorMs = Math.max(
    Number.isFinite(inboundMs) ? inboundMs : NaN,
    Number.isFinite(outboundMs) ? outboundMs : NaN
  );
  const silenceHours = Number.isFinite(anchorMs) ? Math.max(0, Math.round(((nowMs - anchorMs) / 3600000) * 10) / 10) : 0;
  return {
    leadId: row.leadId,
    clientName: row.clientName,
    phoneNumber: row.phoneNumber,
    stage: row.stage,
    priorityScore: Math.max(0, Math.min(100, Math.round(Number(row.priorityScore || 0)))),
    priorityBand: row.priorityBand,
    conversionProbability: Number(row.conversionProbability || 0),
    dropoffRisk: Number(row.dropoffRisk || 0),
    recommendedAttention: String(row.recommendedAttention || "").trim().toLowerCase(),
    reasonCodes: Array.isArray(row.reasonCodes) ? row.reasonCodes.map((code) => String(code || "").trim().toLowerCase()).filter(Boolean) : [],
    awaitingReply: Boolean(row.awaitingReply),
    ticketValueEstimate: row.ticketValueEstimate == null ? null : Number(row.ticketValueEstimate),
    silenceHours,
    lastInboundAt: row.lastInboundAt,
    lastOutboundAt: row.lastOutboundAt,
    updatedAt: row.updatedAt
  };
}

function rank(a: OperatorRadarItem, b: OperatorRadarItem): number {
  const bandWeight = (value: OperatorRadarItem["priorityBand"]): number => {
    if (value === "critical") return 4;
    if (value === "high") return 3;
    if (value === "medium") return 2;
    return 1;
  };
  const byBand = bandWeight(b.priorityBand) - bandWeight(a.priorityBand);
  if (byBand !== 0) return byBand;
  const byScore = b.priorityScore - a.priorityScore;
  if (byScore !== 0) return byScore;
  const aInbound = toTimeMs(a.lastInboundAt);
  const bInbound = toTimeMs(b.lastInboundAt);
  if (Number.isFinite(aInbound) || Number.isFinite(bInbound)) return (bInbound || 0) - (aInbound || 0);
  return a.leadId.localeCompare(b.leadId);
}

export async function buildOperatorRadar(
  options?: { limit?: number },
  depsOverride?: Partial<OperatorRadarDeps>
): Promise<OperatorRadarResponse> {
  const deps: OperatorRadarDeps = { ...defaultDeps(), ...(depsOverride || {}) };
  const limit = Math.max(1, Math.min(1000, Math.round(Number(options?.limit || 300))));
  const nowMs = deps.nowMs();
  let rows: WhatsAppPriorityRadarRow[];
  try {
    rows = await deps.listRows(limit);
  } catch (error) {
    throw new OperatorRadarError("radar_query", error instanceof Error ? error.message : "Operator radar query failed", {
      cause: error
    });
  }

  const mapped = rows.map((row) => mapItem(row, nowMs));
  const hotOpportunities = mapped.filter((item) => item.conversionProbability > 0.7).sort(rank);
  const atRisk = mapped.filter((item) => item.dropoffRisk > 0.55).sort(rank);
  const waitingReply = mapped.filter((item) => item.awaitingReply).sort(rank);
  const highValue = mapped
    .filter((item) => Number(item.ticketValueEstimate || 0) >= HIGH_VALUE_TICKET_THRESHOLD)
    .sort(rank);
  const reactivation = mapped
    .filter((item) => item.silenceHours > 48 && !stageClosed(item.stage))
    .sort(rank);

  return {
    hotOpportunities,
    atRisk,
    waitingReply,
    highValue,
    reactivation
  };
}
