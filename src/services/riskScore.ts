export type RiskStage =
  | "NEW"
  | "PRODUCT_INTEREST"
  | "QUALIFICATION_PENDING"
  | "QUALIFIED"
  | "PRICE_SENT"
  | "VIDEO_PROPOSED"
  | "DEPOSIT_PENDING"
  | "CONFIRMED"
  | "CONVERTED"
  | "LOST";

export type RiskFacts = {
  stage: RiskStage | string;
  lang?: string;
  event_date?: string | null;
  destination?: string | null;
  intents?: {
    price_intent?: boolean;
    video_intent?: boolean;
    payment_intent?: boolean;
    deposit_intent?: boolean;
    confirmation_intent?: boolean;
  };
  conv_percent?: number | null;
  hours_since_last_activity?: number | null;
};

export type RiskMessage = {
  direction: "in" | "out";
  text: string;
  ts?: string;
};

export type RiskReason = {
  key: string;
  points: number;
  detail: string;
};

export type RiskRecommendedAction =
  | "NONE"
  | "ASK_QUALIFICATION"
  | "SEND_PRICE"
  | "PROPOSE_VIDEO"
  | "SEND_DEPOSIT_LINK"
  | "NUDGE_CONFIRMATION"
  | "RECOVERY";

export type RiskResult = {
  risk_score: number;
  risk_level: "LOW" | "MEDIUM" | "HIGH";
  at_risk: boolean;
  reasons: RiskReason[];
  recommended_action: RiskRecommendedAction;
};

const HOT_STAGES = new Set<RiskStage>(["PRICE_SENT", "VIDEO_PROPOSED", "DEPOSIT_PENDING"]);

const STAGE_BASELINE_POINTS: Record<RiskStage, number> = {
  NEW: 20,
  PRODUCT_INTEREST: 30,
  QUALIFICATION_PENDING: 42,
  QUALIFIED: 36,
  PRICE_SENT: 56,
  VIDEO_PROPOSED: 58,
  DEPOSIT_PENDING: 62,
  CONFIRMED: 18,
  CONVERTED: 4,
  LOST: 6
};

function normalizeStage(raw: string): RiskStage {
  const s = String(raw || "").trim().toUpperCase();
  if (
    s === "NEW" ||
    s === "PRODUCT_INTEREST" ||
    s === "QUALIFICATION_PENDING" ||
    s === "QUALIFIED" ||
    s === "PRICE_SENT" ||
    s === "VIDEO_PROPOSED" ||
    s === "DEPOSIT_PENDING" ||
    s === "CONFIRMED" ||
    s === "CONVERTED" ||
    s === "LOST"
  ) {
    return s;
  }
  return "NEW";
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toHoursSinceLastActivity(input: { facts: RiskFacts; messages: RiskMessage[]; nowMs: number }): number {
  const explicit = Number(input.facts.hours_since_last_activity);
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;

  const latestTs = input.messages
    .map((m) => new Date(String(m.ts || "")).getTime())
    .filter((ts) => Number.isFinite(ts))
    .sort((a, b) => b - a)[0];
  if (!Number.isFinite(latestTs)) return 0;
  return Math.max(0, (input.nowMs - latestTs) / 3600000);
}

function parseDaysUntil(eventDateRaw: string | null | undefined, nowMs: number): number | null {
  const raw = String(eventDateRaw || "").trim();
  if (!raw) return null;
  const parsed = new Date(raw).getTime();
  if (!Number.isFinite(parsed)) return null;
  return (parsed - nowMs) / 86400000;
}

function isInbound(rawDirection: string): boolean {
  return String(rawDirection || "").toLowerCase() === "in";
}

function sortMessagesByTs(messages: RiskMessage[]): RiskMessage[] {
  return [...messages].sort((a, b) => {
    const aTs = new Date(String(a.ts || "")).getTime();
    const bTs = new Date(String(b.ts || "")).getTime();
    const aValid = Number.isFinite(aTs);
    const bValid = Number.isFinite(bTs);
    if (aValid && bValid) return aTs - bTs;
    if (aValid) return 1;
    if (bValid) return -1;
    return 0;
  });
}

function dedupeAndSortReasons(reasons: RiskReason[]): RiskReason[] {
  const byKey = new Map<string, RiskReason>();
  for (const reason of reasons) {
    const current = byKey.get(reason.key);
    if (!current || reason.points > current.points) byKey.set(reason.key, reason);
  }
  return [...byKey.values()]
    .filter((r) => r.points > 0)
    .sort((a, b) => b.points - a.points)
    .slice(0, 6);
}

export function recommendAction(input: {
  facts: RiskFacts;
  hoursSinceLastActivity: number;
  lastMessageInbound: boolean;
  missingEventDate: boolean;
  missingDestination: boolean;
  isConfirmed: boolean;
}): RiskRecommendedAction {
  const stage = normalizeStage(input.facts.stage);
  const missingFields = input.missingEventDate || input.missingDestination;

  if (stage === "CONVERTED" || stage === "LOST") return "NONE";
  if (missingFields) return "ASK_QUALIFICATION";
  if (stage === "QUALIFIED") return "SEND_PRICE";
  if (stage === "PRICE_SENT" || stage === "VIDEO_PROPOSED") return "SEND_DEPOSIT_LINK";
  if (stage === "DEPOSIT_PENDING") {
    if (input.hoursSinceLastActivity >= 48 || input.lastMessageInbound) return "SEND_DEPOSIT_LINK";
    return "NUDGE_CONFIRMATION";
  }
  if (stage === "CONFIRMED" && !input.isConfirmed) return "NUDGE_CONFIRMATION";
  if (input.lastMessageInbound) {
    if (stage === "NEW" || stage === "PRODUCT_INTEREST" || stage === "QUALIFICATION_PENDING") {
      return "ASK_QUALIFICATION";
    }
    return "NUDGE_CONFIRMATION";
  }
  if (input.hoursSinceLastActivity >= 72) return "RECOVERY";
  return "NONE";
}

export function computeRiskScore(input: {
  facts: RiskFacts;
  messages: RiskMessage[];
  nowMs?: number;
}): RiskResult {
  const facts = input.facts || ({ stage: "NEW" } as RiskFacts);
  const messages = Array.isArray(input.messages) ? input.messages.slice(-50) : [];
  const nowMs = Number.isFinite(input.nowMs) ? Number(input.nowMs) : Date.now();
  const stage = normalizeStage(facts.stage);
  const reasons: RiskReason[] = [];

  reasons.push({
    key: "baseline_stage",
    points: STAGE_BASELINE_POINTS[stage],
    detail: `Baseline risk for stage ${stage}.`
  });

  const sorted = sortMessagesByTs(messages);
  const lastMessage = sorted.length ? sorted[sorted.length - 1] : null;
  const lastMessageInbound = lastMessage ? isInbound(lastMessage.direction) : false;
  if (lastMessageInbound) {
    reasons.push({
      key: "last_message_inbound_waiting",
      points: 18,
      detail: "Last message is inbound, client is waiting for a response."
    });
  }

  const hoursSinceLastActivity = toHoursSinceLastActivity({ facts, messages, nowMs });
  const staleThreshold = HOT_STAGES.has(stage) ? 48 : 24;
  if (hoursSinceLastActivity >= staleThreshold) {
    const over = hoursSinceLastActivity - staleThreshold;
    const inactivityPoints = clamp(14 + over * 0.8, 14, 34);
    reasons.push({
      key: "inactivity_stale",
      points: Math.round(inactivityPoints),
      detail: `${hoursSinceLastActivity.toFixed(1)}h since last activity (threshold ${staleThreshold}h for ${stage}).`
    });
  }

  const missingEventDate = !String(facts.event_date || "").trim();
  const missingDestination = !String(facts.destination || "").trim();
  const missingFields = missingEventDate || missingDestination;

  if (stage === "QUALIFICATION_PENDING" && missingFields) {
    const missingCount = Number(missingEventDate) + Number(missingDestination);
    reasons.push({
      key: "qualification_missing_fields",
      points: missingCount === 2 ? 20 : 12,
      detail: `Missing qualification fields: ${[
        missingEventDate ? "event_date" : "",
        missingDestination ? "destination" : ""
      ]
        .filter(Boolean)
        .join(", ")}.`
    });
  }

  const intents = facts.intents || {};
  if (stage === "QUALIFICATION_PENDING" && Boolean(intents.price_intent) && missingFields) {
    reasons.push({
      key: "price_intent_blocked_by_missing_fields",
      points: 14,
      detail: "Client shows price intent but key qualification fields are still missing."
    });
  }

  const daysUntilEvent = parseDaysUntil(facts.event_date, nowMs);
  const notConfirmed = stage !== "CONFIRMED" && stage !== "CONVERTED";
  if (daysUntilEvent != null && daysUntilEvent >= 0 && notConfirmed) {
    if (daysUntilEvent < 10) {
      reasons.push({
        key: "event_very_close",
        points: 22,
        detail: `Event is very close (${Math.floor(daysUntilEvent)} days).`
      });
    } else if (daysUntilEvent < 21) {
      reasons.push({
        key: "event_close",
        points: 12,
        detail: `Event is close (${Math.floor(daysUntilEvent)} days).`
      });
    }
  }

  if (intents.confirmation_intent) {
    reasons.push({
      key: "intent_confirmation",
      points: 16,
      detail: "Confirmation intent detected."
    });
  }
  if (intents.deposit_intent) {
    reasons.push({
      key: "intent_deposit",
      points: 18,
      detail: "Deposit intent detected."
    });
  }
  if (intents.payment_intent) {
    reasons.push({
      key: "intent_payment",
      points: 15,
      detail: "Payment intent detected."
    });
  }
  if (intents.price_intent) {
    reasons.push({
      key: "intent_price",
      points: 8,
      detail: "Price intent detected."
    });
  }
  if (intents.video_intent) {
    reasons.push({
      key: "intent_video",
      points: 5,
      detail: "Video call intent detected."
    });
  }

  const convPercent = Number(facts.conv_percent);
  if (Number.isFinite(convPercent) && convPercent >= 70) {
    reasons.push({
      key: "high_conversation_activity",
      points: 4,
      detail: `Conversation activity is high (${convPercent.toFixed(0)}%).`
    });
  }

  const scoredReasons = dedupeAndSortReasons(reasons);
  let riskScore = clamp(Math.round(scoredReasons.reduce((sum, item) => sum + item.points, 0)), 0, 100);
  if (stage === "CONVERTED") riskScore = Math.min(riskScore, 15);

  const riskLevel: "LOW" | "MEDIUM" | "HIGH" =
    riskScore >= 70 ? "HIGH" : riskScore >= 40 ? "MEDIUM" : "LOW";

  const atRisk = stage !== "CONVERTED" && stage !== "LOST" && riskScore >= 55;
  const recommendedAction = recommendAction({
    facts,
    hoursSinceLastActivity,
    lastMessageInbound,
    missingEventDate,
    missingDestination,
    isConfirmed: stage === "CONFIRMED" || stage === "CONVERTED"
  });

  return {
    risk_score: riskScore,
    risk_level: riskLevel,
    at_risk: atRisk,
    reasons: scoredReasons,
    recommended_action: recommendedAction
  };
}
