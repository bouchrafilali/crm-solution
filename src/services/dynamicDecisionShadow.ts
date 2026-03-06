import { env } from "../config/env.js";
import { createMlEvent, hasMlInferenceEventForMessage } from "../db/mlRepo.js";
import {
  getWhatsAppLeadById,
  listWhatsAppLeadMessages,
  type WhatsAppLeadMessage,
  type WhatsAppLeadRecord
} from "../db/whatsappLeadsRepo.js";

export const DYNAMIC_DECISION_MODEL_KEY = "dynamic_decision_v1_shadow";

const CONVERSATION_STATES = [
  "qualification_incomplete",
  "pricing_appropriate",
  "objection_active",
  "hesitation_detected",
  "urgency_detected",
  "delivery_concern",
  "ready_for_conversion",
  "stalled_conversation",
  "deposit_likely",
  "availability_check_needed",
  "active_purchase_window"
] as const;

const MISSING_INFORMATION_KEYS = [
  "event_date",
  "destination_country",
  "destination_city",
  "budget_range",
  "product_reference",
  "size_or_measurements"
] as const;

const CUSTOMER_SIGNALS = [
  "price_request",
  "availability_request",
  "delivery_question",
  "timeline_shared",
  "budget_shared",
  "objection_price",
  "objection_trust",
  "purchase_intent",
  "hesitation",
  "ready_to_buy"
] as const;

const NEXT_ACTIONS = [
  "ask_one_key_question",
  "answer_directly",
  "reassure",
  "propose_call",
  "provide_contextual_price",
  "push_softly_to_deposit",
  "reactivate_gently",
  "availability_request",
  "answer_and_qualify_lightly",
  "propose_next_step"
] as const;

export type DynamicConversationState = (typeof CONVERSATION_STATES)[number];
export type DynamicMissingInformation = (typeof MISSING_INFORMATION_KEYS)[number];
export type DynamicCustomerSignal = (typeof CUSTOMER_SIGNALS)[number];
export type DynamicRecommendedNextAction = (typeof NEXT_ACTIONS)[number];

export type DynamicDecision = {
  conversation_state: DynamicConversationState[];
  missing_information: DynamicMissingInformation[];
  customer_signals: DynamicCustomerSignal[];
  recommended_next_action: DynamicRecommendedNextAction;
  confidence: number;
  reasoning_short: string;
};

function isEnabled(): boolean {
  const raw = String(env.WHATSAPP_DYNAMIC_DECISION_SHADOW_ENABLED || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export function isDynamicDecisionDebugEnabled(): boolean {
  const raw = String(env.WHATSAPP_DYNAMIC_DECISION_DEBUG || "").trim().toLowerCase();
  const flagOn = raw === "1" || raw === "true" || raw === "yes" || raw === "on";
  return flagOn || String(env.NODE_ENV || "").toLowerCase() === "development";
}

function uniq<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function normalizeText(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function includesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function parseDate(value: string | null | undefined): Date | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return null;
  return new Date(ts);
}

function inferSignals(latestText: string): DynamicCustomerSignal[] {
  const signals: DynamicCustomerSignal[] = [];
  if (includesAny(latestText, [/\bprix\b/, /\bprice\b/, /\bcombien\b/, /\bhow much\b/, /\btarif\b/])) {
    signals.push("price_request");
  }
  if (includesAny(latestText, [/\bdisponible\b/, /\bavailability\b/, /\bavailable\b/, /\best-ce possible\b/])) {
    signals.push("availability_request");
  }
  if (includesAny(latestText, [/\blivraison\b/, /\bdelivery\b/, /\bshipping\b/, /\bexp[ée]d/i])) {
    signals.push("delivery_question");
  }
  if (includesAny(latestText, [/\bdate\b/, /\bmariage\b/, /\bwedding\b/, /\bsemaine\b/, /\bmonth\b/, /\bmois\b/])) {
    signals.push("timeline_shared");
  }
  if (includesAny(latestText, [/\bbudget\b/, /\bmad\b/, /\bdh\b/, /\beur\b/, /\busd\b/, /\bmax\b/])) {
    signals.push("budget_shared");
  }
  if (includesAny(latestText, [/\bcher\b/, /\bexpensive\b/, /\btoo much\b/, /\bpas possible\b/, /\bnot possible\b/])) {
    signals.push("objection_price");
  }
  if (includesAny(latestText, [/\barnaque\b/, /\bscam\b/, /\btrust\b/, /\bfiable\b/, /\bproof\b/])) {
    signals.push("objection_trust");
  }
  if (includesAny(latestText, [/\bje prends\b/, /\bi take it\b/, /\bcommande\b/, /\border\b/, /\bgo ahead\b/])) {
    signals.push("purchase_intent");
  }
  if (includesAny(latestText, [/\bje réfléchis\b/, /\bnot sure\b/, /\bmaybe\b/, /\bpeut[- ]?être\b/])) {
    signals.push("hesitation");
  }
  if (includesAny(latestText, [/\bpay\b/, /\bpayment\b/, /\bdeposit\b/, /\bacompte\b/, /\blink\b/, /\bcheckout\b/])) {
    signals.push("ready_to_buy");
  }
  return uniq(signals);
}

function inferMissingInformation(lead: WhatsAppLeadRecord): DynamicMissingInformation[] {
  const missing: DynamicMissingInformation[] = [];
  if (!String(lead.eventDate || "").trim()) missing.push("event_date");
  if (!String(lead.shipCountry || "").trim()) missing.push("destination_country");
  if (!String(lead.shipCity || "").trim()) missing.push("destination_city");
  if (!String(lead.productReference || "").trim()) missing.push("product_reference");
  return missing;
}

function evaluateDecision(lead: WhatsAppLeadRecord, messages: WhatsAppLeadMessage[]): DynamicDecision {
  const safeMessages = Array.isArray(messages) ? messages : [];
  const latest = safeMessages[safeMessages.length - 1] || null;
  const latestText = normalizeText(latest?.text || "");
  const now = Date.now();

  const customerSignals = inferSignals(latestText);
  const missingInformation = inferMissingInformation(lead);
  const states: DynamicConversationState[] = [];

  const lastInbound = [...safeMessages].reverse().find((m) => m.direction === "IN") || null;
  const lastOutbound = [...safeMessages].reverse().find((m) => m.direction === "OUT") || null;
  const lastInboundTs = lastInbound ? Date.parse(lastInbound.createdAt) : NaN;
  const lastOutboundTs = lastOutbound ? Date.parse(lastOutbound.createdAt) : NaN;
  const staleWindowMs = 48 * 60 * 60 * 1000;
  const hasStalledConversation =
    Number.isFinite(lastOutboundTs) &&
    (!Number.isFinite(lastInboundTs) || lastOutboundTs > lastInboundTs) &&
    now - lastOutboundTs >= staleWindowMs;

  const eventDate = parseDate(lead.eventDate);
  const daysToEvent = eventDate ? Math.round((eventDate.getTime() - now) / (24 * 60 * 60 * 1000)) : null;
  const urgencyDetected =
    customerSignals.includes("timeline_shared") &&
    ((daysToEvent != null && daysToEvent <= 21) || includesAny(latestText, [/\burgent\b/, /\basap\b/, /\bvite\b/]));

  const objectionActive = customerSignals.includes("objection_price") || customerSignals.includes("objection_trust");
  const deliveryConcern = customerSignals.includes("delivery_question");
  const depositLikely = customerSignals.includes("ready_to_buy");
  const readyForConversion = customerSignals.includes("purchase_intent") || depositLikely;
  const availabilityCheckNeeded = customerSignals.includes("availability_request");

  if (availabilityCheckNeeded) states.push("availability_check_needed");
  if (urgencyDetected) states.push("urgency_detected");
  if (objectionActive) states.push("objection_active");
  if (deliveryConcern) states.push("delivery_concern");
  if (customerSignals.includes("hesitation")) states.push("hesitation_detected");
  if (customerSignals.includes("price_request")) states.push("pricing_appropriate");
  if (readyForConversion) states.push("ready_for_conversion");
  if (depositLikely) states.push("deposit_likely");
  if (hasStalledConversation) states.push("stalled_conversation");
  if (customerSignals.includes("purchase_intent") || customerSignals.includes("ready_to_buy")) {
    states.push("active_purchase_window");
  }

  let recommendedNextAction: DynamicRecommendedNextAction = "answer_and_qualify_lightly";
  let confidence = 0.62;
  let reasoningShort = "Balanced response with lightweight qualification.";

  if (availabilityCheckNeeded) {
    recommendedNextAction = "availability_request";
    confidence = 0.83;
    reasoningShort = "Client explicitly asks availability; confirm feasibility before deeper push.";
  } else if (readyForConversion && !objectionActive) {
    recommendedNextAction = "propose_next_step";
    confidence = 0.86;
    reasoningShort = "Strong purchase intent; move to concrete next step.";
  } else if (depositLikely) {
    recommendedNextAction = "push_softly_to_deposit";
    confidence = 0.81;
    reasoningShort = "Payment/deposit signal detected; gentle conversion step is appropriate.";
  } else if (objectionActive) {
    recommendedNextAction = "reassure";
    confidence = 0.82;
    reasoningShort = "Active objection detected; reassurance should precede progression.";
  } else if (customerSignals.includes("price_request")) {
    const priceBlocked = !lead.productReference && !lead.priceSent;
    if (priceBlocked) {
      recommendedNextAction = "answer_and_qualify_lightly";
      confidence = 0.71;
      reasoningShort = "Price requested; answer with context while collecting one key qualifier.";
    } else {
      recommendedNextAction = "provide_contextual_price";
      confidence = 0.78;
      reasoningShort = "Price context can be provided safely from current lead context.";
    }
  } else if (hasStalledConversation) {
    recommendedNextAction = "reactivate_gently";
    confidence = 0.79;
    reasoningShort = "Conversation is stale after outbound follow-up; gentle reactivation fits.";
  } else if (deliveryConcern) {
    recommendedNextAction = "answer_directly";
    confidence = 0.76;
    reasoningShort = "Delivery concern is explicit; direct answer should come first.";
  } else if (missingInformation.length > 0 && latest?.direction === "IN") {
    const hasImmediateAction =
      customerSignals.includes("price_request") ||
      customerSignals.includes("availability_request") ||
      customerSignals.includes("delivery_question");
    if (!hasImmediateAction) {
      recommendedNextAction = "ask_one_key_question";
      confidence = 0.68;
      reasoningShort = "No strong immediate intent; ask one key question to advance conversation.";
    }
  }

  const blockersForNextAction =
    recommendedNextAction === "propose_next_step" &&
    (missingInformation.includes("event_date") || missingInformation.includes("destination_country"));
  if (blockersForNextAction) {
    states.push("qualification_incomplete");
    recommendedNextAction = "ask_one_key_question";
    confidence = Math.max(0.66, confidence - 0.08);
    reasoningShort = "Next commercial step is blocked by missing critical logistics.";
  }

  return {
    conversation_state: uniq(states),
    missing_information: uniq(missingInformation),
    customer_signals: uniq(customerSignals),
    recommended_next_action: recommendedNextAction,
    confidence: Math.max(0.2, Math.min(0.95, Number(confidence.toFixed(2)))),
    reasoning_short: reasoningShort
  };
}

export async function runDynamicDecisionShadowForMessage(input: {
  leadId: string;
  messageId: string;
  source: "OUTBOUND_TEMPLATE" | "OUTBOUND_MANUAL" | "OUTBOUND_SUGGESTION" | "INBOUND" | "SYSTEM" | "SYSTEM_BACKFILL";
  triggerSource?: string;
}): Promise<DynamicDecision | null> {
  if (!isEnabled()) return null;
  const leadId = String(input.leadId || "").trim();
  const messageId = String(input.messageId || "").trim();
  if (!leadId || !messageId) return null;

  const alreadyEvaluated = await hasMlInferenceEventForMessage({
    leadId,
    messageId,
    modelKey: DYNAMIC_DECISION_MODEL_KEY
  });
  if (alreadyEvaluated) return null;

  const lead = await getWhatsAppLeadById(leadId);
  if (!lead) return null;
  const messages = await listWhatsAppLeadMessages(leadId, { limit: 30, order: "asc" });
  if (!messages.length) return null;

  const decision = evaluateDecision(lead, messages);
  await createMlEvent({
    eventType: "INFERENCE",
    modelKey: DYNAMIC_DECISION_MODEL_KEY,
    leadId,
    source: input.source,
    payload: {
      type: "dynamic_decision",
      shadow_mode: true,
      version: "v1",
      lead_id: leadId,
      message_id: messageId,
      trigger_source: String(input.triggerSource || "message_persisted"),
      evaluated_at: new Date().toISOString(),
      decision
    }
  });
  return decision;
}
