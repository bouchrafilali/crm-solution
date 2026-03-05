export type TimingUrgency = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type TimingInput = {
  stage?: string;
  messages?: Array<{
    direction: "in" | "out" | "IN" | "OUT";
    ts?: string | number | Date | null;
  }>;
  intents?: {
    price_intent?: boolean;
    video_intent?: boolean;
    payment_intent?: boolean;
    deposit_intent?: boolean;
    confirmation_intent?: boolean;
  };
  last_inbound_at?: string | number | Date | null;
  last_outbound_at?: string | number | Date | null;
  event_date?: string | null;
  conv_percent?: number | null;
  businessHours?: {
    startHour: number;
    endHour: number;
  };
  localTimeCtx?: {
    phase?: "NIGHT" | "EARLY" | "BUSINESS" | "EVENING";
    is_business_hours?: boolean;
  } | null;
  local_phase?: "NIGHT" | "EARLY" | "BUSINESS" | "EVENING";
  nowMs?: number;
};

export type TimingPressure = {
  pressure_score: number;
  urgency: TimingUrgency;
  waiting_for: "WAITING_FOR_US" | "WAITING_FOR_CLIENT";
  reference: "last_inbound" | "last_outbound";
  since_minutes: number | null;
  since_inbound_minutes: number | null;
  since_outbound_minutes: number | null;
  target_minutes: number;
  respond_within_minutes: number;
  overdue_minutes: number;
  label: string;
  explanation: string;
};

export const STAGE_THRESHOLDS: Record<string, { target: number; high: number; critical: number }> = {
  NEW: { target: 10, high: 15, critical: 30 },
  PRODUCT_INTEREST: { target: 10, high: 15, critical: 30 },
  QUALIFICATION_PENDING: { target: 15, high: 30, critical: 60 },
  QUALIFIED: { target: 30, high: 60, critical: 120 },
  PRICE_SENT: { target: 30, high: 45, critical: 90 },
  VIDEO_PROPOSED: { target: 60, high: 120, critical: 360 },
  DEPOSIT_PENDING: { target: 20, high: 30, critical: 60 },
  CONFIRMED: { target: 240, high: 480, critical: 1440 }
};

const HOT_REVENUE_STAGES = new Set(["PRICE_SENT", "DEPOSIT_PENDING"]);
const URGENCY_ORDER: Record<TimingUrgency, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
const ORDER_TO_URGENCY: TimingUrgency[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
const MAX_URGENCY_WAITING_FOR_CLIENT: Record<string, TimingUrgency> = {
  NEW: "MEDIUM",
  PRODUCT_INTEREST: "MEDIUM",
  QUALIFICATION_PENDING: "MEDIUM",
  QUALIFIED: "MEDIUM",
  VIDEO_PROPOSED: "MEDIUM",
  PRICE_SENT: "HIGH",
  DEPOSIT_PENDING: "CRITICAL",
  CONFIRMED: "MEDIUM",
  CONVERTED: "LOW",
  LOST: "LOW"
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toMs(value: TimingInput["last_inbound_at"]): number | null {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

function minutesSince(lastInboundMs: number | null, nowMs: number): number | null {
  if (lastInboundMs == null) return null;
  if (lastInboundMs > nowMs) return 0;
  return Math.floor((nowMs - lastInboundMs) / 60000);
}

function parseDaysUntilEvent(eventDate?: string | null, nowMs?: number): number | null {
  if (!eventDate) return null;
  const parsed = Date.parse(eventDate);
  if (!Number.isFinite(parsed)) return null;
  const now = nowMs ?? Date.now();
  const diffMs = parsed - now;
  return Math.ceil(diffMs / 86400000);
}

function isOutsideBusinessHours(nowMs: number, hours?: TimingInput["businessHours"]): boolean {
  if (!hours) return false;
  const start = clamp(Math.floor(hours.startHour), 0, 23);
  const end = clamp(Math.floor(hours.endHour), 1, 24);
  if (start >= end) return false;
  const hour = new Date(nowMs).getHours();
  return hour < start || hour >= end;
}

function computeIntentBoost(intents: NonNullable<TimingInput["intents"]>): number {
  let boost = 0;
  if (intents.price_intent) boost += 6;
  if (intents.video_intent) boost += 4;
  if (intents.payment_intent) boost += 14;
  if (intents.deposit_intent) boost += 14;
  if (intents.confirmation_intent) boost += 16;
  return clamp(boost, 0, 30);
}

function eventBoost(daysUntilEvent: number | null): number {
  if (daysUntilEvent == null) return 0;
  if (daysUntilEvent <= 10) return 22;
  if (daysUntilEvent <= 21) return 14;
  if (daysUntilEvent <= 30) return 8;
  return 0;
}

function getStageThreshold(stage: string): { target: number; high: number; critical: number } {
  const normalized = String(stage || "").toUpperCase();
  return STAGE_THRESHOLDS[normalized] || STAGE_THRESHOLDS.QUALIFICATION_PENDING;
}

function urgencyFromMinutes(sinceInbound: number, threshold: { target: number; high: number; critical: number }): TimingUrgency {
  if (sinceInbound >= threshold.critical) return "CRITICAL";
  if (sinceInbound >= threshold.high) return "HIGH";
  if (sinceInbound >= threshold.target) return "MEDIUM";
  return "LOW";
}

function downgradeUrgencyOneLevel(urgency: TimingUrgency): TimingUrgency {
  if (urgency === "CRITICAL") return "HIGH";
  if (urgency === "HIGH") return "MEDIUM";
  if (urgency === "MEDIUM") return "LOW";
  return "LOW";
}

function normalizeDirection(value: string | undefined): "IN" | "OUT" | "" {
  const d = String(value || "").toUpperCase();
  if (d === "IN") return "IN";
  if (d === "OUT") return "OUT";
  return "";
}

function clampUrgency(urgency: TimingUrgency, maxUrgency: TimingUrgency): TimingUrgency {
  return URGENCY_ORDER[urgency] > URGENCY_ORDER[maxUrgency] ? maxUrgency : urgency;
}

function maxScoreForUrgency(urgency: TimingUrgency): number {
  if (urgency === "LOW") return 34;
  if (urgency === "MEDIUM") return 59;
  if (urgency === "HIGH") return 79;
  return 100;
}

export function computeTimingPressure(input: TimingInput): TimingPressure {
  const nowMs = input.nowMs ?? Date.now();
  const stage = String(input.stage || "QUALIFICATION_PENDING").toUpperCase();
  const intents = {
    price_intent: Boolean(input.intents?.price_intent),
    video_intent: Boolean(input.intents?.video_intent),
    payment_intent: Boolean(input.intents?.payment_intent),
    deposit_intent: Boolean(input.intents?.deposit_intent),
    confirmation_intent: Boolean(input.intents?.confirmation_intent)
  };

  const daysUntilEvent = parseDaysUntilEvent(input.event_date, nowMs);
  const outsideHours = isOutsideBusinessHours(nowMs, input.businessHours);
  const stageThreshold = getStageThreshold(stage);
  const targetMinutes = stageThreshold.target;
  let score = 0;

  const intentBoost = computeIntentBoost(intents);
  score += intentBoost;
  score += eventBoost(daysUntilEvent);
  const convPercent = Number(input.conv_percent ?? 0);
  if (Number.isFinite(convPercent) && convPercent >= 70) {
    score += convPercent >= 85 ? 8 : 5;
  }

  const list = Array.isArray(input.messages) ? input.messages : [];
  const lastMsg = list.length ? list[list.length - 1] : null;
  const lastInboundMsg = [...list].reverse().find((m) => normalizeDirection(m?.direction) === "IN") || null;
  const lastOutboundMsg = [...list].reverse().find((m) => normalizeDirection(m?.direction) === "OUT") || null;
  const lastInboundMs = toMs(lastInboundMsg?.ts ?? input.last_inbound_at);
  const lastOutboundMs = toMs(lastOutboundMsg?.ts ?? input.last_outbound_at);
  const waitingFor: "WAITING_FOR_US" | "WAITING_FOR_CLIENT" =
    normalizeDirection(lastMsg?.direction) === "IN"
      ? "WAITING_FOR_US"
      : normalizeDirection(lastMsg?.direction) === "OUT"
        ? "WAITING_FOR_CLIENT"
        : (lastOutboundMs != null && (lastInboundMs == null || lastOutboundMs >= lastInboundMs))
          ? "WAITING_FOR_CLIENT"
          : "WAITING_FOR_US";
  const reference: "last_inbound" | "last_outbound" = waitingFor === "WAITING_FOR_CLIENT" ? "last_outbound" : "last_inbound";

  const sinceInbound = minutesSince(lastInboundMs, nowMs);
  const sinceOutbound = minutesSince(lastOutboundMs, nowMs);
  const sinceMinutes = waitingFor === "WAITING_FOR_CLIENT" ? sinceOutbound : sinceInbound;
  let overdueMinutes = 0;
  let urgency: TimingUrgency = "LOW";
  if (sinceMinutes != null) {
    const ratioToCritical = sinceMinutes / Math.max(1, stageThreshold.critical);
    score += clamp(Math.round(ratioToCritical * 100), 0, 100);
    overdueMinutes = Math.max(0, sinceMinutes - targetMinutes);
    urgency = urgencyFromMinutes(sinceMinutes, stageThreshold);
  }

  const localPhase = String(input.localTimeCtx?.phase || input.local_phase || "").toUpperCase();
  const hotStageOverride = HOT_REVENUE_STAGES.has(stage);
  if (localPhase === "NIGHT") {
    score = Math.round(score * 0.75);
    if (!(hotStageOverride && score >= 70)) {
      urgency = downgradeUrgencyOneLevel(urgency);
    }
  } else if (localPhase === "EARLY") {
    score = Math.round(score * 0.85);
  } else if (localPhase === "EVENING") {
    score += 5;
  }

  if (outsideHours && localPhase === "") {
    score = Math.round(score * 0.9);
  }

  if (waitingFor === "WAITING_FOR_CLIENT") {
    const maxUrgency = MAX_URGENCY_WAITING_FOR_CLIENT[stage] || "MEDIUM";
    const before = urgency;
    urgency = clampUrgency(urgency, maxUrgency);
    if (urgency !== before) {
      const diff = URGENCY_ORDER[before] - URGENCY_ORDER[urgency];
      score -= 10 + diff * 5;
    }
    score = Math.min(score, maxScoreForUrgency(urgency));
  }

  const pressureScore = Math.round(clamp(score, 0, 100));

  let label = "Aucune attente active";
  if (sinceMinutes != null) {
    if (waitingFor === "WAITING_FOR_CLIENT") {
      label = "En attente client • dernier envoi il y a " + String(sinceMinutes) + " min";
    } else if (overdueMinutes > 0) {
      label = "En retard de " + String(overdueMinutes) + " min";
    } else {
      label = "Répondre dans " + String(Math.max(0, targetMinutes - sinceMinutes)) + " min";
    }
  }

  const explanationParts = [
    "waiting_for=" + (waitingFor === "WAITING_FOR_CLIENT" ? "CLIENT" : "US"),
    "stage=" + stage,
    "ref=" + reference,
    sinceMinutes == null ? "since=n/a" : "since=" + String(sinceMinutes) + "m",
    sinceInbound == null ? "since_inbound=n/a" : "since_inbound=" + String(sinceInbound) + "m",
    sinceOutbound == null ? "since_outbound=n/a" : "since_outbound=" + String(sinceOutbound) + "m",
    "Cible=" + String(targetMinutes) + "m",
    "Seuil haut=" + String(stageThreshold.high) + "m",
    "Seuil critique=" + String(stageThreshold.critical) + "m",
    "Événement=" + String(daysUntilEvent == null ? "n/a" : String(daysUntilEvent) + "j"),
    "Boost intention=" + String(intentBoost),
    "Heures ouvrées=" + String(!outsideHours),
    "Phase locale=" + (localPhase || "n/a")
  ];

  return {
    pressure_score: pressureScore,
    urgency,
    waiting_for: waitingFor,
    reference,
    since_minutes: sinceMinutes,
    since_inbound_minutes: sinceInbound,
    since_outbound_minutes: sinceOutbound,
    target_minutes: targetMinutes,
    respond_within_minutes: targetMinutes,
    overdue_minutes: overdueMinutes,
    label,
    explanation: explanationParts.join(" • ")
  };
}
