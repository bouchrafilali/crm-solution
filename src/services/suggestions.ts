import { computeTimingPressure, type TimingUrgency } from "./timingPressure.js";
import { computeLeadPriorityScore, type LeadPriorityUrgency } from "./leadPriority.js";
import { computeSmartRelanceDelay, type LocalTimeContext } from "./smartRelanceDelay.js";

export type SuggestionStage =
  | "NEW"
  | "QUALIFICATION_PENDING"
  | "QUALIFIED"
  | "PRICE_SENT"
  | "VIDEO_PROPOSED"
  | "DEPOSIT_PENDING"
  | "CONFIRMED"
  | "CONVERTED"
  | "LOST";

export type SuggestionFacts = {
  stage: SuggestionStage | string;
  lang?: "FR" | "EN" | string;
  country?: string | null;
  event_date?: string | null;
  event_month?: number | string | null;
  event_date_precision?: "DAY" | "MONTH" | "UNKNOWN" | string;
  event_date_estimate_iso?: string | null;
  event_date_text?: string | null;
  destination?: string | null;
  conv_percent?: number | null;
  risk_score?: number | null;
  learning_boosts?: Record<string, number> | null;
  learningStatsByKey?: Record<string, { boost?: number | null }> | null;
  product_id?: string | null;
  intents?: {
    price_intent?: boolean;
    video_intent?: boolean;
    payment_intent?: boolean;
    deposit_intent?: boolean;
    confirmation_intent?: boolean;
  };
};

export type SuggestionMessage = {
  direction: "in" | "out" | "IN" | "OUT";
  text: string;
  ts?: string;
};

export type SuggestionCard = {
  id: string;
  intent_key?: string;
  title: string;
  text: string;
  reason: string;
  priority: number;
  final_score?: number;
  score_debug?: {
    priority: number;
    pressure_score: number;
    risk_score: number;
    boost: number;
    intentMatch: boolean;
    components: {
      basePriorityWeight: number;
      timingWeight: number;
      riskWeight: number;
      learningWeight: number;
      intentWeight: number;
    };
  };
  timing?: {
    urgency: TimingUrgency;
    label: string;
    pressure_score: number;
    waiting_for?: "WAITING_FOR_US" | "WAITING_FOR_CLIENT";
    reference?: "last_inbound" | "last_outbound";
    since_minutes?: number | null;
    since_inbound_minutes: number | null;
    since_outbound_minutes?: number | null;
    target_minutes: number;
    respond_within_minutes: number;
    overdue_minutes: number;
    explanation?: string;
  };
  priority_unified?: {
    score: number;
    level: LeadPriorityUrgency;
    explanation: string;
  };
  smart_delay?: {
    should_delay: boolean;
    delay_until_iso: string | null;
    delay_until_label: string | null;
    delay_reason: string | null;
    override_allowed_now: boolean;
  };
};

const PRICE_PATTERN =
  /(?:\b(?:mad|dhs?|dh|€|\$|eur|usd)\s*[0-9][0-9\s.,]*\b|\b[0-9][0-9\s.,]*\s*(?:mad|dhs?|dh|€|\$|eur|usd)\b)/i;
const PRICE_PHRASE_PATTERN = /\b(le\s+prix\s+est|price\s+is|priced\s+at|prix\s*:)\b/i;
const DATE_ASK_PATTERN = /\b(date|jour|quand|when|event date|date de l[’']?év[eé]nement)\b/i;
const DEST_ASK_PATTERN = /\b(destination|ville|city|country|livraison|delivery)\b/i;

const INTENT_PATTERNS = {
  price_intent: /\b(how\s+much|price\??|how\s+much\s+is|how\s+much\s+does|combien|prix|tarif|cost)\b/i,
  video_intent: /\b(video|call|visio|facetime)\b/i,
  payment_intent: /\b(how\s+can\s+i\s+pay|payment|card|transfer|paypal)\b/i,
  deposit_intent: /\b(deposit|acompte|advance|book\s+it)\b/i,
  confirmation_intent: /\b(i\s+confirm|confirmed|ok\s+i\s+take\s+it|let['’]s\s+proceed)\b/i
};

const SCORE_WEIGHTS = {
  priority: 0.40,
  timing: 0.25,
  risk: 0.20,
  intentBonus: 12,
  boostScale: 5
};

function clamp(n: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, n));
}

function num(v: unknown, fallback = 0): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function getLearningKey(card: SuggestionCard): string {
  const id = String(card?.id || "").toLowerCase();

  if (id.includes("qualification")) return "qualification";
  if (id.includes("price_contextualized") || id.includes("price_sent")) return "price_contextualized";
  if (id.includes("deposit")) return "deposit_step";
  if (id.includes("follow_up") || id.includes("relance")) return "follow_up";
  if (id.includes("confirmation")) return "confirmation_step";

  return "other";
}

function getLearningBoost(card: SuggestionCard, facts: SuggestionFacts): number {
  const key = getLearningKey(card);

  const direct = facts?.learning_boosts && facts.learning_boosts[key];
  if (direct != null) return num(direct, 0);

  const nested = facts?.learningStatsByKey && facts.learningStatsByKey[key]?.boost;
  if (nested != null) return num(nested, 0);

  return 0;
}

function getIntentKey(card: SuggestionCard): string {
  const k = card?.intent_key ? String(card.intent_key) : "";
  if (k) return k;

  const id = String(card?.id || "").toLowerCase();
  if (id.includes("price")) return "price_intent";
  if (id.includes("video")) return "video_intent";
  if (id.includes("payment")) return "payment_intent";
  if (id.includes("deposit") || id.includes("acompte")) return "deposit_intent";
  if (id.includes("confirm")) return "confirmation_intent";

  return "";
}

function isIntentMatched(card: SuggestionCard, facts: SuggestionFacts): boolean {
  const intents = facts?.intents || {};
  const k = getIntentKey(card) as keyof NonNullable<SuggestionFacts["intents"]> | "";
  if (!k) return false;
  return Boolean(intents[k]);
}

function computeFinalSuggestionScore(card: SuggestionCard, facts: SuggestionFacts): {
  finalScore: number;
  debug: NonNullable<SuggestionCard["score_debug"]>;
} {
  const priority = clamp(num(card?.priority, 0), 0, 100);
  const pressure = clamp(num(card?.timing?.pressure_score, 0), 0, 100);
  const risk = clamp(num(facts?.risk_score, 0), 0, 100);

  const boost = clamp(num(getLearningBoost(card, facts), 0), -5, 5);
  const intentMatch = isIntentMatched(card, facts);

  const basePriorityWeight = priority * SCORE_WEIGHTS.priority;
  const timingWeight = pressure * SCORE_WEIGHTS.timing;
  const riskWeight = risk * SCORE_WEIGHTS.risk;
  const learningWeight = boost * SCORE_WEIGHTS.boostScale;
  const intentWeight = intentMatch ? SCORE_WEIGHTS.intentBonus : 0;

  const finalScore = basePriorityWeight + timingWeight + riskWeight + learningWeight + intentWeight;

  return {
    finalScore,
    debug: {
      priority,
      pressure_score: pressure,
      risk_score: risk,
      boost,
      intentMatch,
      components: {
        basePriorityWeight,
        timingWeight,
        riskWeight,
        learningWeight,
        intentWeight
      }
    }
  };
}

function normalizeText(input: string): string {
  return String(input || "").replace(/[\n\r\t]+/g, " ").trim();
}

function isOutbound(msg: SuggestionMessage): boolean {
  return String(msg.direction || "").toUpperCase() === "OUT";
}

function isInbound(msg: SuggestionMessage): boolean {
  return String(msg.direction || "").toUpperCase() === "IN";
}

function detectIntents(text: string): Required<NonNullable<SuggestionFacts["intents"]>> {
  const clean = normalizeText(text);
  return {
    price_intent: INTENT_PATTERNS.price_intent.test(clean),
    video_intent: INTENT_PATTERNS.video_intent.test(clean),
    payment_intent: INTENT_PATTERNS.payment_intent.test(clean),
    deposit_intent: INTENT_PATTERNS.deposit_intent.test(clean),
    confirmation_intent: INTENT_PATTERNS.confirmation_intent.test(clean)
  };
}

function hasPriceSentOutbound(messages: SuggestionMessage[]): boolean {
  return messages.some((msg) => {
    if (!isOutbound(msg)) return false;
    const clean = normalizeText(msg.text);
    if (!clean) return false;
    return PRICE_PATTERN.test(clean) || PRICE_PHRASE_PATTERN.test(clean);
  });
}

function askedRecently(messages: SuggestionMessage[], field: "event_date" | "destination"): boolean {
  const recentOutbound = messages.filter(isOutbound).slice(-3);
  return recentOutbound.some((msg) => {
    const clean = normalizeText(msg.text);
    if (!clean) return false;
    if (field === "event_date") return DATE_ASK_PATTERN.test(clean);
    return DEST_ASK_PATTERN.test(clean);
  });
}

function stageRank(stage: string): number {
  const normalized = String(stage || "").toUpperCase();
  const rank: Record<string, number> = {
    NEW: 0,
    QUALIFICATION_PENDING: 1,
    QUALIFIED: 2,
    PRICE_SENT: 3,
    VIDEO_PROPOSED: 3,
    DEPOSIT_PENDING: 4,
    CONFIRMED: 5,
    CONVERTED: 6,
    LOST: 7
  };
  return rank[normalized] ?? 0;
}

function maxStage(a: string, b: string): string {
  return stageRank(a) >= stageRank(b) ? a : b;
}

function toStage(raw: string): SuggestionStage {
  const s = String(raw || "").toUpperCase();
  if (
    s === "NEW" ||
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

function textSimilarity(a: string, b: string): number {
  const tokensA = new Set(normalizeText(a).toLowerCase().split(/\s+/).filter(Boolean));
  const tokensB = new Set(normalizeText(b).toLowerCase().split(/\s+/).filter(Boolean));
  if (!tokensA.size || !tokensB.size) return 0;
  let inter = 0;
  for (const t of tokensA) if (tokensB.has(t)) inter += 1;
  const union = tokensA.size + tokensB.size - inter;
  return union === 0 ? 0 : inter / union;
}

function normalizeLocationToken(value: string): string {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function inferTimeZoneFromFacts(facts: SuggestionFacts): string | null {
  const cityMap: Record<string, string> = {
    madrid: "Europe/Madrid",
    paris: "Europe/Paris",
    london: "Europe/London",
    dubai: "Asia/Dubai",
    casablanca: "Africa/Casablanca",
    rabat: "Africa/Casablanca",
    marrakech: "Africa/Casablanca",
    "new york": "America/New_York",
    miami: "America/New_York",
    columbus: "America/New_York",
    "los angeles": "America/Los_Angeles",
    "san francisco": "America/Los_Angeles",
    chicago: "America/Chicago"
  };
  const countryMap: Record<string, string> = {
    MA: "Africa/Casablanca",
    FR: "Europe/Paris",
    ES: "Europe/Madrid",
    UK: "Europe/London",
    AE: "Asia/Dubai",
    SA: "Asia/Riyadh",
    US: "America/New_York",
    CA: "America/Toronto",
    GB: "Europe/London"
  };

  const destination = String(facts.destination || "");
  if (destination) {
    for (const part of destination.split(/[,-]/)) {
      const key = normalizeLocationToken(part);
      if (key && cityMap[key]) return cityMap[key];
    }
  }
  const country = String(facts.country || "").trim().toUpperCase();
  if (country && countryMap[country]) return countryMap[country];
  return null;
}

function getLocalTimeContextFromFacts(facts: SuggestionFacts, nowMs: number): LocalTimeContext {
  const tz = inferTimeZoneFromFacts(facts);
  let hour = 12;
  let minute = 0;
  let time = "12:00";
  try {
    const parts = tz
      ? new Intl.DateTimeFormat("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
          timeZone: tz
        }).format(new Date(nowMs))
      : new Intl.DateTimeFormat("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false
        }).format(new Date(nowMs));
    time = parts;
    const [h, m] = String(parts).split(":");
    hour = Number(h);
    minute = Number(m);
  } catch {
    hour = new Date(nowMs).getHours();
    minute = new Date(nowMs).getMinutes();
    time = String(hour).padStart(2, "0") + ":" + String(minute).padStart(2, "0");
  }
  let phase: "NIGHT" | "EARLY" | "BUSINESS" | "EVENING" = "NIGHT";
  if (hour >= 6 && hour <= 8) phase = "EARLY";
  else if (hour >= 9 && hour <= 18) phase = "BUSINESS";
  else if (hour >= 19 && hour <= 22) phase = "EVENING";
  return {
    tz,
    time,
    hour: Number.isFinite(hour) ? hour : -1,
    minute: Number.isFinite(minute) ? minute : 0,
    phase,
    is_business_hours: hour >= 9 && hour <= 20
  };
}

function relanceThresholdsByStage(stage: string): { soft: number; strong: number } {
  const s = String(stage || "").toUpperCase();
  if (s === "QUALIFICATION_PENDING") return { soft: 180, strong: 360 };
  if (s === "QUALIFIED") return { soft: 240, strong: 480 };
  if (s === "PRICE_SENT") return { soft: 60, strong: 180 };
  if (s === "DEPOSIT_PENDING") return { soft: 30, strong: 90 };
  if (s === "VIDEO_PROPOSED") return { soft: 180, strong: 360 };
  return { soft: 240, strong: 480 };
}

export function buildSuggestions(input: {
  facts: SuggestionFacts;
  messages: SuggestionMessage[];
}): SuggestionCard[] {
  const facts = input.facts || ({ stage: "NEW" } as SuggestionFacts);
  const messages = Array.isArray(input.messages) ? input.messages.slice(-20) : [];
  const lang = String(facts.lang || "FR").toUpperCase() === "EN" ? "EN" : "FR";
  const lastInbound = [...messages].reverse().find(isInbound) || null;
  const lastInboundText = normalizeText(lastInbound?.text || "");

  const inboundIntents = detectIntents(lastInboundText);
  const factsIntents = facts.intents || {};
  const intents = {
    price_intent: Boolean(inboundIntents.price_intent || factsIntents.price_intent),
    video_intent: Boolean(inboundIntents.video_intent || factsIntents.video_intent),
    payment_intent: Boolean(inboundIntents.payment_intent || factsIntents.payment_intent),
    deposit_intent: Boolean(inboundIntents.deposit_intent || factsIntents.deposit_intent),
    confirmation_intent: Boolean(inboundIntents.confirmation_intent || factsIntents.confirmation_intent)
  };

  const datePrecision = String(facts.event_date_precision || "").toUpperCase();
  const hasExactDate = Boolean(String(facts.event_date || "").trim());
  const hasEventMonth = Boolean(
    String(facts.event_month || "").trim() ||
    datePrecision === "MONTH" ||
    /\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec|janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[ûu]t|septembre|octobre|novembre|d[ée]cembre)\b/i.test(String(facts.event_date_text || ""))
  );
  const datePresent = hasExactDate || datePrecision === "DAY" || datePrecision === "MONTH" || hasEventMonth;
  const destinationPresent = Boolean(String(facts.destination || "").trim());

  const missingFields: Array<"event_date" | "destination"> = [];
  if (!datePresent) missingFields.push("event_date");
  if (!destinationPresent) missingFields.push("destination");

  const outAskedDate = askedRecently(messages, "event_date");
  const outAskedDestination = askedRecently(messages, "destination");
  const alreadyAskedBoth = outAskedDate && outAskedDestination;

  let effectiveStage = String(facts.stage || "NEW").toUpperCase();
  if (!datePresent || !destinationPresent) {
    effectiveStage = "QUALIFICATION_PENDING";
  } else {
    effectiveStage = maxStage(effectiveStage, "QUALIFIED");
    if (hasPriceSentOutbound(messages)) effectiveStage = maxStage(effectiveStage, "PRICE_SENT");
    if (intents.payment_intent || intents.deposit_intent) effectiveStage = maxStage(effectiveStage, "DEPOSIT_PENDING");
  }
  effectiveStage = toStage(effectiveStage);

  const suggestions: SuggestionCard[] = [];

  if (effectiveStage === "QUALIFICATION_PENDING") {
    const missingDate = missingFields.includes("event_date");
    const missingDestination = missingFields.includes("destination");
    let text = "";
    if (lang === "EN") {
      if (intents.price_intent) {
        text = "To confirm price and timeline, could you share your event date?";
      } else if (missingDate && missingDestination) {
        text = "Could you confirm your event date?";
      } else if (missingDate) {
        text = "Could you confirm your event date so I can guide you precisely?";
      } else {
        text = "Could you confirm your delivery destination (city/country)?";
      }
    } else {
      if (intents.price_intent) {
        text = "Pour confirmer le prix et le délai, pouvez-vous partager la date de l’événement et la destination de livraison ?";
      } else if (missingDate && missingDestination) {
        text = "Pouvez-vous me confirmer la date de l’événement et la destination de livraison (ville/pays) ?";
      } else if (missingDate) {
        text = "Pouvez-vous me confirmer la date de votre événement ?";
      } else {
        text = "Pouvez-vous me confirmer la destination de livraison (ville/pays) ?";
      }
    }

    if (!alreadyAskedBoth || !intents.price_intent) {
      suggestions.push({
        id: "qual_missing_fields",
        title: "Compléter qualification",
        text,
        reason: "Qualification en attente avec informations clés manquantes (70% basé sur la dernière intention entrante).",
        priority: intents.price_intent ? 96 : 92
      });
    }

    suggestions.push({
      id: "qual_offer_visio",
      title: "Proposer visio courte",
      text:
        lang === "EN"
          ? "If helpful, I can also arrange a short private video call."
          : "Si vous le souhaitez, je peux aussi proposer une courte visio privée.",
      reason: "Option complémentaire pendant la collecte des informations de qualification.",
      priority: 62
    });
  } else if (effectiveStage === "QUALIFIED") {
    suggestions.push({
      id: "qualified_price_context",
      title: "Prix contextualisé",
      text:
        lang === "EN"
          ? "Perfect, we are on schedule for your date. The price is [price] with a production timeline of [timeline], DHL included. If useful, I can arrange a short private video call."
          : "Parfait, nous sommes dans les délais. Le prix est de [prix] avec un délai de confection de [délai], DHL inclus. Si utile, je peux organiser une courte visio privée.",
      reason: "Qualification complète (date + destination présentes), prochaine étape: contextualisation du prix.",
      priority: 94
    });
    if (!hasExactDate && hasEventMonth) {
      suggestions.push({
        id: "qualified_confirm_exact_day",
        title: "Confirmer le jour exact (optionnel)",
        text:
          lang === "EN"
            ? "To confirm production slot, could you share the exact event date (day) when convenient?"
            : "Pour confirmer le créneau de confection, pouvez-vous partager le jour exact de l’événement quand cela vous convient ?",
        reason: "Le mois est suffisant pour avancer; le jour exact est un raffinement non bloquant.",
        priority: 66
      });
    }
  } else if (effectiveStage === "PRICE_SENT" || effectiveStage === "VIDEO_PROPOSED") {
    suggestions.push({
      id: "price_sent_next_payment",
      title: "Avancer vers paiement",
      text:
        lang === "EN"
          ? "Would you like me to send the deposit link now so we can secure your slot?"
          : "Souhaitez-vous que je vous envoie le lien d’acompte maintenant pour bloquer votre créneau ?",
      reason: "Prix déjà communiqué; priorité au passage acompte/paiement.",
      priority: intents.payment_intent || intents.deposit_intent ? 97 : 90
    });
  } else if (effectiveStage === "DEPOSIT_PENDING") {
    suggestions.push({
      id: "deposit_pending_send_link",
      title: "Envoyer lien acompte",
      text:
        lang === "EN"
          ? "Perfect, here is the deposit link: [link]. Once done, I’ll confirm the next steps right away."
          : "Parfait, voici le lien d’acompte : [lien]. Dès validation, je vous confirme immédiatement la suite.",
      reason: "Intention de paiement/acompte détectée; envoyer une action claire avec réassurance.",
      priority: 95
    });
  } else if (effectiveStage === "CONFIRMED") {
    suggestions.push({
      id: "confirmed_next_steps",
      title: "Suite après confirmation",
      text:
        lang === "EN"
          ? "Great, confirmed. Next step: payment finalization and measurements. I can send both now."
          : "Parfait, c’est confirmé. Prochaine étape : finalisation du paiement et prise de mesures. Je peux vous envoyer les deux maintenant.",
      reason: "Lead confirmé; passer aux étapes opérationnelles suivantes.",
      priority: 93
    });
  }

  const nowMs = Date.now();
  const localTimeCtx = getLocalTimeContextFromFacts(facts, nowMs);
  const timing = computeTimingPressure({
    stage: facts.stage,
    messages,
    intents,
    last_inbound_at: lastInbound?.ts,
    event_date: facts.event_date,
    conv_percent: facts.conv_percent ?? null,
    localTimeCtx: localTimeCtx,
    local_phase: localTimeCtx.phase,
    businessHours: { startHour: 10, endHour: 19 }
  });
  const unified = computeLeadPriorityScore({
    risk_score: Number(facts.risk_score ?? 0),
    timing_score: timing.pressure_score,
    timing_urgency: timing.urgency
  });

  const waitingForClient = timing.waiting_for === "WAITING_FOR_CLIENT";
  const sinceOutbound = Number(timing.since_outbound_minutes ?? -1);
  const relanceThresholds = relanceThresholdsByStage(effectiveStage);
  if (waitingForClient && Number.isFinite(sinceOutbound) && sinceOutbound >= relanceThresholds.soft) {
    const strong = sinceOutbound >= relanceThresholds.strong;
    const relanceText = lang === "EN"
      ? strong
        ? "Quick follow-up: if you’d like, I can confirm the next step now."
        : "Just checking in when convenient. I can help you move to the next step."
      : strong
        ? "Petite relance: si vous le souhaitez, je peux confirmer la prochaine étape maintenant."
        : "Je me permets une relance quand cela vous convient. Je peux vous aider à passer à l’étape suivante.";
    suggestions.push({
      id: strong ? "relance_adaptee_strong" : "relance_adaptee_soft",
      title: strong ? "Relance adaptée (forte)" : "Relance adaptée",
      text: relanceText,
      reason: "Attente client détectée après notre dernier message.",
      priority:
        effectiveStage === "DEPOSIT_PENDING" ? (strong ? 98 : 94) :
        effectiveStage === "PRICE_SENT" ? (strong ? 95 : 90) :
        strong ? 88 : 84
    });
  }

  const sorted = suggestions.sort((a, b) => b.priority - a.priority);
  const deduped: SuggestionCard[] = [];
  for (const item of sorted) {
    const tooSimilar = deduped.some((kept) => textSimilarity(kept.text, item.text) > 0.82);
    if (!tooSimilar) deduped.push(item);
    if (deduped.length >= 3) break;
  }

  const cards = deduped.map((card) => {
    const idLower = String(card.id || "").toLowerCase();
    const isRelanceCard = idLower.includes("follow") || idLower.includes("relance");
    let smartDelay = undefined;
    let adjustedUnifiedScore = unified.priority_score;
    let adjustedReason = String(card.reason || "");
    let adjustedTimingLabel = timing.label;
    let adjustedTimingExplanation = timing.explanation;

    if (isRelanceCard) {
      smartDelay = computeSmartRelanceDelay({
        localTimeCtx,
        stage: String(facts.stage || ""),
        elapsed_minutes: timing.since_minutes,
        urgency: timing.urgency
      });
      if (smartDelay.should_delay) {
        adjustedUnifiedScore = Math.max(0, adjustedUnifiedScore - 20);
        if (smartDelay.delay_until_label) {
          adjustedTimingLabel = "Reporter jusqu’à " + smartDelay.delay_until_label + " (heure locale)";
        }
        if (smartDelay.delay_reason) {
          adjustedTimingExplanation = String(timing.explanation || "") + " • smart_delay=" + smartDelay.delay_reason;
        }
      } else if (smartDelay.override_allowed_now) {
        adjustedReason = adjustedReason
          ? adjustedReason + " Heures creuses, mais étape à forte valeur — envoi recommandé maintenant."
          : "Heures creuses, mais étape à forte valeur — envoi recommandé maintenant.";
      }
    }

    return {
      ...card,
      reason: adjustedReason,
      timing: {
        urgency: timing.urgency,
        label: adjustedTimingLabel,
        pressure_score: timing.pressure_score,
        waiting_for: timing.waiting_for,
        reference: timing.reference,
        since_minutes: timing.since_minutes,
        since_inbound_minutes: timing.since_inbound_minutes,
        since_outbound_minutes: timing.since_outbound_minutes,
        target_minutes: timing.target_minutes,
        respond_within_minutes: timing.respond_within_minutes,
        overdue_minutes: timing.overdue_minutes,
        explanation: adjustedTimingExplanation
      },
      priority_unified: {
        score: adjustedUnifiedScore,
        level: (
          adjustedUnifiedScore >= 85 ? "CRITICAL" :
          adjustedUnifiedScore >= 70 ? "HIGH" :
          adjustedUnifiedScore >= 50 ? "MEDIUM" :
          "LOW"
        ) as LeadPriorityUrgency,
        explanation: unified.explanation
      },
      smart_delay: smartDelay
    };
  });

  const list = Array.isArray(cards) ? cards : [];

  for (const c of list) {
    const s = computeFinalSuggestionScore(c, facts);
    c.final_score = Math.round(s.finalScore * 10) / 10;
    c.score_debug = s.debug;
  }

  list.sort((a, b) => {
    const ds = num(b.final_score, 0) - num(a.final_score, 0);
    if (ds !== 0) return ds;
    return num(b.priority, 0) - num(a.priority, 0);
  });

  return list;
}
