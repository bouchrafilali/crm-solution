import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { getDbPool } from "./client.js";
import { inferIsoCountryFromPhone } from "../services/phoneCountry.js";
import { upsertLeadConversionMetrics } from "./leadConversionMetricsRepo.js";
import { computeConversionScore } from "../services/conversionScore.js";
import { runAuto24hFollowupRuleForLead } from "../services/autoFollowUpRule.js";
import { inferTicketValueForLead } from "../services/ticketValueInference.js";
import { recomputeLeadSla, recomputeSlaForPriorityLeads, type SlaStatus } from "../services/slaPrioritization.js";

export const WHATSAPP_LEAD_STAGES = [
  "NEW",
  "PRODUCT_INTEREST",
  "QUALIFICATION_PENDING",
  "QUALIFIED",
  "PRICE_SENT",
  "VIDEO_PROPOSED",
  "DEPOSIT_PENDING",
  "CONFIRMED",
  "CONVERTED",
  "LOST"
] as const;

export type WhatsAppLeadStage = (typeof WHATSAPP_LEAD_STAGES)[number];
export type WhatsAppIntentLevel = "LOW" | "MEDIUM" | "HIGH";
export type WhatsAppDirection = "IN" | "OUT";
export type WhatsAppChannelType = "API" | "SHARED";
export type WhatsAppAiMode = "ACTIVE" | "ANALYZE_ONLY";

export type WhatsAppLeadRecord = {
  id: string;
  clientName: string;
  phoneNumber: string;
  isTest: boolean;
  testTag: string | null;
  profileImageUrl: string | null;
  channelType: WhatsAppChannelType;
  aiMode: WhatsAppAiMode;
  country: string | null;
  inquirySource: string | null;
  productReference: string | null;
  priceSent: boolean;
  productionTimeSent: boolean;
  stage: WhatsAppLeadStage;
  firstResponseTimeMinutes: number | null;
  lastActivityAt: string | null;
  internalNotes: string | null;
  qualificationTags: string[];
  intentLevel: WhatsAppIntentLevel | null;
  stageConfidence: number | null;
  stageAuto: boolean;
  stageAutoReason: string | null;
  stageAutoSourceMessageId: string | null;
  stageAutoConfidence: number | null;
  stageAutoUpdatedAt: string | null;
  recommendedStage: WhatsAppLeadStage | null;
  recommendedStageReason: string | null;
  recommendedStageConfidence: number | null;
  detectedSignals: WhatsAppDetectedSignals;
  conversionValue: number | null;
  ticketValue: number | null;
  ticketCurrency: "USD" | "EUR" | "MAD" | null;
  conversionScore: number | null;
  slaDueAt: string | null;
  slaStatus: SlaStatus;
  convertedAt?: string | null;
  conversionSource?: string | null;
  shopifyOrderId: string | null;
  shopifyFinancialStatus: string | null;
  paymentReceived: boolean;
  depositPaid: boolean;
  marketingOptIn: boolean;
  marketingOptInSource: string | null;
  marketingOptInAt: string | null;
  eventDate: string | null;
  eventDateText: string | null;
  eventDateConfidence: number | null;
  eventDateSourceMessageId: string | null;
  eventDateUpdatedAt: string | null;
  eventDateManual: boolean;
  shipCity: string | null;
  shipRegion: string | null;
  shipCountry: string | null;
  shipDestinationText: string | null;
  shipDestinationConfidence: number | null;
  shipDestinationSourceMessageId: string | null;
  shipDestinationUpdatedAt: string | null;
  shipDestinationManual: boolean;
  hasProductInterest: boolean;
  hasPriceSent: boolean;
  hasVideoProposed: boolean;
  hasPaymentQuestion: boolean;
  hasDepositLinkSent: boolean;
  chatConfirmed: boolean;
  priceIntent: boolean;
  videoIntent: boolean;
  paymentIntent: boolean;
  depositIntent: boolean;
  confirmationIntent: boolean;
  lastSignalAt: string | null;
  productInterestSourceMessageId: string | null;
  priceSentSourceMessageId: string | null;
  videoProposedSourceMessageId: string | null;
  paymentQuestionSourceMessageId: string | null;
  depositLinkSourceMessageId: string | null;
  chatConfirmedSourceMessageId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WhatsAppRuleTriggered = {
  rule: string;
  details: string;
};

export type WhatsAppSignalEvidence = {
  tag: string;
  match: string;
  message_id: string;
  created_at: string;
};

export type WhatsAppDetectedSignals = {
  tags: string[];
  rules_triggered: WhatsAppRuleTriggered[];
  evidence: WhatsAppSignalEvidence[];
  quote_approval?: {
    quote_request_id?: string;
    stage_recommendation?: "PRICE_APPROVED_READY_TO_SEND" | "PRICE_EDIT_REQUIRED";
    product?: {
      handle?: string;
      title?: string;
      image_url?: string | null;
    };
    production_mode?: "MADE_TO_ORDER" | "READY_PIECE";
    delivery_type?: "IMMEDIATE" | "STANDARD";
    price?: {
      approved?: boolean;
      approved_amount?: number | null;
      approved_currency?: "USD" | "EUR" | "MAD" | null;
      option_id?: string | null;
      source?: string;
    };
    approved_at?: string;
  };
  ai_suggestion?: {
    reason?: string;
    next_question?: string;
    confidence?: number;
    recommended_stage?: WhatsAppLeadStage;
    evaluated_at?: string;
  };
};

export type WhatsAppLeadMessage = {
  id: string;
  leadId: string;
  direction: WhatsAppDirection;
  text: string;
  provider: string;
  messageType: string;
  templateName: string | null;
  externalId: string | null;
  metadata: Record<string, unknown> | null;
  replyTo?: {
    id: string;
    senderName: string;
    text: string;
  } | null;
  createdAt: string;
};

export type WhatsAppLeadSessionStatus = {
  isSessionOpen: boolean;
  expiresAt: string | null;
};

export type WhatsAppLeadEvent = {
  id: number;
  leadId: string;
  eventType: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
};

export type WhatsAppMetrics = {
  totalInquiries: number;
  conversionRate: number;
  avgResponseTime: number;
  avgResponseTimeMinutes: number;
  activeLeads: number;
  leadsAtRisk: number;
  fastResponsePct: number;
  slowResponsePct: number;
  conversionFastPct: number;
  conversionSlowPct: number;
  stageDistribution: Record<WhatsAppLeadStage, number>;
};

export type WhatsAppLeadRisk = {
  isAtRisk: boolean;
  hoursSinceLastActivity: number;
  thresholdHours: number;
};

export type WhatsAppScoreBreakdownItem = {
  label: string;
  points: number;
};

export type WhatsAppConversionBand = "LOW" | "MEDIUM" | "HIGH";

export type WhatsAppConversionProbability = {
  probability: number;
  band: WhatsAppConversionBand;
  reasons: string[];
};

export type WhatsAppTopLead = WhatsAppLeadRecord & {
  score: number;
  scoreBreakdown: WhatsAppScoreBreakdownItem[];
  risk: WhatsAppLeadRisk;
  conversionProbability: WhatsAppConversionProbability;
};

export type WhatsAppPriorityLead = {
  id: string;
  clientName: string;
  country: string | null;
  stage: WhatsAppLeadStage;
  conversionScore: number;
  eventDate: string | null;
  daysSinceLastMessage: number | null;
  ticketValue: number | null;
  ticketCurrency: "USD" | "EUR" | "MAD" | null;
  slaStatus: SlaStatus;
  slaDueAt: string | null;
  riskFlag: boolean;
  lastMessageAt: string | null;
};

export type YesterdayBriefStats = {
  newInquiries: number;
  yesterdayInquiries: number;
  avgResponseTimeMinutes: number;
  conversions: number;
  leadsAtRisk: number;
  priceSentCount: number;
  noResponseCount: number;
  dropOffCount: number;
};

// Backward compatibility exports
export type WhatsAppBriefStats = YesterdayBriefStats;
export type WhatsAppFollowUpKind = "48h" | "72h";
export type WhatsAppFollowUpCandidate = {
  id: string;
  shop?: string | null;
  clientName: string;
  phoneNumber: string;
  country: string | null;
  productReference: string | null;
  stage: WhatsAppLeadStage;
  lastMessageAt: string | null;
  followUp48Sent: boolean;
  followUp72Sent: boolean;
};

type LeadRow = {
  id: string;
  client_name: string;
  phone_number: string;
  is_test?: boolean | null;
  test_tag?: string | null;
  profile_image_url?: string | null;
  channel_type?: string | null;
  ai_mode?: string | null;
  country: string | null;
  inquiry_source: string | null;
  product_reference: string | null;
  price_sent: boolean;
  production_time_sent: boolean;
  stage: string;
  first_response_time_minutes: number | null;
  last_activity_at: string | null;
  internal_notes: string | null;
  qualification_tags: string[] | null;
  intent_level: string | null;
  stage_confidence: string | number | null;
  stage_auto: boolean;
  stage_auto_reason: string | null;
  stage_auto_source_message_id?: string | null;
  stage_auto_confidence?: number | string | null;
  stage_auto_updated_at?: string | null;
  recommended_stage: string | null;
  recommended_stage_reason: string | null;
  recommended_stage_confidence: string | number | null;
  detected_signals: unknown;
  conversion_value: string | number | null;
  ticket_value?: string | number | null;
  ticket_currency?: string | null;
  conversion_score?: number | string | null;
  sla_due_at?: string | null;
  sla_status?: string | null;
  converted_at?: string | null;
  conversion_source?: string | null;
  shopify_order_id?: string | null;
  shopify_financial_status?: string | null;
  payment_received?: boolean | null;
  deposit_paid?: boolean | null;
  marketing_opt_in?: boolean | null;
  marketing_opt_in_source?: string | null;
  marketing_opt_in_at?: string | null;
  event_date?: string | null;
  event_date_text?: string | null;
  event_date_confidence?: number | string | null;
  event_date_source_message_id?: string | null;
  event_date_updated_at?: string | null;
  event_date_manual?: boolean | null;
  ship_city?: string | null;
  ship_region?: string | null;
  ship_country?: string | null;
  ship_destination_text?: string | null;
  ship_destination_confidence?: number | string | null;
  ship_destination_source_message_id?: string | null;
  ship_destination_updated_at?: string | null;
  ship_destination_manual?: boolean | null;
  has_product_interest?: boolean | null;
  has_price_sent?: boolean | null;
  has_video_proposed?: boolean | null;
  has_payment_question?: boolean | null;
  has_deposit_link_sent?: boolean | null;
  chat_confirmed?: boolean | null;
  price_intent?: boolean | null;
  video_intent?: boolean | null;
  payment_intent?: boolean | null;
  deposit_intent?: boolean | null;
  confirmation_intent?: boolean | null;
  last_signal_at?: string | null;
  product_interest_source_message_id?: string | null;
  price_sent_source_message_id?: string | null;
  video_proposed_source_message_id?: string | null;
  payment_question_source_message_id?: string | null;
  deposit_link_source_message_id?: string | null;
  chat_confirmed_source_message_id?: string | null;
  created_at: string;
  updated_at: string;
};

export type WhatsAppInboundMessageSnippet = {
  id: string;
  text: string;
  createdAt: string;
};

export type WhatsAppMessageSnippet = {
  id: string;
  leadId: string;
  direction: WhatsAppDirection;
  text: string;
  createdAt: string;
};

export type WhatsAppConversionMatchInput = {
  phoneNumber?: string | null;
  clientName?: string | null;
  country?: string | null;
};

export type WhatsAppConversionMatchResult = {
  id: string;
  stage: WhatsAppLeadStage;
  clientName: string;
  country: string | null;
};

export type WhatsAppOrderConversionResult =
  | { status: "not_found" }
  | { status: "already_converted"; lead: WhatsAppConversionMatchResult }
  | { status: "converted"; lead: WhatsAppConversionMatchResult };

type MetricsRow = {
  total_inquiries: string | number;
  converted_count: string | number;
  avg_response_time: string | number | null;
  active_leads: string | number;
  leads_at_risk: string | number;
  responded_count: string | number;
  fast_response_count: string | number;
  slow_response_count: string | number;
  converted_fast_count: string | number;
  converted_slow_count: string | number;
  st_new: string | number;
  st_product_interest: string | number;
  st_qualification_pending: string | number;
  st_price_sent: string | number;
  st_qualified: string | number;
  st_video_proposed: string | number;
  st_deposit_pending: string | number;
  st_confirmed: string | number;
  st_converted: string | number;
  st_lost: string | number;
};

function getPoolOrThrow(): Pool {
  const db = getDbPool();
  if (!db) throw new Error("DATABASE_URL is not configured");
  return db;
}

function toNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizeStage(input: unknown): WhatsAppLeadStage {
  const stage = String(input || "").trim().toUpperCase();
  if ((WHATSAPP_LEAD_STAGES as readonly string[]).includes(stage)) {
    return stage as WhatsAppLeadStage;
  }
  return "NEW";
}

function normalizeIntent(input: unknown): WhatsAppIntentLevel | null {
  const raw = String(input || "").trim().toUpperCase();
  if (raw === "LOW" || raw === "MEDIUM" || raw === "HIGH") return raw;
  return null;
}

function normalizeChannelType(input: unknown): WhatsAppChannelType {
  const raw = String(input || "").trim().toUpperCase();
  return raw === "SHARED" ? "SHARED" : "API";
}

function normalizeAiMode(input: unknown, channelType: WhatsAppChannelType): WhatsAppAiMode {
  if (channelType === "SHARED") return "ANALYZE_ONLY";
  const raw = String(input || "").trim().toUpperCase();
  return raw === "ANALYZE_ONLY" ? "ANALYZE_ONLY" : "ACTIVE";
}

function normalizeDetectedSignals(input: unknown): WhatsAppDetectedSignals {
  const fallback: WhatsAppDetectedSignals = {
    tags: [],
    rules_triggered: [],
    evidence: []
  };
  if (!input || typeof input !== "object") return fallback;
  const value = input as Record<string, unknown>;
  const tags = Array.isArray(value.tags) ? value.tags.map((v) => String(v || "").trim()).filter(Boolean) : [];
  const rules = Array.isArray(value.rules_triggered)
    ? value.rules_triggered
        .map((rule) => {
          if (!rule || typeof rule !== "object") return null;
          const item = rule as Record<string, unknown>;
          const name = String(item.rule || "").trim();
          const details = String(item.details || "").trim();
          if (!name || !details) return null;
          return { rule: name, details };
        })
        .filter(Boolean) as WhatsAppRuleTriggered[]
    : [];
  const evidence = Array.isArray(value.evidence)
    ? value.evidence
        .map((entry) => {
          if (!entry || typeof entry !== "object") return null;
          const item = entry as Record<string, unknown>;
          const tag = String(item.tag || "").trim();
          const match = String(item.match || "").trim();
          const message_id = String(item.message_id || "").trim();
          const created_at = String(item.created_at || "").trim();
          if (!tag || !match) return null;
          return { tag, match, message_id, created_at };
        })
        .filter(Boolean) as WhatsAppSignalEvidence[]
    : [];
  const aiSuggestion =
    value.ai_suggestion && typeof value.ai_suggestion === "object"
      ? (() => {
          const ai = value.ai_suggestion as Record<string, unknown>;
          const suggestedStage = normalizeStage(ai.recommended_stage);
          return {
            reason: ai.reason ? String(ai.reason) : undefined,
            next_question: ai.next_question ? String(ai.next_question) : undefined,
            confidence: ai.confidence == null ? undefined : round2(toNumber(ai.confidence)),
            recommended_stage: ai.recommended_stage == null ? undefined : suggestedStage,
            evaluated_at: ai.evaluated_at ? String(ai.evaluated_at) : undefined
          };
        })()
      : undefined;
  const quoteApproval =
    value.quote_approval && typeof value.quote_approval === "object"
      ? (() => {
          const qa = value.quote_approval as Record<string, unknown>;
          const qaProduct = qa.product && typeof qa.product === "object" ? (qa.product as Record<string, unknown>) : null;
          const qaPrice = qa.price && typeof qa.price === "object" ? (qa.price as Record<string, unknown>) : null;
          const approvedCurrencyRaw = String(qaPrice?.approved_currency || "").trim().toUpperCase();
          const approvedCurrency =
            approvedCurrencyRaw === "USD" || approvedCurrencyRaw === "EUR" || approvedCurrencyRaw === "MAD"
              ? (approvedCurrencyRaw as "USD" | "EUR" | "MAD")
              : null;
          return {
            quote_request_id: qa.quote_request_id ? String(qa.quote_request_id) : undefined,
            stage_recommendation:
              qa.stage_recommendation === "PRICE_APPROVED_READY_TO_SEND" || qa.stage_recommendation === "PRICE_EDIT_REQUIRED"
                ? (qa.stage_recommendation as "PRICE_APPROVED_READY_TO_SEND" | "PRICE_EDIT_REQUIRED")
                : undefined,
            product: qaProduct
              ? {
                  handle: qaProduct.handle ? String(qaProduct.handle) : undefined,
                  title: qaProduct.title ? String(qaProduct.title) : undefined,
                  image_url: qaProduct.image_url ? String(qaProduct.image_url) : null
                }
              : undefined,
            production_mode:
              qa.production_mode === "MADE_TO_ORDER" || qa.production_mode === "READY_PIECE"
                ? (qa.production_mode as "MADE_TO_ORDER" | "READY_PIECE")
                : undefined,
            delivery_type:
              qa.delivery_type === "IMMEDIATE" || qa.delivery_type === "STANDARD"
                ? (qa.delivery_type as "IMMEDIATE" | "STANDARD")
                : undefined,
            price: qaPrice
              ? {
                  approved: qaPrice.approved == null ? undefined : Boolean(qaPrice.approved),
                  approved_amount:
                    qaPrice.approved_amount == null ? null : round2(toNumber(qaPrice.approved_amount, 0)),
                  approved_currency: approvedCurrency,
                  option_id: qaPrice.option_id ? String(qaPrice.option_id) : null,
                  source: qaPrice.source ? String(qaPrice.source) : undefined
                }
              : undefined,
            approved_at: qa.approved_at ? String(qa.approved_at) : undefined
          };
        })()
      : undefined;
  return {
    tags,
    rules_triggered: rules,
    evidence,
    ...(quoteApproval ? { quote_approval: quoteApproval } : {}),
    ...(aiSuggestion ? { ai_suggestion: aiSuggestion } : {})
  };
}

function normalizePhone(raw: string | null | undefined): string {
  const value = String(raw || "").trim();
  if (!value) return "";
  const digits = value.replace(/[^\d]/g, "");
  return digits || value;
}

function normalizeCountry(raw: string | null | undefined): string {
  return String(raw || "").trim().toUpperCase();
}

function normalizeName(raw: string | null | undefined): string {
  return String(raw || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function computeRisk(lastActivityAt: string | null, createdAt: string, stage: WhatsAppLeadStage): WhatsAppLeadRisk {
  const thresholdHours = 48;
  const pivot = new Date(lastActivityAt || createdAt).getTime();
  const hours = Number.isFinite(pivot) ? Math.max(0, (Date.now() - pivot) / 3600000) : 0;
  const candidate =
    stage === "PRODUCT_INTEREST" ||
    stage === "QUALIFICATION_PENDING" ||
    stage === "PRICE_SENT" ||
    stage === "QUALIFIED" ||
    stage === "VIDEO_PROPOSED" ||
    stage === "DEPOSIT_PENDING" ||
    stage === "CONFIRMED";
  return {
    isAtRisk: candidate && hours >= thresholdHours,
    hoursSinceLastActivity: round2(hours),
    thresholdHours
  };
}

function computeLeadScore(lead: WhatsAppLeadRecord): { score: number; scoreBreakdown: WhatsAppScoreBreakdownItem[] } {
  const points: WhatsAppScoreBreakdownItem[] = [];
  const stagePoints: Record<WhatsAppLeadStage, number> = {
    NEW: 15,
    PRODUCT_INTEREST: 35,
    QUALIFICATION_PENDING: 45,
    QUALIFIED: 60,
    PRICE_SENT: 70,
    VIDEO_PROPOSED: 70,
    DEPOSIT_PENDING: 85,
    CONFIRMED: 92,
    CONVERTED: 100,
    LOST: 0
  };
  points.push({ label: `Stage ${lead.stage}`, points: stagePoints[lead.stage] });

  const response = Number(lead.firstResponseTimeMinutes || 0);
  if (response > 0 && response < 15) points.push({ label: "Response < 15 min", points: 15 });

  const hoursSinceLast = computeRisk(lead.lastActivityAt, lead.createdAt, lead.stage).hoursSinceLastActivity;
  if (hoursSinceLast < 24) points.push({ label: "Last activity < 24h", points: 8 });
  if (hoursSinceLast > 72) points.push({ label: "Last activity > 72h", points: -15 });

  const country = String(lead.country || "").trim().toUpperCase();
  if (country && country !== "MA") points.push({ label: "International country", points: 10 });

  const signalTags = new Set<string>([
    ...(lead.qualificationTags || []).map((tag) => String(tag || "").toUpperCase()),
    ...((Array.isArray(lead.detectedSignals?.tags) ? lead.detectedSignals.tags : []).map((tag) => String(tag || "").toUpperCase()))
  ]);
  if (signalTags.has("EVENT_DATE")) points.push({ label: "Signal EVENT_DATE", points: 10 });
  if (signalTags.has("SIZING")) points.push({ label: "Signal SIZING", points: 10 });
  if (signalTags.has("SHIPPING") || signalTags.has("INTERNATIONAL")) points.push({ label: "Signal SHIPPING", points: 8 });
  if (lead.priceIntent) points.push({ label: "Price intent", points: 15 });
  if (lead.depositIntent) points.push({ label: "Deposit intent", points: 25 });
  if (lead.confirmationIntent) points.push({ label: "Confirmation intent", points: 40 });

  return {
    score: points.reduce((sum, item) => sum + item.points, 0),
    scoreBreakdown: points
  };
}

function computeConversionProbability(lead: WhatsAppLeadRecord): WhatsAppConversionProbability {
  const points: Array<{ label: string; value: number; reason?: string }> = [];
  const stagePoints: Record<WhatsAppLeadStage, number> = {
    NEW: 10,
    PRODUCT_INTEREST: 25,
    QUALIFICATION_PENDING: 35,
    QUALIFIED: 55,
    PRICE_SENT: 65,
    VIDEO_PROPOSED: 65,
    DEPOSIT_PENDING: 80,
    CONFIRMED: 90,
    CONVERTED: 100,
    LOST: 0
  };
  points.push({ label: `Stage ${lead.stage}`, value: stagePoints[lead.stage] });

  const tags = new Set<string>([
    ...(lead.qualificationTags || []).map((tag) => String(tag || "").toUpperCase()),
    ...((Array.isArray(lead.detectedSignals?.tags) ? lead.detectedSignals.tags : []).map((tag) => String(tag || "").toUpperCase()))
  ]);

  const country = String(lead.country || "").trim().toUpperCase();
  const hoursSinceLast = computeRisk(lead.lastActivityAt, lead.createdAt, lead.stage).hoursSinceLastActivity;
  const responseMinutes = Number(lead.firstResponseTimeMinutes || 0);

  if (tags.has("URGENT_TIMELINE")) {
    points.push({ label: "Urgency HIGH", value: 15, reason: "Urgence élevée (événement proche)" });
  }
  if (country && country !== "MA") {
    points.push({ label: "International", value: 10, reason: "Demande internationale" });
  }
  if (tags.has("EVENT_DATE")) {
    points.push({ label: "Event date detected", value: 10, reason: "Date d'événement identifiée" });
  }
  if (tags.has("SIZING")) {
    points.push({ label: "Sizing signal", value: 8, reason: "Informations de taille fournies" });
  }
  if (tags.has("RESERVATION_INTENT") || tags.has("DEPOSIT_INTENT")) {
    points.push({ label: "Reservation intent", value: 12, reason: "Intention de réservation détectée" });
  }
  if (hoursSinceLast > 72) {
    points.push({ label: "No reply > 72h", value: -20, reason: "Inactif depuis plus de 72h" });
  } else if (hoursSinceLast > 48) {
    points.push({ label: "No reply > 48h", value: -10, reason: "Inactif depuis plus de 48h" });
  }
  if (responseMinutes > 0 && responseMinutes <= 15) {
    points.push({ label: "First response <= 15m", value: 10, reason: "Réponse initiale rapide" });
  } else if (responseMinutes > 60) {
    points.push({ label: "First response > 60m", value: -10, reason: "Réponse initiale lente (>1h)" });
  }
  if (
    lead.priceSent &&
    (lead.stage === "NEW" || lead.stage === "PRODUCT_INTEREST" || lead.stage === "QUALIFICATION_PENDING")
  ) {
    points.push({ label: "Price shared too early", value: -8, reason: "Prix envoyé avant qualification complète" });
  }

  const raw = points.reduce((sum, item) => sum + item.value, 0);
  const probability = Math.max(0, Math.min(100, Math.round(raw)));
  const band: WhatsAppConversionBand = probability >= 70 ? "HIGH" : probability >= 35 ? "MEDIUM" : "LOW";
  const reasons = points
    .filter((item) => item.reason)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .slice(0, 3)
    .map((item) => String(item.reason));

  return { probability, band, reasons };
}

function mapLead(row: LeadRow): WhatsAppLeadRecord {
  const inferredCountry = inferIsoCountryFromPhone(row.phone_number);
  const country = String(row.country || "").trim().toUpperCase() || inferredCountry || null;
  const channelType = normalizeChannelType(row.channel_type);
  return {
    id: row.id,
    clientName: row.client_name,
    phoneNumber: row.phone_number,
    isTest: Boolean(row.is_test),
    testTag: row.test_tag || null,
    profileImageUrl: row.profile_image_url || null,
    channelType,
    aiMode: normalizeAiMode(row.ai_mode, channelType),
    country,
    inquirySource: row.inquiry_source,
    productReference: row.product_reference,
    priceSent: Boolean(row.price_sent),
    productionTimeSent: Boolean(row.production_time_sent),
    stage: normalizeStage(row.stage),
    firstResponseTimeMinutes:
      row.first_response_time_minutes == null ? null : Math.max(0, Math.round(toNumber(row.first_response_time_minutes))),
    lastActivityAt: row.last_activity_at,
    internalNotes: row.internal_notes,
    qualificationTags: Array.isArray(row.qualification_tags) ? row.qualification_tags.filter(Boolean) : [],
    intentLevel: normalizeIntent(row.intent_level),
    stageConfidence: row.stage_confidence == null ? null : round2(toNumber(row.stage_confidence)),
    stageAuto: Boolean(row.stage_auto),
    stageAutoReason: row.stage_auto_reason,
    stageAutoSourceMessageId: row.stage_auto_source_message_id || null,
    stageAutoConfidence: row.stage_auto_confidence == null ? null : round2(toNumber(row.stage_auto_confidence)),
    stageAutoUpdatedAt: row.stage_auto_updated_at || null,
    recommendedStage: row.recommended_stage ? normalizeStage(row.recommended_stage) : null,
    recommendedStageReason: row.recommended_stage_reason,
    recommendedStageConfidence:
      row.recommended_stage_confidence == null ? null : round2(toNumber(row.recommended_stage_confidence)),
    detectedSignals: normalizeDetectedSignals(row.detected_signals),
    conversionValue: row.conversion_value == null ? null : toNumber(row.conversion_value),
    ticketValue: row.ticket_value == null ? null : toNumber(row.ticket_value),
    ticketCurrency:
      String(row.ticket_currency || "").toUpperCase() === "USD"
        ? "USD"
        : String(row.ticket_currency || "").toUpperCase() === "EUR"
          ? "EUR"
          : String(row.ticket_currency || "").toUpperCase() === "MAD"
            ? "MAD"
            : null,
    conversionScore: row.conversion_score == null ? null : Math.max(0, Math.min(100, Math.round(toNumber(row.conversion_score)))),
    slaDueAt: row.sla_due_at || null,
    slaStatus:
      String(row.sla_status || "").toUpperCase() === "DUE_SOON"
        ? "DUE_SOON"
        : String(row.sla_status || "").toUpperCase() === "BREACHED"
          ? "BREACHED"
          : "OK",
    convertedAt: row.converted_at || null,
    conversionSource: row.conversion_source || null,
    shopifyOrderId: row.shopify_order_id || null,
    shopifyFinancialStatus: row.shopify_financial_status || null,
    paymentReceived: Boolean(row.payment_received),
    depositPaid: Boolean(row.deposit_paid),
    marketingOptIn: Boolean(row.marketing_opt_in),
    marketingOptInSource: row.marketing_opt_in_source || null,
    marketingOptInAt: row.marketing_opt_in_at || null,
    eventDate: row.event_date || null,
    eventDateText: row.event_date_text || null,
    eventDateConfidence: row.event_date_confidence == null ? null : Math.max(0, Math.min(100, Math.round(toNumber(row.event_date_confidence)))),
    eventDateSourceMessageId: row.event_date_source_message_id || null,
    eventDateUpdatedAt: row.event_date_updated_at || null,
    eventDateManual: Boolean(row.event_date_manual),
    shipCity: row.ship_city || null,
    shipRegion: row.ship_region || null,
    shipCountry: row.ship_country || null,
    shipDestinationText: row.ship_destination_text || null,
    shipDestinationConfidence:
      row.ship_destination_confidence == null
        ? null
        : Math.max(0, Math.min(100, Math.round(toNumber(row.ship_destination_confidence)))),
    shipDestinationSourceMessageId: row.ship_destination_source_message_id || null,
    shipDestinationUpdatedAt: row.ship_destination_updated_at || null,
    shipDestinationManual: Boolean(row.ship_destination_manual),
    hasProductInterest: Boolean(row.has_product_interest),
    hasPriceSent: Boolean(row.has_price_sent),
    hasVideoProposed: Boolean(row.has_video_proposed),
    hasPaymentQuestion: Boolean(row.has_payment_question),
    hasDepositLinkSent: Boolean(row.has_deposit_link_sent),
    chatConfirmed: Boolean(row.chat_confirmed),
    priceIntent: Boolean(row.price_intent),
    videoIntent: Boolean(row.video_intent),
    paymentIntent: Boolean(row.payment_intent),
    depositIntent: Boolean(row.deposit_intent),
    confirmationIntent: Boolean(row.confirmation_intent),
    lastSignalAt: row.last_signal_at || null,
    productInterestSourceMessageId: row.product_interest_source_message_id || null,
    priceSentSourceMessageId: row.price_sent_source_message_id || null,
    videoProposedSourceMessageId: row.video_proposed_source_message_id || null,
    paymentQuestionSourceMessageId: row.payment_question_source_message_id || null,
    depositLinkSourceMessageId: row.deposit_link_source_message_id || null,
    chatConfirmedSourceMessageId: row.chat_confirmed_source_message_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function matchWhatsAppLeadForConversion(input: WhatsAppConversionMatchInput): Promise<WhatsAppConversionMatchResult | null> {
  const db = getPoolOrThrow();
  const normalizedPhone = normalizePhone(input.phoneNumber);
  if (normalizedPhone) {
    const byPhone = await db.query<{
      id: string;
      stage: string;
      client_name: string;
      country: string | null;
    }>(
      `
        select id, stage, client_name, country
        from whatsapp_leads
        where regexp_replace(coalesce(phone_number, ''), '[^0-9]', '', 'g') = $1::text
        order by
          case when stage = 'CONVERTED' then 1 else 0 end asc,
          coalesce(last_activity_at, created_at) desc
        limit 1
      `,
      [normalizedPhone]
    );
    const row = byPhone.rows[0];
    if (row) {
      return {
        id: row.id,
        stage: normalizeStage(row.stage),
        clientName: row.client_name,
        country: row.country
      };
    }
  }

  const normalizedName = normalizeName(input.clientName);
  const normalizedCountry = normalizeCountry(input.country);
  if (!normalizedName || !normalizedCountry) return null;

  const byIdentity = await db.query<{
    id: string;
    stage: string;
    client_name: string;
    country: string | null;
  }>(
    `
      select id, stage, client_name, country
      from whatsapp_leads
      where lower(trim(client_name)) = $1::text
        and upper(trim(coalesce(country, ''))) = $2::text
      order by
        case when stage = 'CONVERTED' then 1 else 0 end asc,
        coalesce(last_activity_at, created_at) desc
      limit 1
    `,
    [normalizedName, normalizedCountry]
  );

  const row = byIdentity.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    stage: normalizeStage(row.stage),
    clientName: row.client_name,
    country: row.country
  };
}

export async function convertWhatsAppLeadFromShopifyOrder(input: {
  leadId: string;
  orderId?: string | null;
  orderName?: string | null;
  orderTotal?: number | null;
  shop?: string | null;
  payload?: unknown;
}): Promise<"converted" | "already_converted" | "not_found"> {
  const db = getPoolOrThrow();
  const updated = await db.query<{
    id: string;
  }>(
    `
      update whatsapp_leads
      set
        stage = 'CONVERTED',
        conversion_value = coalesce($2::numeric, conversion_value),
        converted_at = coalesce(converted_at, now()),
        conversion_source = 'shopify_webhook',
        shopify_order_id = coalesce(nullif(trim($3::text), ''), shopify_order_id),
        shopify_financial_status = 'paid',
        payment_received = true,
        deposit_paid = true,
        updated_at = now()
      where id = $1::uuid
        and stage <> 'CONVERTED'
      returning id
    `,
    [input.leadId, input.orderTotal ?? null, input.orderId ?? null]
  );

  if ((updated.rowCount || 0) === 0) {
    const existing = await db.query<{ id: string; stage: string }>(
      "select id, stage from whatsapp_leads where id = $1::uuid limit 1",
      [input.leadId]
    );
    const row = existing.rows[0];
    if (!row) return "not_found";
    return normalizeStage(row.stage) === "CONVERTED" ? "already_converted" : "not_found";
  }

  await db.query(
    `
      insert into whatsapp_lead_events (lead_id, shop, event_type, payload)
      values ($1::uuid, nullif(trim($2::text), ''), 'CONVERTED_BY_SHOPIFY_ORDER', $3::jsonb)
    `,
    [
      input.leadId,
      input.shop ?? "",
      JSON.stringify({
        source: "shopify_webhook",
        order_id: input.orderId || null,
        order_name: input.orderName || null,
        conversion_value: input.orderTotal ?? null,
        received_at: new Date().toISOString(),
        payload: input.payload ?? null
      })
    ]
  );

  return "converted";
}

export async function updateWhatsAppLeadShopifySignals(input: {
  leadId: string;
  orderId?: string | null;
  paymentReceived?: boolean;
  depositPaid?: boolean;
  financialStatus?: string | null;
  orderTotal?: number | null;
}): Promise<"updated" | "not_found"> {
  const db = getPoolOrThrow();
  const financialStatus = String(input.financialStatus || "").trim().toLowerCase();
  const isPaid = financialStatus === "paid" || financialStatus === "partially_paid";
  const shouldConvert = Boolean(isPaid || input.paymentReceived || input.depositPaid);
  const q = await db.query(
    `
      update whatsapp_leads
      set
        shopify_order_id = coalesce(nullif(trim($2::text), ''), shopify_order_id),
        shopify_financial_status = coalesce(nullif(trim($7::text), ''), shopify_financial_status),
        payment_received = coalesce($3::boolean, payment_received),
        deposit_paid = coalesce($4::boolean, deposit_paid),
        conversion_value = case
          when $5::boolean then coalesce($6::numeric, conversion_value)
          else conversion_value
        end,
        stage = case
          when $5::boolean then 'CONVERTED'::whatsapp_lead_stage
          else stage
        end,
        converted_at = case
          when $5::boolean then coalesce(converted_at, now())
          else converted_at
        end,
        conversion_source = case
          when $5::boolean then 'shopify_webhook'
          else conversion_source
        end,
        updated_at = now()
      where id = $1::uuid
    `,
    [
      input.leadId,
      input.orderId ?? null,
      input.paymentReceived == null ? null : Boolean(input.paymentReceived),
      input.depositPaid == null ? null : Boolean(input.depositPaid),
      shouldConvert,
      input.orderTotal ?? null,
      financialStatus || null
    ]
  );
  return (q.rowCount || 0) > 0 ? "updated" : "not_found";
}

export async function getWhatsAppMetrics(days: number): Promise<WhatsAppMetrics> {
  const db = getPoolOrThrow();
  const safeDays = Math.max(1, Math.min(365, Math.round(days || 30)));

  const q = await db.query<MetricsRow>(
    `
      with scoped as (
        select *
        from whatsapp_leads
        where created_at >= now() - ($1::int * interval '1 day')
          and coalesce(channel_type, 'API') in ('API', 'SHARED')
      )
      select
        count(*) as total_inquiries,
        count(*) filter (where stage = 'CONVERTED') as converted_count,
        avg(first_response_time_minutes)::numeric as avg_response_time,
        count(*) filter (where stage not in ('CONVERTED', 'LOST')) as active_leads,
        count(*) filter (
          where stage in ('PRODUCT_INTEREST', 'QUALIFICATION_PENDING', 'QUALIFIED', 'PRICE_SENT', 'VIDEO_PROPOSED', 'DEPOSIT_PENDING', 'CONFIRMED')
            and coalesce(last_activity_at, created_at) < now() - interval '48 hours'
        ) as leads_at_risk,
        count(*) filter (where first_response_time_minutes is not null) as responded_count,
        count(*) filter (where first_response_time_minutes is not null and first_response_time_minutes < 15) as fast_response_count,
        count(*) filter (where first_response_time_minutes is not null and first_response_time_minutes > 60) as slow_response_count,
        count(*) filter (where stage = 'CONVERTED' and first_response_time_minutes is not null and first_response_time_minutes < 15) as converted_fast_count,
        count(*) filter (where stage = 'CONVERTED' and first_response_time_minutes is not null and first_response_time_minutes > 60) as converted_slow_count,
        count(*) filter (where stage = 'NEW') as st_new,
        count(*) filter (where stage = 'PRODUCT_INTEREST') as st_product_interest,
        count(*) filter (where stage = 'QUALIFICATION_PENDING') as st_qualification_pending,
        count(*) filter (where stage = 'PRICE_SENT') as st_price_sent,
        count(*) filter (where stage = 'QUALIFIED') as st_qualified,
        count(*) filter (where stage = 'VIDEO_PROPOSED') as st_video_proposed,
        count(*) filter (where stage = 'DEPOSIT_PENDING') as st_deposit_pending,
        count(*) filter (where stage = 'CONFIRMED') as st_confirmed,
        count(*) filter (where stage = 'CONVERTED') as st_converted,
        count(*) filter (where stage = 'LOST') as st_lost
      from scoped
    `,
    [safeDays]
  );

  const row = q.rows[0];
  const total = toNumber(row?.total_inquiries);
  const converted = toNumber(row?.converted_count);
  const responded = toNumber(row?.responded_count);
  const fastCount = toNumber(row?.fast_response_count);
  const slowCount = toNumber(row?.slow_response_count);
  const convertedFast = toNumber(row?.converted_fast_count);
  const convertedSlow = toNumber(row?.converted_slow_count);

  return {
    totalInquiries: total,
    conversionRate: total > 0 ? round2((converted / total) * 100) : 0,
    avgResponseTime: round2(toNumber(row?.avg_response_time)),
    avgResponseTimeMinutes: round2(toNumber(row?.avg_response_time)),
    activeLeads: toNumber(row?.active_leads),
    leadsAtRisk: toNumber(row?.leads_at_risk),
    fastResponsePct: responded > 0 ? round2((fastCount / responded) * 100) : 0,
    slowResponsePct: responded > 0 ? round2((slowCount / responded) * 100) : 0,
    conversionFastPct: fastCount > 0 ? round2((convertedFast / fastCount) * 100) : 0,
    conversionSlowPct: slowCount > 0 ? round2((convertedSlow / slowCount) * 100) : 0,
    stageDistribution: {
      NEW: toNumber(row?.st_new),
      PRODUCT_INTEREST: toNumber(row?.st_product_interest),
      QUALIFICATION_PENDING: toNumber(row?.st_qualification_pending),
      PRICE_SENT: toNumber(row?.st_price_sent),
      QUALIFIED: toNumber(row?.st_qualified),
      VIDEO_PROPOSED: toNumber(row?.st_video_proposed),
      DEPOSIT_PENDING: toNumber(row?.st_deposit_pending),
      CONFIRMED: toNumber(row?.st_confirmed),
      CONVERTED: toNumber(row?.st_converted),
      LOST: toNumber(row?.st_lost)
    }
  };
}

export async function listWhatsAppLeads(options?: {
  days?: number;
  stage?: WhatsAppLeadStage | "ALL";
  limit?: number;
}): Promise<Array<WhatsAppLeadRecord & { risk: WhatsAppLeadRisk; score: number; scoreBreakdown: WhatsAppScoreBreakdownItem[]; conversionProbability: WhatsAppConversionProbability }>> {
  const db = getPoolOrThrow();
  const days = Math.max(1, Math.min(365, Math.round(options?.days || 30)));
  const limit = Math.max(1, Math.min(1000, Math.round(options?.limit || 500)));
  const stage = String(options?.stage || "ALL").trim().toUpperCase();

  const rows = await db.query<LeadRow>(
    `
      select
        *
      from whatsapp_leads
      where created_at >= now() - ($1::int * interval '1 day')
        and coalesce(channel_type, 'API') in ('API', 'SHARED')
        and ($2::text = 'ALL' or stage = $2::whatsapp_lead_stage)
      order by coalesce(last_activity_at, created_at) desc, created_at desc
      limit $3
    `,
    [days, stage, limit]
  );

  return rows.rows.map((row) => ({
    ...(() => {
      const lead = mapLead(row);
      const scored = computeLeadScore(lead);
      const conversionProbability = computeConversionProbability(lead);
      return {
        ...lead,
        risk: computeRisk(row.last_activity_at, row.created_at, normalizeStage(row.stage)),
        score: scored.score,
        scoreBreakdown: scored.scoreBreakdown,
        conversionProbability
      };
    })()
  }));
}

export async function listRecentInboundMessageTextsByLead(leadIds: string[], limitPerLead = 20): Promise<Map<string, string[]>> {
  const db = getPoolOrThrow();
  const ids = Array.from(new Set((leadIds || []).map((id) => String(id || "").trim()).filter(Boolean)));
  const out = new Map<string, string[]>();
  if (!ids.length) return out;

  const q = await db.query<{ lead_id: string; text: string }>(
    `
      with ranked as (
        select
          lead_id,
          text,
          row_number() over (partition by lead_id order by created_at desc) as rn
        from whatsapp_lead_messages
        where lead_id = any($1::uuid[])
          and direction = 'IN'
      )
      select lead_id, text
      from ranked
      where rn <= $2::int
      order by lead_id, rn asc
    `,
    [ids, Math.max(1, Math.min(100, Math.round(limitPerLead || 20)))]
  );

  q.rows.forEach((row) => {
    const leadId = String(row.lead_id || "").trim();
    if (!leadId) return;
    const text = String(row.text || "");
    const arr = out.get(leadId) || [];
    arr.push(text);
    out.set(leadId, arr);
  });

  return out;
}

export async function getWhatsAppLeadById(id: string): Promise<WhatsAppLeadRecord | null> {
  const db = getPoolOrThrow();
  const q = await db.query<LeadRow>("select * from whatsapp_leads where id = $1::uuid limit 1", [id]);
  const row = q.rows[0];
  return row ? mapLead(row) : null;
}

export async function getWhatsAppLeadByPhone(phoneNumber: string): Promise<WhatsAppLeadRecord | null> {
  const db = getPoolOrThrow();
  const normalized = String(phoneNumber || "").trim();
  if (!normalized) return null;
  const q = await db.query<LeadRow>(
    `
      select *
      from whatsapp_leads
      where phone_number = $1::text
        and coalesce(channel_type, 'API') in ('API', 'SHARED')
      order by coalesce(last_activity_at, created_at) desc, created_at desc
      limit 1
    `,
    [normalized]
  );
  const row = q.rows[0];
  return row ? mapLead(row) : null;
}

export async function touchWhatsAppLeadFromInbound(input: {
  id: string;
  clientName?: string | null;
  profileImageUrl?: string | null;
  country?: string | null;
  productReference?: string | null;
  inquirySource?: string | null;
  lastActivityAt?: string | null;
}): Promise<boolean> {
  const db = getPoolOrThrow();
  const q = await db.query(
    `
      update whatsapp_leads
      set
        client_name = coalesce(nullif(trim($2::text), ''), client_name),
        profile_image_url = coalesce(nullif(trim($3::text), ''), profile_image_url),
        country = coalesce(nullif(trim($4::text), ''), country),
        product_reference = coalesce(nullif(trim($5::text), ''), product_reference),
        inquiry_source = coalesce(nullif(trim($6::text), ''), inquiry_source),
        last_activity_at = greatest(coalesce(last_activity_at, created_at), coalesce($7::timestamptz, now())),
        updated_at = now()
      where id = $1::uuid
    `,
    [
      input.id,
      input.clientName ?? "",
      input.profileImageUrl ?? "",
      input.country ?? "",
      input.productReference ?? "",
      input.inquirySource ?? "",
      input.lastActivityAt ?? null
    ]
  );
  return (q.rowCount || 0) > 0;
}

export async function updateWhatsAppLeadStage(input: {
  id: string;
  stage: WhatsAppLeadStage;
  stageAuto?: boolean;
  stageConfidence?: number | null;
  stageAutoReason?: string | null;
  stageAutoSourceMessageId?: string | null;
  stageAutoConfidence?: number | null;
  source?: string | null;
}): Promise<boolean> {
  const db = getPoolOrThrow();
  const prev = await db.query<{ stage: string; channel_type: string | null }>(
    "select stage, channel_type from whatsapp_leads where id = $1::uuid limit 1",
    [input.id]
  );
  const previousStage = prev.rows[0] ? normalizeStage(prev.rows[0].stage) : null;
  const channelType = prev.rows[0] ? normalizeChannelType(prev.rows[0].channel_type) : "API";
  if (input.stageAuto && channelType === "SHARED") {
    throw new Error("shared_channel_auto_stage_update_forbidden");
  }
  const q = await db.query(
    `
      update whatsapp_leads
      set
        stage = $2::whatsapp_lead_stage,
        stage_auto = coalesce($3::boolean, false),
        stage_confidence = $4::numeric,
        stage_auto_reason = nullif(trim($5), ''),
        stage_auto_source_message_id = nullif(trim($6::text), ''),
        stage_auto_confidence = $7::int,
        stage_auto_updated_at = case
          when coalesce($3::boolean, false) then now()
          else stage_auto_updated_at
        end,
        last_activity_at = now(),
        updated_at = now()
      where id = $1::uuid
    `,
    [
      input.id,
      input.stage,
      input.stageAuto ?? false,
      input.stageConfidence ?? null,
      input.stageAutoReason ?? null,
      input.stageAutoSourceMessageId ?? null,
      input.stageAutoConfidence == null ? null : Math.max(0, Math.min(100, Math.round(input.stageAutoConfidence)))
    ]
  );
  const updated = (q.rowCount || 0) > 0;
  if (updated && previousStage && previousStage !== input.stage) {
    await db.query(
      `
        insert into whatsapp_lead_events (lead_id, event_type, payload)
        values ($1::uuid, 'STAGE_CHANGED', $2::jsonb)
      `,
      [
        input.id,
        JSON.stringify({
          from_stage: previousStage,
          to_stage: input.stage,
          stage_auto: Boolean(input.stageAuto),
          stage_confidence: input.stageConfidence ?? null,
          reason: input.stageAutoReason ?? null,
          source: String(input.source || "system"),
          changed_at: new Date().toISOString()
        })
      ]
    );
    if (input.stage === "CONVERTED") {
      try {
        await upsertLeadConversionMetrics(input.id);
      } catch (error) {
        console.error("[whatsapp] failed to upsert lead conversion metrics", {
          leadId: input.id,
          error: error instanceof Error ? error.message : String(error || "unknown_error")
        });
      }
    }
    try {
      await computeConversionScore(input.id);
    } catch (error) {
      console.warn("[conversion-score] recompute after stage change failed", {
        leadId: input.id,
        stage: input.stage,
        error
      });
    }
    try {
      await inferTicketValueForLead(input.id);
    } catch (error) {
      console.warn("[ticket-value] recompute after stage change failed", {
        leadId: input.id,
        stage: input.stage,
        error
      });
    }
    try {
      await recomputeLeadSla(input.id);
    } catch (error) {
      console.warn("[sla] recompute after stage change failed", {
        leadId: input.id,
        stage: input.stage,
        error
      });
    }
    try {
      await runAuto24hFollowupRuleForLead(input.id);
    } catch (error) {
      console.warn("[followup-rule] recompute after stage change failed", {
        leadId: input.id,
        stage: input.stage,
        error
      });
    }
  }
  return updated;
}

export async function updateWhatsAppLeadNotes(input: {
  id: string;
  internalNotes: string | null;
}): Promise<boolean> {
  const db = getPoolOrThrow();
  const q = await db.query(
    `
      update whatsapp_leads
      set
        internal_notes = nullif(trim($2), ''),
        updated_at = now()
      where id = $1::uuid
    `,
    [input.id, input.internalNotes || ""]
  );
  return (q.rowCount || 0) > 0;
}

export async function updateWhatsAppLeadTestFlag(input: {
  id: string;
  isTest: boolean;
  testTag?: string | null;
}): Promise<boolean> {
  const db = getPoolOrThrow();
  const q = await db.query(
    `
      update whatsapp_leads
      set
        is_test = $2::boolean,
        test_tag = nullif(trim($3::text), ''),
        updated_at = now()
      where id = $1::uuid
    `,
    [input.id, input.isTest, input.testTag ?? null]
  );
  return (q.rowCount || 0) > 0;
}

export async function updateWhatsAppLeadEventDate(input: {
  id: string;
  eventDate: string | null;
  eventDateText?: string | null;
  eventDateConfidence?: number | null;
  sourceMessageId?: string | null;
  manual?: boolean;
}): Promise<boolean> {
  const db = getPoolOrThrow();
  const q = await db.query(
    `
      update whatsapp_leads
      set
        event_date = $2::date,
        event_date_text = nullif(trim($3::text), ''),
        event_date_confidence = $4::int,
        event_date_source_message_id = nullif(trim($5::text), ''),
        event_date_updated_at = now(),
        event_date_manual = $6::boolean,
        updated_at = now()
      where id = $1::uuid
    `,
    [
      input.id,
      input.eventDate,
      input.eventDateText ?? null,
      input.eventDateConfidence == null ? null : Math.max(0, Math.min(100, Math.round(input.eventDateConfidence))),
      input.sourceMessageId ?? null,
      input.manual === true
    ]
  );
  return (q.rowCount || 0) > 0;
}

export async function updateWhatsAppLeadDestination(input: {
  id: string;
  shipCity?: string | null;
  shipRegion?: string | null;
  shipCountry?: string | null;
  shipDestinationText?: string | null;
  shipDestinationConfidence?: number | null;
  sourceMessageId?: string | null;
  manual?: boolean;
}): Promise<boolean> {
  const db = getPoolOrThrow();
  const q = await db.query(
    `
      update whatsapp_leads
      set
        ship_city = nullif(trim($2::text), ''),
        ship_region = nullif(trim($3::text), ''),
        ship_country = nullif(upper(trim($4::text)), ''),
        ship_destination_text = nullif(trim($5::text), ''),
        ship_destination_confidence = $6::int,
        ship_destination_source_message_id = nullif(trim($7::text), ''),
        ship_destination_updated_at = now(),
        ship_destination_manual = $8::boolean,
        updated_at = now()
      where id = $1::uuid
    `,
    [
      input.id,
      input.shipCity ?? null,
      input.shipRegion ?? null,
      input.shipCountry ?? null,
      input.shipDestinationText ?? null,
      input.shipDestinationConfidence == null ? null : Math.max(0, Math.min(100, Math.round(input.shipDestinationConfidence))),
      input.sourceMessageId ?? null,
      input.manual === true
    ]
  );
  return (q.rowCount || 0) > 0;
}

export async function updateWhatsAppLeadFlags(input: {
  id: string;
  priceSent?: boolean;
  productionTimeSent?: boolean;
}): Promise<boolean> {
  const db = getPoolOrThrow();
  const q = await db.query(
    `
      update whatsapp_leads
      set
        price_sent = coalesce($2::boolean, price_sent),
        production_time_sent = coalesce($3::boolean, production_time_sent),
        updated_at = now()
      where id = $1::uuid
    `,
    [input.id, input.priceSent ?? null, input.productionTimeSent ?? null]
  );
  return (q.rowCount || 0) > 0;
}

export async function updateWhatsAppLeadSignalFlags(input: {
  id: string;
  hasProductInterest?: boolean;
  hasPriceSent?: boolean;
  hasVideoProposed?: boolean;
  hasPaymentQuestion?: boolean;
  hasDepositLinkSent?: boolean;
  chatConfirmed?: boolean;
  priceIntent?: boolean;
  videoIntent?: boolean;
  paymentIntent?: boolean;
  depositIntent?: boolean;
  confirmationIntent?: boolean;
  productInterestSourceMessageId?: string | null;
  priceSentSourceMessageId?: string | null;
  videoProposedSourceMessageId?: string | null;
  paymentQuestionSourceMessageId?: string | null;
  depositLinkSourceMessageId?: string | null;
  chatConfirmedSourceMessageId?: string | null;
}): Promise<boolean> {
  const db = getPoolOrThrow();
  const q = await db.query(
    `
      update whatsapp_leads
      set
        has_product_interest = case when $2::boolean then true else has_product_interest end,
        has_price_sent = case when $3::boolean then true else has_price_sent end,
        has_video_proposed = case when $4::boolean then true else has_video_proposed end,
        has_payment_question = case when $5::boolean then true else has_payment_question end,
        has_deposit_link_sent = case when $6::boolean then true else has_deposit_link_sent end,
        chat_confirmed = case when $7::boolean then true else chat_confirmed end,
        price_intent = case when $8::boolean then true else price_intent end,
        video_intent = case when $9::boolean then true else video_intent end,
        payment_intent = case when $10::boolean then true else payment_intent end,
        deposit_intent = case when $11::boolean then true else deposit_intent end,
        confirmation_intent = case when $12::boolean then true else confirmation_intent end,
        product_interest_source_message_id = case
          when $2::boolean then coalesce(product_interest_source_message_id, nullif(trim($13::text), ''))
          else product_interest_source_message_id
        end,
        price_sent_source_message_id = case
          when $3::boolean then coalesce(price_sent_source_message_id, nullif(trim($14::text), ''))
          else price_sent_source_message_id
        end,
        video_proposed_source_message_id = case
          when $4::boolean then coalesce(video_proposed_source_message_id, nullif(trim($15::text), ''))
          else video_proposed_source_message_id
        end,
        payment_question_source_message_id = case
          when $5::boolean then coalesce(payment_question_source_message_id, nullif(trim($16::text), ''))
          else payment_question_source_message_id
        end,
        deposit_link_source_message_id = case
          when $6::boolean then coalesce(deposit_link_source_message_id, nullif(trim($17::text), ''))
          else deposit_link_source_message_id
        end,
        chat_confirmed_source_message_id = case
          when $7::boolean then coalesce(chat_confirmed_source_message_id, nullif(trim($18::text), ''))
          else chat_confirmed_source_message_id
        end,
        last_signal_at = case
          when $2::boolean or $3::boolean or $4::boolean or $5::boolean or $6::boolean or $7::boolean or $8::boolean or $9::boolean or $10::boolean or $11::boolean or $12::boolean then now()
          else last_signal_at
        end,
        updated_at = now()
      where id = $1::uuid
    `,
    [
      input.id,
      Boolean(input.hasProductInterest),
      Boolean(input.hasPriceSent),
      Boolean(input.hasVideoProposed),
      Boolean(input.hasPaymentQuestion),
      Boolean(input.hasDepositLinkSent),
      Boolean(input.chatConfirmed),
      Boolean(input.priceIntent),
      Boolean(input.videoIntent),
      Boolean(input.paymentIntent),
      Boolean(input.depositIntent),
      Boolean(input.confirmationIntent),
      input.productInterestSourceMessageId ?? null,
      input.priceSentSourceMessageId ?? null,
      input.videoProposedSourceMessageId ?? null,
      input.paymentQuestionSourceMessageId ?? null,
      input.depositLinkSourceMessageId ?? null,
      input.chatConfirmedSourceMessageId ?? null
    ]
  );
  return (q.rowCount || 0) > 0;
}

export async function updateWhatsAppLeadMarketingOptIn(input: {
  id: string;
  marketingOptIn: boolean;
  source?: "manual" | "shopify" | "wa_message";
}): Promise<boolean> {
  const db = getPoolOrThrow();
  const q = await db.query(
    `
      update whatsapp_leads
      set
        marketing_opt_in = $2::boolean,
        marketing_opt_in_source = case
          when $2::boolean then nullif(trim($3::text), '')
          else null
        end,
        marketing_opt_in_at = case
          when $2::boolean then now()
          else null
        end,
        updated_at = now()
      where id = $1::uuid
    `,
    [input.id, Boolean(input.marketingOptIn), input.source || null]
  );
  return (q.rowCount || 0) > 0;
}

export async function updateLeadQualification(input: {
  id: string;
  qualificationTags?: string[];
  intentLevel?: WhatsAppIntentLevel | null;
  stageAutoReason?: string | null;
  stageAuto?: boolean;
  stageConfidence?: number | null;
  recommendedStage?: WhatsAppLeadStage | null;
  recommendedStageReason?: string | null;
  recommendedStageConfidence?: number | null;
  detectedSignals?: WhatsAppDetectedSignals | null;
}): Promise<boolean> {
  const db = getPoolOrThrow();
  const q = await db.query(
    `
      update whatsapp_leads
      set
        qualification_tags = coalesce($2::text[], qualification_tags),
        intent_level = coalesce($3::text, intent_level),
        stage_auto_reason = coalesce(nullif(trim($4::text), ''), stage_auto_reason),
        stage_auto = coalesce($5::boolean, stage_auto),
        stage_confidence = coalesce($6::numeric, stage_confidence),
        recommended_stage = coalesce($7::whatsapp_lead_stage, recommended_stage),
        recommended_stage_reason = coalesce(nullif(trim($8::text), ''), recommended_stage_reason),
        recommended_stage_confidence = coalesce($9::numeric, recommended_stage_confidence),
        detected_signals = coalesce($10::jsonb, detected_signals),
        updated_at = now()
      where id = $1::uuid
    `,
    [
      input.id,
      input.qualificationTags && input.qualificationTags.length ? input.qualificationTags : null,
      input.intentLevel ?? null,
      input.stageAutoReason ?? null,
      input.stageAuto,
      input.stageConfidence ?? null,
      input.recommendedStage ?? null,
      input.recommendedStageReason ?? null,
      input.recommendedStageConfidence ?? null,
      input.detectedSignals ? JSON.stringify(input.detectedSignals) : null
    ]
  );
  return (q.rowCount || 0) > 0;
}

export async function createWhatsAppLeadMessage(input: {
  leadId: string;
  direction: WhatsAppDirection;
  text: string;
  createdAt?: string;
  provider?: string;
  messageType?: string;
  templateName?: string | null;
  externalId?: string | null;
  externalMessageId?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<WhatsAppLeadMessage | null> {
  const db = getPoolOrThrow();
  const id = randomUUID();
  const createdAt = input.createdAt || new Date().toISOString();
  const provider = String(input.provider || "manual").trim().toLowerCase() || "manual";
  const messageType = String(input.messageType || "text").trim().toLowerCase() || "text";
  const externalId = input.externalId ?? input.externalMessageId ?? null;

  const q = await db.query<{
    id: string;
    lead_id: string;
    direction: string;
    text: string;
    provider: string;
    message_type: string;
    template_name: string | null;
    external_id: string | null;
    metadata: unknown;
    created_at: string;
  }>(
    `
      insert into whatsapp_lead_messages (id, lead_id, direction, text, provider, message_type, template_name, external_id, metadata, created_at)
      values ($1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text, nullif(trim($7::text), ''), nullif(trim($8::text), ''), $9::jsonb, $10::timestamptz)
      on conflict (external_id) where external_id is not null
      do update set
        external_id = excluded.external_id,
        metadata = coalesce(whatsapp_lead_messages.metadata, '{}'::jsonb) || coalesce(excluded.metadata, '{}'::jsonb)
      returning *
    `,
    [
      id,
      input.leadId,
      input.direction,
      String(input.text || "").trim(),
      provider,
      messageType,
      input.templateName ?? null,
      externalId,
      input.metadata ? JSON.stringify(input.metadata) : null,
      createdAt
    ]
  );

  await db.query(
    `
      update whatsapp_leads
      set
        last_activity_at = greatest(coalesce(last_activity_at, created_at), $2::timestamptz),
        updated_at = now()
      where id = $1::uuid
    `,
    [input.leadId, createdAt]
  );

  const row = q.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    leadId: row.lead_id,
    direction: String(row.direction).toUpperCase() === "OUT" ? "OUT" : "IN",
    text: row.text,
    provider: row.provider,
    messageType: row.message_type,
    templateName: row.template_name,
    externalId: row.external_id,
    metadata: row.metadata && typeof row.metadata === "object" ? (row.metadata as Record<string, unknown>) : null,
    createdAt: row.created_at
  };
}

export async function createWhatsAppLead(input: {
  clientName: string;
  phoneNumber: string;
  profileImageUrl?: string | null;
  country?: string | null;
  inquirySource?: string | null;
  productReference?: string | null;
  stage?: WhatsAppLeadStage;
  channelType?: WhatsAppChannelType;
  aiMode?: WhatsAppAiMode;
}): Promise<WhatsAppLeadRecord | null> {
  const db = getPoolOrThrow();
  const id = randomUUID();
  const channelType = input.channelType === "SHARED" ? "SHARED" : "API";
  const aiMode = channelType === "SHARED" ? "ANALYZE_ONLY" : (input.aiMode === "ANALYZE_ONLY" ? "ANALYZE_ONLY" : "ACTIVE");
  const q = await db.query<LeadRow>(
    `
      insert into whatsapp_leads (
        id, client_name, phone_number, profile_image_url, country, inquiry_source, product_reference, stage, channel_type, ai_mode, created_at, updated_at, last_activity_at
      )
      values (
        $1::uuid, $2::text, $3::text, nullif(trim($4::text), ''), nullif(trim($5::text), ''), nullif(trim($6::text), ''), nullif(trim($7::text), ''),
        $8::whatsapp_lead_stage, $9::text, $10::text, now(), now(), now()
      )
      on conflict (phone_number)
      do update
      set
        client_name = excluded.client_name,
        profile_image_url = coalesce(excluded.profile_image_url, whatsapp_leads.profile_image_url),
        country = coalesce(excluded.country, whatsapp_leads.country),
        inquiry_source = coalesce(excluded.inquiry_source, whatsapp_leads.inquiry_source),
        product_reference = coalesce(excluded.product_reference, whatsapp_leads.product_reference),
        channel_type = excluded.channel_type,
        ai_mode = excluded.ai_mode,
        stage = case
          when whatsapp_leads.stage = 'CONVERTED' then whatsapp_leads.stage
          else excluded.stage
        end,
        last_activity_at = now(),
        updated_at = now()
      returning *
    `,
    [
      id,
      String(input.clientName || "").trim(),
      String(input.phoneNumber || "").trim(),
      input.profileImageUrl || "",
      input.country || "",
      input.inquirySource || "",
      input.productReference || "",
      input.stage || "NEW",
      channelType,
      aiMode
    ]
  );
  const row = q.rows[0];
  return row ? mapLead(row) : null;
}

export async function seedWhatsAppLeadsDemoIfEmpty(): Promise<{ seeded: boolean; count: number }> {
  const db = getPoolOrThrow();
  const q = await db.query<{ total: string | number }>("select count(*) as total from whatsapp_leads");
  const total = toNumber(q.rows[0]?.total);
  if (total > 0) return { seeded: false, count: total };

  const baseTs = Date.now();
  const demo = [
    {
      clientName: "Demo Price Sent",
      phoneNumber: "+212600000101",
      country: "MA",
      inquirySource: "Instagram",
      productReference: "Caftan Signature",
      stage: "PRICE_SENT" as WhatsAppLeadStage
    },
    {
      clientName: "Demo Qualified",
      phoneNumber: "+212600000102",
      country: "FR",
      inquirySource: "Website",
      productReference: "Takchita Couture",
      stage: "QUALIFIED" as WhatsAppLeadStage
    },
    {
      clientName: "Demo Deposit Pending",
      phoneNumber: "+212600000103",
      country: "AE",
      inquirySource: "Direct",
      productReference: "Jellaba Evening",
      stage: "DEPOSIT_PENDING" as WhatsAppLeadStage
    }
  ];

  for (let i = 0; i < demo.length; i += 1) {
    const item = demo[i];
    const createdAt = new Date(baseTs - i * 3600000).toISOString();
    await db.query(
      `
        insert into whatsapp_leads (
          id, client_name, phone_number, country, inquiry_source, product_reference, stage, price_sent,
          created_at, updated_at, last_activity_at
        )
        values (
          $1::uuid, $2::text, $3::text, $4::text, $5::text, $6::text, $7::whatsapp_lead_stage,
          $8::boolean, $9::timestamptz, $9::timestamptz, $9::timestamptz
        )
      `,
      [
        randomUUID(),
        item.clientName,
        item.phoneNumber,
        item.country,
        item.inquirySource,
        item.productReference,
        item.stage,
        item.stage === "PRICE_SENT" || item.stage === "QUALIFIED" || item.stage === "DEPOSIT_PENDING",
        createdAt
      ]
    );
  }

  return { seeded: true, count: demo.length };
}

export async function listRecentWhatsAppLeadMessages(leadId: string, limit = 10): Promise<WhatsAppLeadMessage[]> {
  return listWhatsAppLeadMessages(leadId, { limit, order: "desc" });
}

export async function listRecentInboundMessagesForLead(
  leadId: string,
  limit = 20
): Promise<WhatsAppInboundMessageSnippet[]> {
  const db = getPoolOrThrow();
  const safeLimit = Math.max(1, Math.min(100, Math.round(limit || 20)));
  const q = await db.query<{ id: string; text: string; created_at: string }>(
    `
      select id, text, created_at
      from whatsapp_lead_messages
      where lead_id = $1::uuid
        and direction = 'IN'
      order by created_at desc
      limit $2
    `,
    [leadId, safeLimit]
  );
  return q.rows.map((row) => ({
    id: row.id,
    text: row.text,
    createdAt: row.created_at
  }));
}

export async function listRecentInboundMessagesByLeadIds(
  leadIds: string[],
  limitPerLead = 20
): Promise<Map<string, WhatsAppInboundMessageSnippet[]>> {
  const db = getPoolOrThrow();
  const ids = Array.from(new Set((leadIds || []).map((id) => String(id || "").trim()).filter(Boolean)));
  const out = new Map<string, WhatsAppInboundMessageSnippet[]>();
  if (!ids.length) return out;
  const safeLimit = Math.max(1, Math.min(100, Math.round(limitPerLead || 20)));
  const q = await db.query<{ lead_id: string; id: string; text: string; created_at: string }>(
    `
      with ranked as (
        select
          lead_id,
          id,
          text,
          created_at,
          row_number() over (partition by lead_id order by created_at desc) as rn
        from whatsapp_lead_messages
        where lead_id = any($1::uuid[])
          and direction = 'IN'
      )
      select lead_id, id, text, created_at
      from ranked
      where rn <= $2::int
      order by lead_id asc, created_at desc
    `,
    [ids, safeLimit]
  );
  for (const row of q.rows) {
    const leadId = String(row.lead_id || "").trim();
    if (!leadId) continue;
    const arr = out.get(leadId) || [];
    arr.push({ id: row.id, text: row.text, createdAt: row.created_at });
    out.set(leadId, arr);
  }
  return out;
}

export async function listRecentMessagesByLeadIds(
  leadIds: string[],
  limitPerLead = 20
): Promise<Map<string, WhatsAppMessageSnippet[]>> {
  const db = getPoolOrThrow();
  const ids = Array.from(new Set((leadIds || []).map((id) => String(id || "").trim()).filter(Boolean)));
  const out = new Map<string, WhatsAppMessageSnippet[]>();
  if (!ids.length) return out;
  const safeLimit = Math.max(1, Math.min(100, Math.round(limitPerLead || 20)));
  const q = await db.query<{ lead_id: string; id: string; direction: string; text: string; created_at: string }>(
    `
      with ranked as (
        select
          lead_id,
          id,
          direction,
          text,
          created_at,
          row_number() over (partition by lead_id order by created_at desc) as rn
        from whatsapp_lead_messages
        where lead_id = any($1::uuid[])
      )
      select lead_id, id, direction, text, created_at
      from ranked
      where rn <= $2::int
      order by lead_id asc, created_at asc
    `,
    [ids, safeLimit]
  );

  for (const row of q.rows) {
    const leadId = String(row.lead_id || "").trim();
    if (!leadId) continue;
    const arr = out.get(leadId) || [];
    arr.push({
      id: row.id,
      leadId,
      direction: String(row.direction || "").toUpperCase() === "OUT" ? "OUT" : "IN",
      text: String(row.text || ""),
      createdAt: row.created_at
    });
    out.set(leadId, arr);
  }
  return out;
}

export async function listWhatsAppLeadMessages(
  leadId: string,
  options?: { limit?: number; order?: "asc" | "desc" }
): Promise<WhatsAppLeadMessage[]> {
  const db = getPoolOrThrow();
  const safeLimit = Math.max(1, Math.min(200, Math.round(options?.limit || 50)));
  const order = String(options?.order || "asc").toLowerCase() === "desc" ? "desc" : "asc";
  const q = await db.query<{
    id: string;
    lead_id: string;
    direction: string;
    text: string;
    provider: string;
    message_type: string;
    template_name: string | null;
    external_id: string | null;
    metadata: unknown;
    created_at: string;
  }>(
    order === "asc"
      ? `
      select id, lead_id, direction, text, provider, message_type, template_name, external_id, metadata, created_at
      from (
        select id, lead_id, direction, text, provider, message_type, template_name, external_id, metadata, created_at
        from whatsapp_lead_messages
        where lead_id = $1::uuid
        order by created_at desc
        limit $2
      ) recent
      order by created_at asc
    `
      : `
      select id, lead_id, direction, text, provider, message_type, template_name, external_id, metadata, created_at
      from whatsapp_lead_messages
      where lead_id = $1::uuid
      order by created_at desc
      limit $2
    `,
    [leadId, safeLimit]
  );

  const normalizedRows = q.rows.map((row) => ({
    row,
    metadata: row.metadata && typeof row.metadata === "object" ? (row.metadata as Record<string, unknown>) : null
  }));

  const replyExternalIds = Array.from(
    new Set(
      normalizedRows
        .map(({ metadata }) =>
          String(
            (metadata && (metadata.reply_to_external_id || metadata.reply_external_id || metadata.reply_to)) || ""
          ).trim()
        )
        .filter(Boolean)
    )
  );

  const replyByExternalId = new Map<string, { id: string; direction: "IN" | "OUT"; text: string }>();
  if (replyExternalIds.length) {
    const replyRows = await db.query<{
      id: string;
      external_id: string;
      direction: string;
      text: string;
    }>(
      `
        select id, external_id, direction, text
        from whatsapp_lead_messages
        where lead_id = $1::uuid
          and external_id = any($2::text[])
      `,
      [leadId, replyExternalIds]
    );
    replyRows.rows.forEach((row) => {
      const externalId = String(row.external_id || "").trim();
      if (!externalId) return;
      replyByExternalId.set(externalId, {
        id: row.id,
        direction: String(row.direction || "").toUpperCase() === "OUT" ? "OUT" : "IN",
        text: String(row.text || "")
      });
    });
  }

  const resolved: WhatsAppLeadMessage[] = normalizedRows.map(({ row, metadata }) => {
    const direction: WhatsAppDirection = String(row.direction).toUpperCase() === "OUT" ? "OUT" : "IN";
    const replyExternalId = String(
      (metadata && (metadata.reply_to_external_id || metadata.reply_external_id || metadata.reply_to)) || ""
    ).trim();
    const replyTarget = replyExternalId ? (replyByExternalId.get(replyExternalId) || null) : null;
    const fallbackReplyText = String(
      (metadata && (metadata.reply_to_text || metadata.reply_text || metadata.quoted_text)) || ""
    ).trim();
    const fallbackSenderRaw = String(
      (metadata && (metadata.reply_to_sender_name || metadata.reply_sender_name || metadata.reply_author || metadata.reply_from)) || ""
    ).trim();
    const fallbackSender =
      fallbackSenderRaw.toLowerCase() === "you" || fallbackSenderRaw.toLowerCase() === "me"
        ? "You"
        : fallbackSenderRaw.toLowerCase() === "client" || fallbackSenderRaw.toLowerCase() === "customer"
          ? "Client"
          : fallbackSenderRaw;
    const replyTo =
      replyTarget || fallbackReplyText
        ? {
            id: replyTarget?.id || "",
            senderName: fallbackSender || (replyTarget?.direction === "OUT" ? "You" : "Client"),
            text: replyTarget?.text || fallbackReplyText
          }
        : null;

    return {
      id: row.id,
      leadId: row.lead_id,
      direction,
      text: row.text,
      provider: row.provider,
      messageType: row.message_type,
      templateName: row.template_name,
      externalId: row.external_id,
      metadata,
      replyTo,
      createdAt: row.created_at
    };
  });

  // Fallback for incomplete provider reply metadata:
  // choose the closest prior message from the opposite direction in the loaded window.
  for (let i = 0; i < resolved.length; i += 1) {
    const item = resolved[i];
    const hasReplyReference = Boolean(
      String(
        ((item.metadata &&
          (item.metadata.reply_to_external_id || item.metadata.reply_external_id || item.metadata.reply_to)) as
          | string
          | undefined) || ""
      ).trim()
    );
    const hasResolvedReplyText = Boolean(item.replyTo && String(item.replyTo.text || "").trim());
    if (!hasReplyReference || hasResolvedReplyText) continue;

    const preferredDirection: "IN" | "OUT" = item.direction === "IN" ? "OUT" : "IN";
    let candidate: WhatsAppLeadMessage | null = null;
    for (let j = i - 1; j >= 0; j -= 1) {
      if (resolved[j].direction === preferredDirection) {
        candidate = resolved[j];
        break;
      }
    }
    if (!candidate) {
      for (let j = i - 1; j >= 0; j -= 1) {
        candidate = resolved[j];
        if (candidate) break;
      }
    }
    if (!candidate) continue;

    item.replyTo = {
      id: candidate.id,
      senderName: candidate.direction === "OUT" ? "You" : "Client",
      text: String(candidate.text || "").trim()
    };
  }

  return resolved;
}

export async function getWhatsAppLeadSessionStatus(leadId: string, windowHours = 24): Promise<WhatsAppLeadSessionStatus> {
  const db = getPoolOrThrow();
  const safeWindow = Math.max(1, Math.min(72, Math.round(windowHours || 24)));
  const q = await db.query<{ last_inbound_at: string | null }>(
    `
      select max(created_at) as last_inbound_at
      from whatsapp_lead_messages
      where lead_id = $1::uuid
        and direction = 'IN'
    `,
    [leadId]
  );
  const lastInbound = q.rows[0]?.last_inbound_at ? new Date(q.rows[0].last_inbound_at).getTime() : NaN;
  if (!Number.isFinite(lastInbound)) return { isSessionOpen: false, expiresAt: null };
  const expiresAt = new Date(lastInbound + safeWindow * 3600000).toISOString();
  return {
    isSessionOpen: Date.now() < new Date(expiresAt).getTime(),
    expiresAt
  };
}

export async function listWhatsAppLeadTimeline(leadId: string, limit = 80): Promise<WhatsAppLeadEvent[]> {
  const db = getPoolOrThrow();
  const safeLimit = Math.max(1, Math.min(300, Math.round(limit || 80)));
  const q = await db.query<{
    id: string | number;
    lead_id: string;
    event_type: string;
    payload: unknown;
    created_at: string;
  }>(
    `
      select id, lead_id, event_type, payload, created_at
      from whatsapp_lead_events
      where lead_id = $1::uuid
      order by created_at desc
      limit $2
    `,
    [leadId, safeLimit]
  );
  return q.rows.map((row) => ({
    id: Number(row.id),
    leadId: row.lead_id,
    eventType: row.event_type,
    payload: row.payload && typeof row.payload === "object" ? (row.payload as Record<string, unknown>) : null,
    createdAt: row.created_at
  }));
}

export async function createWhatsAppLeadEvent(input: {
  leadId: string;
  eventType: string;
  payload?: Record<string, unknown> | null;
}): Promise<boolean> {
  const db = getPoolOrThrow();
  const q = await db.query(
    `
      insert into whatsapp_lead_events (lead_id, event_type, payload)
      values ($1::uuid, $2::text, $3::jsonb)
    `,
    [input.leadId, String(input.eventType || "").trim(), input.payload ? JSON.stringify(input.payload) : null]
  );
  return (q.rowCount || 0) > 0;
}

export async function setLeadFirstResponseMinutesFromOutbound(leadId: string, sentAt?: string): Promise<boolean> {
  const db = getPoolOrThrow();
  const q = await db.query(
    `
      update whatsapp_leads
      set
        first_response_time_minutes = greatest(
          0,
          floor(extract(epoch from (coalesce($2::timestamptz, now()) - created_at)) / 60)::int
        ),
        updated_at = now()
      where id = $1::uuid
        and first_response_time_minutes is null
    `,
    [leadId, sentAt ?? null]
  );
  return (q.rowCount || 0) > 0;
}

export async function listWhatsAppTopLeads(options?: { days?: number; limit?: number }): Promise<WhatsAppTopLead[]> {
  const db = getPoolOrThrow();
  const days = Math.max(1, Math.min(365, Math.round(options?.days || 30)));
  const limit = Math.max(1, Math.min(100, Math.round(options?.limit || 20)));
  const q = await db.query<LeadRow>(
    `
      select *
      from whatsapp_leads
      where created_at >= now() - ($1::int * interval '1 day')
        and coalesce(channel_type, 'API') in ('API', 'SHARED')
      order by coalesce(last_activity_at, created_at) desc, created_at desc
      limit $2
    `,
    [days, limit * 4]
  );

  return q.rows
    .map((row) => mapLead(row))
    .map((lead) => {
      const scored = computeLeadScore(lead);
      return {
        ...lead,
        score: scored.score,
        scoreBreakdown: scored.scoreBreakdown,
        risk: computeRisk(lead.lastActivityAt, lead.createdAt, lead.stage),
        conversionProbability: computeConversionProbability(lead)
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export async function listWhatsAppPriorityLeads(options?: { limit?: number; slaAlertsOnly?: boolean }): Promise<WhatsAppPriorityLead[]> {
  const db = getPoolOrThrow();
  const limit = Math.max(1, Math.min(500, Math.round(options?.limit || 200)));
  await recomputeSlaForPriorityLeads(limit);
  const q = await db.query<{
    id: string;
    client_name: string;
    country: string | null;
    stage: string;
    conversion_score: number | string | null;
    event_date: string | null;
    last_message_at: string | null;
    days_since_last_message: number | string | null;
    ticket_value: number | string | null;
    ticket_currency: string | null;
    sla_status: string | null;
    sla_due_at: string | null;
    risk_flag: boolean | null;
  }>(
    `
      with last_messages as (
        select lead_id, max(created_at) as last_message_at
        from whatsapp_lead_messages
        group by lead_id
      )
      select
        l.id,
        l.client_name,
        l.country,
        l.stage,
        l.conversion_score,
        l.event_date::text as event_date,
        lm.last_message_at,
        case
          when lm.last_message_at is null then null
          else floor(extract(epoch from (now() - lm.last_message_at)) / 86400)::int
        end as days_since_last_message,
        l.ticket_value as ticket_value,
        l.ticket_currency as ticket_currency,
        l.sla_status,
        l.sla_due_at,
        case
          when l.stage not in ('CONVERTED', 'LOST')
               and lm.last_message_at is not null
               and lm.last_message_at < now() - interval '48 hours'
            then true
          else false
        end as risk_flag
      from whatsapp_leads l
      left join last_messages lm on lm.lead_id = l.id
      where coalesce(l.channel_type, 'API') in ('API', 'SHARED')
        and (
          $2::boolean = false
          or coalesce(l.sla_status, 'OK') in ('DUE_SOON', 'BREACHED')
        )
      order by
        case coalesce(l.sla_status, 'OK')
          when 'BREACHED' then 0
          when 'DUE_SOON' then 1
          else 2
        end asc,
        coalesce(l.conversion_score, 0) desc,
        l.event_date asc nulls last,
        l.ticket_value desc nulls last
      limit $1::int
    `,
    [limit, Boolean(options?.slaAlertsOnly)]
  );

  return q.rows.map((row) => ({
    id: row.id,
    clientName: String(row.client_name || ""),
    country: row.country ? String(row.country).toUpperCase() : null,
    stage: normalizeStage(row.stage),
    conversionScore: Math.max(0, Math.min(100, Math.round(toNumber(row.conversion_score, 0)))),
    eventDate: row.event_date || null,
    daysSinceLastMessage: row.days_since_last_message == null ? null : Math.max(0, Math.round(toNumber(row.days_since_last_message, 0))),
    ticketValue: row.ticket_value == null ? null : toNumber(row.ticket_value, 0),
    ticketCurrency:
      String(row.ticket_currency || "").toUpperCase() === "USD"
        ? "USD"
        : String(row.ticket_currency || "").toUpperCase() === "EUR"
          ? "EUR"
          : String(row.ticket_currency || "").toUpperCase() === "MAD"
            ? "MAD"
            : null,
    slaStatus:
      String(row.sla_status || "").toUpperCase() === "DUE_SOON"
        ? "DUE_SOON"
        : String(row.sla_status || "").toUpperCase() === "BREACHED"
          ? "BREACHED"
          : "OK",
    slaDueAt: row.sla_due_at || null,
    riskFlag: Boolean(row.risk_flag),
    lastMessageAt: row.last_message_at || null
  }));
}

export async function getYesterdayBriefStats(): Promise<YesterdayBriefStats> {
  const db = getPoolOrThrow();
  const q = await db.query<{
    new_inquiries: string | number;
    avg_response_time_minutes: string | number | null;
    conversions: string | number;
    leads_at_risk: string | number;
    price_sent_count: string | number;
    drop_off_count: string | number;
  }>(
    `
      with y as (
        select *
        from whatsapp_leads
        where created_at >= date_trunc('day', now()) - interval '1 day'
          and created_at < date_trunc('day', now())
          and coalesce(channel_type, 'API') in ('API', 'SHARED')
      )
      select
        count(*) as new_inquiries,
        avg(first_response_time_minutes)::numeric as avg_response_time_minutes,
        count(*) filter (where stage = 'CONVERTED') as conversions,
        count(*) filter (
          where stage in ('PRODUCT_INTEREST', 'QUALIFICATION_PENDING', 'QUALIFIED', 'PRICE_SENT', 'VIDEO_PROPOSED', 'DEPOSIT_PENDING', 'CONFIRMED')
            and coalesce(last_activity_at, created_at) < now() - interval '48 hours'
        ) as leads_at_risk,
        count(*) filter (
          where price_sent = true
             or stage in ('PRICE_SENT', 'VIDEO_PROPOSED', 'DEPOSIT_PENDING', 'CONFIRMED', 'CONVERTED')
        ) as price_sent_count,
        count(*) filter (
          where stage = 'PRICE_SENT'
            and stage <> 'CONVERTED'
        ) as drop_off_count
      from y
    `
  );

  const row = q.rows[0];
  return {
    newInquiries: toNumber(row?.new_inquiries),
    yesterdayInquiries: toNumber(row?.new_inquiries),
    avgResponseTimeMinutes: round2(toNumber(row?.avg_response_time_minutes)),
    conversions: toNumber(row?.conversions),
    leadsAtRisk: toNumber(row?.leads_at_risk),
    priceSentCount: toNumber(row?.price_sent_count),
    noResponseCount: toNumber(row?.leads_at_risk),
    dropOffCount: toNumber(row?.drop_off_count)
  };
}

// Backward compatibility helpers (legacy worker path kept but unused)
export async function listWhatsAppFollowUpCandidates(
  _kind: WhatsAppFollowUpKind,
  _options?: { limit?: number }
): Promise<WhatsAppFollowUpCandidate[]> {
  return [];
}

export async function markWhatsAppFollowUpSent(
  _leadId: string,
  _kind: WhatsAppFollowUpKind,
  _payload?: unknown
): Promise<void> {
  return;
}
