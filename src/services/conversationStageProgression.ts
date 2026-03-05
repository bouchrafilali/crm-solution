import type { WhatsAppLeadRecord, WhatsAppLeadStage } from "../db/whatsappLeadsRepo.js";

export type ConversationSignalMessage = {
  id: string;
  direction: "IN" | "OUT";
  text: string;
  createdAt: string;
};

export type ConversationEventType =
  | "PRODUCT_INTEREST"
  | "PRICE_SENT"
  | "VIDEO_PROPOSED"
  | "PAYMENT_QUESTION"
  | "DEPOSIT_LINK_SENT"
  | "CHAT_CONFIRMED";

export type ConversationEvent = {
  type: ConversationEventType;
  confidence: number;
  sourceMessageId: string | null;
  createdAt: string;
  details: string;
};

const MAIN_STAGE_RANK: Record<WhatsAppLeadStage, number> = {
  NEW: 0,
  PRODUCT_INTEREST: 1,
  QUALIFICATION_PENDING: 2,
  QUALIFIED: 3,
  PRICE_SENT: 4,
  VIDEO_PROPOSED: 4,
  DEPOSIT_PENDING: 5,
  CONFIRMED: 6,
  CONVERTED: 7,
  LOST: 8
};

const MONEY_PATTERN =
  /(?:\b(?:mad|dhs?|dh|€|\$|eur|usd)\s*[0-9][0-9\s.,]*\b|\b[0-9][0-9\s.,]*\s*(?:mad|dhs?|dh|€|\$|eur|usd)\b)/i;
const MONEY_WORD_PATTERN = /\b(mad|dhs?|dh|€|\$|eur|usd)\b/i;
const AMOUNT_PATTERN = /\b[0-9][0-9\s.,]*\b/;
const PRICE_PHRASE_PATTERN = /\b(le\s+prix\s+est|price\s+is|priced\s+at|prix\s*:)\b/i;
const VIDEO_PROPOSED_PATTERN =
  /\b(visio|appel\s+vid[ée]o|video\s+call|facetime|whatsapp\s+call|on\s+peut\s+faire\s+une\s+visio)\b/i;
const PAYMENT_QUESTION_PATTERN =
  /\b(payer|paiement|comment\s+je\s+paye|moyen\s+de\s+paiement|virement|carte|pay|payment|how\s+can\s+i\s+pay|deposit)\b/i;
const DEPOSIT_KEYWORD_PATTERN = /\b(acompte|deposit|r[ée]server|checkout|invoice|facture|rib|virement)\b/i;
const CONFIRMED_PATTERN =
  /\b(c['’]est\s+confirm\w*|je\s+confirme|ok\s+confirm[ée]?|je\s+valide|d['’]accord\s+je\s+confirme|confirmed|i\s+confirm|ok\s+confirmed|let'?s\s+do\s+it)\b/i;
const URL_PATTERN = /https?:\/\/\S+/i;
const PRODUCT_PATH_PATTERN = /\/products\/[a-z0-9][a-z0-9\-]*/i;
const COLLECTION_PRODUCT_PATH_PATTERN = /\/collections\/[^\s/]+\/products\/[a-z0-9][a-z0-9\-]*/i;
const PRODUCT_INTENT_PATTERN =
  /\b(interested\s+in|int[ée]ress[ée]?\s+par|je\s+veux|je\s+souhaite|i\s+want)\b.{0,80}\b(article|produit|product|model|mod[eè]le|kaftan|caftan)\b/i;
const PRICE_INTENT_PATTERN =
  /\b(how\s+much|how\s+much\s+is|how\s+much\s+does|price\??|combien|prix|tarif|cost)\b/i;
const VIDEO_INTENT_PATTERN = /\b(video|call|visio|facetime)\b/i;
const PAYMENT_INTENT_PATTERN = /\b(how\s+can\s+i\s+pay|payment|card|transfer|paypal)\b/i;
const DEPOSIT_INTENT_PATTERN = /\b(deposit|acompte|advance|book\s+it)\b/i;
const CONFIRMATION_INTENT_PATTERN = /\b(i\s+confirm|confirmed|ok\s+i\s+take\s+it|let['’]?s\s+proceed)\b/i;

export type LeadSignalDetection = {
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
  productInterestSourceMessageId: string | null;
  priceSentSourceMessageId: string | null;
  videoProposedSourceMessageId: string | null;
  paymentQuestionSourceMessageId: string | null;
  depositLinkSourceMessageId: string | null;
  chatConfirmedSourceMessageId: string | null;
  priceIntentSourceMessageId: string | null;
  videoIntentSourceMessageId: string | null;
  paymentIntentSourceMessageId: string | null;
  depositIntentSourceMessageId: string | null;
  confirmationIntentSourceMessageId: string | null;
  lastSignalAt: string | null;
};

function normalizeText(input: string): string {
  return String(input || "").replace(/[\n\r\t]+/g, " ").trim();
}

function isLikelyPriceSentOut(text: string): boolean {
  const clean = normalizeText(text);
  if (!clean) return false;
  if (MONEY_PATTERN.test(clean)) return true;
  if (PRICE_PHRASE_PATTERN.test(clean) && (MONEY_WORD_PATTERN.test(clean) || AMOUNT_PATTERN.test(clean))) return true;
  return false;
}

function isProductInterestIn(text: string): boolean {
  const clean = normalizeText(text);
  if (!clean) return false;
  if (COLLECTION_PRODUCT_PATH_PATTERN.test(clean)) return true;
  if (PRODUCT_PATH_PATTERN.test(clean)) return true;
  if (URL_PATTERN.test(clean) && /[a-z0-9.-]+\.[a-z]{2,}/i.test(clean) && /\/products\//i.test(clean)) return true;
  if (PRODUCT_INTENT_PATTERN.test(clean)) return true;
  return false;
}

function isVideoProposedOut(text: string): boolean {
  const clean = normalizeText(text);
  if (!clean) return false;
  return VIDEO_PROPOSED_PATTERN.test(clean);
}

function isPaymentQuestionIn(text: string): boolean {
  const clean = normalizeText(text);
  if (!clean) return false;
  return PAYMENT_QUESTION_PATTERN.test(clean);
}

function isDepositLinkSentOut(text: string): boolean {
  const clean = normalizeText(text);
  if (!clean) return false;
  if (DEPOSIT_KEYWORD_PATTERN.test(clean) && URL_PATTERN.test(clean)) return true;
  if (/\b(acompte|deposit)\b/i.test(clean) && /\b(lien|link|checkout|invoice|facture)\b/i.test(clean)) return true;
  return false;
}

function isChatConfirmedIn(text: string): boolean {
  const clean = normalizeText(text);
  if (!clean) return false;
  return CONFIRMED_PATTERN.test(clean);
}

function isPriceIntentIn(text: string): boolean {
  const clean = normalizeText(text);
  if (!clean) return false;
  return PRICE_INTENT_PATTERN.test(clean);
}

function isVideoIntentIn(text: string): boolean {
  const clean = normalizeText(text);
  if (!clean) return false;
  return VIDEO_INTENT_PATTERN.test(clean);
}

function isPaymentIntentIn(text: string): boolean {
  const clean = normalizeText(text);
  if (!clean) return false;
  return PAYMENT_INTENT_PATTERN.test(clean);
}

function isDepositIntentIn(text: string): boolean {
  const clean = normalizeText(text);
  if (!clean) return false;
  return DEPOSIT_INTENT_PATTERN.test(clean);
}

function isConfirmationIntentIn(text: string): boolean {
  const clean = normalizeText(text);
  if (!clean) return false;
  return CONFIRMATION_INTENT_PATTERN.test(clean);
}

function normalizeMainStage(stage: WhatsAppLeadStage): WhatsAppLeadStage {
  if (stage === "PRODUCT_INTEREST") return "QUALIFICATION_PENDING";
  if (stage === "VIDEO_PROPOSED") return "PRICE_SENT";
  return stage;
}

function isClearlyInvalidDestinationValue(raw: string | null | undefined): boolean {
  const v = String(raw || "").trim().toLowerCase();
  if (!v) return false;
  return [
    "this article",
    "that article",
    "this product",
    "that product",
    "this item",
    "that item",
    "the article",
    "the product",
    "cet article",
    "ce produit",
    "ce modele",
    "ce modèle",
    "this model",
    "that model"
  ].includes(v);
}

function hasMissingEventDate(lead: WhatsAppLeadRecord): boolean {
  const fullDate = String(lead.eventDate || "").trim();
  if (fullDate) return false;
  const raw = String(lead.eventDateText || "").trim().toLowerCase();
  if (!raw) return true;
  const monthTokenPattern =
    /\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec|janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[ûu]t|septembre|octobre|novembre|d[ée]cembre)\b/i;
  return !monthTokenPattern.test(raw);
}

function hasMissingDestination(lead: WhatsAppLeadRecord): boolean {
  const city = String(lead.shipCity || "").trim();
  const region = String(lead.shipRegion || "").trim();
  const country = String(lead.shipCountry || "").trim();
  const raw = String(lead.shipDestinationText || "").trim();
  if (isClearlyInvalidDestinationValue(city) || isClearlyInvalidDestinationValue(raw)) return true;
  const hasStructuredDestination = Boolean(city || region || country);
  const hasRawDestination = Boolean(raw) && !isClearlyInvalidDestinationValue(raw);
  if (hasStructuredDestination || hasRawDestination) return false;
  return true;
}

function hasTeamApprovedPriceReady(lead: WhatsAppLeadRecord): boolean {
  const qa = lead.detectedSignals && typeof lead.detectedSignals === "object"
    ? (lead.detectedSignals as Record<string, unknown>).quote_approval
    : null;
  if (!qa || typeof qa !== "object") return false;
  const recommendation = String((qa as Record<string, unknown>).stage_recommendation || "").trim().toUpperCase();
  return recommendation === "PRICE_APPROVED_READY_TO_SEND";
}

export function detectSignalsFromMessages(messages: ConversationSignalMessage[], lead: WhatsAppLeadRecord): LeadSignalDetection {
  const safe = Array.isArray(messages) ? messages : [];
  const out: LeadSignalDetection = {
    hasProductInterest: false,
    hasPriceSent: false,
    hasVideoProposed: false,
    hasPaymentQuestion: false,
    hasDepositLinkSent: false,
    chatConfirmed: false,
    priceIntent: false,
    videoIntent: false,
    paymentIntent: false,
    depositIntent: false,
    confirmationIntent: false,
    productInterestSourceMessageId: null,
    priceSentSourceMessageId: null,
    videoProposedSourceMessageId: null,
    paymentQuestionSourceMessageId: null,
    depositLinkSourceMessageId: null,
    chatConfirmedSourceMessageId: null,
    priceIntentSourceMessageId: null,
    videoIntentSourceMessageId: null,
    paymentIntentSourceMessageId: null,
    depositIntentSourceMessageId: null,
    confirmationIntentSourceMessageId: null,
    lastSignalAt: null
  };

  for (const msg of safe) {
    try {
      const text = normalizeText(msg.text);
      if (!text) continue;
      const direction = msg.direction;
      const sourceMessageId = String(msg.id || "").trim() || null;
      const createdAt = String(msg.createdAt || new Date().toISOString());

      if (direction === "IN" && !lead.hasProductInterest && !out.hasProductInterest && isProductInterestIn(text)) {
        out.hasProductInterest = true;
        out.productInterestSourceMessageId = sourceMessageId;
        out.lastSignalAt = createdAt;
      }
      if (direction === "OUT" && !lead.hasPriceSent && !out.hasPriceSent && isLikelyPriceSentOut(text)) {
        out.hasPriceSent = true;
        out.priceSentSourceMessageId = sourceMessageId;
        out.lastSignalAt = createdAt;
      }
      if (direction === "OUT" && !lead.hasVideoProposed && !out.hasVideoProposed && isVideoProposedOut(text)) {
        out.hasVideoProposed = true;
        out.videoProposedSourceMessageId = sourceMessageId;
        out.lastSignalAt = createdAt;
      }
      if (direction === "IN" && !lead.hasPaymentQuestion && !out.hasPaymentQuestion && isPaymentQuestionIn(text)) {
        out.hasPaymentQuestion = true;
        out.paymentQuestionSourceMessageId = sourceMessageId;
        out.lastSignalAt = createdAt;
      }
      if (direction === "OUT" && !lead.hasDepositLinkSent && !out.hasDepositLinkSent && isDepositLinkSentOut(text)) {
        out.hasDepositLinkSent = true;
        out.depositLinkSourceMessageId = sourceMessageId;
        out.lastSignalAt = createdAt;
      }
      if (direction === "IN" && !lead.chatConfirmed && !out.chatConfirmed && isChatConfirmedIn(text)) {
        out.chatConfirmed = true;
        out.chatConfirmedSourceMessageId = sourceMessageId;
        out.lastSignalAt = createdAt;
      }
      if (direction === "IN" && !lead.priceIntent && !out.priceIntent && isPriceIntentIn(text)) {
        out.priceIntent = true;
        out.priceIntentSourceMessageId = sourceMessageId;
        out.lastSignalAt = createdAt;
      }
      if (direction === "IN" && !lead.videoIntent && !out.videoIntent && isVideoIntentIn(text)) {
        out.videoIntent = true;
        out.videoIntentSourceMessageId = sourceMessageId;
        out.lastSignalAt = createdAt;
      }
      if (direction === "IN" && !lead.paymentIntent && !out.paymentIntent && isPaymentIntentIn(text)) {
        out.paymentIntent = true;
        out.paymentIntentSourceMessageId = sourceMessageId;
        out.lastSignalAt = createdAt;
      }
      if (direction === "IN" && !lead.depositIntent && !out.depositIntent && isDepositIntentIn(text)) {
        out.depositIntent = true;
        out.depositIntentSourceMessageId = sourceMessageId;
        out.lastSignalAt = createdAt;
      }
      if (
        direction === "IN" &&
        !lead.confirmationIntent &&
        !out.confirmationIntent &&
        isConfirmationIntentIn(text)
      ) {
        out.confirmationIntent = true;
        out.confirmationIntentSourceMessageId = sourceMessageId;
        out.lastSignalAt = createdAt;
      }
    } catch {
      // no-throw detection by design
    }
  }

  return out;
}

export function detectConversationEvents(messages: ConversationSignalMessage[], _lead: WhatsAppLeadRecord): ConversationEvent[] {
  const safe = Array.isArray(messages) ? messages : [];
  const events: ConversationEvent[] = [];

  for (const msg of safe) {
    try {
      const text = normalizeText(msg.text);
      if (!text) continue;
      const direction = msg.direction;
      const sourceMessageId = String(msg.id || "").trim() || null;
      const createdAt = String(msg.createdAt || new Date().toISOString());

      if (direction === "IN" && isProductInterestIn(text)) {
        events.push({
          type: "PRODUCT_INTEREST",
          confidence: 90,
          sourceMessageId,
          createdAt,
          details: "product_interest_detected_in_inbound_message"
        });
      }
      if (direction === "OUT" && isLikelyPriceSentOut(text)) {
        events.push({
          type: "PRICE_SENT",
          confidence: 90,
          sourceMessageId,
          createdAt,
          details: "price_detected_in_out_message"
        });
      }
      if (direction === "OUT" && isVideoProposedOut(text)) {
        events.push({
          type: "VIDEO_PROPOSED",
          confidence: 85,
          sourceMessageId,
          createdAt,
          details: "video_call_proposed_in_out_message"
        });
      }
      if (direction === "IN" && isPaymentQuestionIn(text)) {
        events.push({
          type: "PAYMENT_QUESTION",
          confidence: 85,
          sourceMessageId,
          createdAt,
          details: "payment_question_detected"
        });
      }
      if (direction === "OUT" && isDepositLinkSentOut(text)) {
        events.push({
          type: "DEPOSIT_LINK_SENT",
          confidence: 90,
          sourceMessageId,
          createdAt,
          details: "deposit_link_detected"
        });
      }
      if (direction === "IN" && isChatConfirmedIn(text)) {
        events.push({
          type: "CHAT_CONFIRMED",
          confidence: 70,
          sourceMessageId,
          createdAt,
          details: "chat_confirmation_detected"
        });
      }
    } catch {
      // no-throw detection by design
    }
  }

  return events;
}

function maxStage(a: WhatsAppLeadStage, b: WhatsAppLeadStage): WhatsAppLeadStage {
  return MAIN_STAGE_RANK[a] >= MAIN_STAGE_RANK[b] ? a : b;
}

export function applyStageProgression(
  lead: WhatsAppLeadRecord,
  events: ConversationEvent[],
  options?: {
    paymentReceived?: boolean;
    depositPaid?: boolean;
    hasPaidShopifyOrder?: boolean;
    shopifyFinancialStatus?: string | null;
  }
): {
  nextStage: WhatsAppLeadStage;
  changed: boolean;
  reason: string | null;
  sourceMessageId: string | null;
  confidence: number | null;
  signals: {
    product_interest: boolean;
    price_sent: boolean;
    price_sent_ready: boolean;
    video_proposed: boolean;
    payment_question: boolean;
    deposit_link_sent: boolean;
    deposit_pending: boolean;
    chat_confirmed: boolean;
    block_price_sent: boolean;
    alternative_required: boolean;
    price_intent: boolean;
    video_intent: boolean;
    payment_intent: boolean;
    deposit_intent: boolean;
    confirmation_intent: boolean;
  };
} {
  const financialStatus = String(options?.shopifyFinancialStatus ?? lead.shopifyFinancialStatus ?? "")
    .trim()
    .toLowerCase();
  const fullPaymentValidated = Boolean(
    options?.paymentReceived || options?.hasPaidShopifyOrder || lead.paymentReceived || financialStatus === "paid"
  );
  const confirmedByPayment = Boolean(
    options?.depositPaid || lead.depositPaid || financialStatus === "partially_paid" || financialStatus === "paid"
  );
  const baseStage = normalizeMainStage(lead.stage);
  const hasProductInterest = lead.hasProductInterest || events.some((event) => event.type === "PRODUCT_INTEREST");
  const teamPriceSentReady = hasTeamApprovedPriceReady(lead);
  const hasPriceSent = lead.hasPriceSent || events.some((event) => event.type === "PRICE_SENT");
  const hasVideoProposed = lead.hasVideoProposed || events.some((event) => event.type === "VIDEO_PROPOSED");
  const hasPaymentQuestion = lead.hasPaymentQuestion || events.some((event) => event.type === "PAYMENT_QUESTION");
  const hasDepositLinkSent =
    lead.hasDepositLinkSent || events.some((event) => event.type === "DEPOSIT_LINK_SENT");
  const hasChatConfirmed = lead.chatConfirmed || events.some((event) => event.type === "CHAT_CONFIRMED");
  const hasPriceIntent = Boolean(lead.priceIntent);
  const hasVideoIntent = Boolean(lead.videoIntent);
  const hasPaymentIntent = Boolean(lead.paymentIntent);
  const hasDepositIntent = Boolean(lead.depositIntent);
  const hasConfirmationIntent = Boolean(lead.confirmationIntent);

  if (fullPaymentValidated) {
    const best = events.slice().sort((a, b) => (b.confidence - a.confidence))[0] || null;
    return {
      nextStage: "CONVERTED",
      changed: baseStage !== "CONVERTED",
      reason: "full_payment_validated",
      sourceMessageId: best?.sourceMessageId || null,
      confidence: best?.confidence ?? 100,
      signals: {
        product_interest: hasProductInterest,
        price_sent: hasPriceSent,
        price_sent_ready: teamPriceSentReady,
        video_proposed: hasVideoProposed,
        payment_question: hasPaymentQuestion,
        deposit_link_sent: hasDepositLinkSent,
        deposit_pending: hasPaymentQuestion || hasDepositLinkSent || hasPaymentIntent || hasDepositIntent,
        chat_confirmed: hasChatConfirmed,
        block_price_sent: false,
        alternative_required: false,
        price_intent: hasPriceIntent,
        video_intent: hasVideoIntent,
        payment_intent: hasPaymentIntent,
        deposit_intent: hasDepositIntent,
        confirmation_intent: hasConfirmationIntent
      }
    };
  }

  let target = baseStage;
  const reasons: string[] = [];
  let bestEvent: ConversationEvent | null = null;
  let lastTriggerEvent: ConversationEvent | null = null;
  const signals = {
    product_interest: hasProductInterest,
    price_sent: hasPriceSent,
    price_sent_ready: teamPriceSentReady,
    video_proposed: hasVideoProposed,
    payment_question: hasPaymentQuestion,
    deposit_link_sent: hasDepositLinkSent,
    deposit_pending: hasPaymentQuestion || hasDepositLinkSent || hasPaymentIntent || hasDepositIntent,
    chat_confirmed: hasChatConfirmed,
    block_price_sent: false,
    alternative_required: false,
    price_intent: hasPriceIntent,
    video_intent: hasVideoIntent,
    payment_intent: hasPaymentIntent,
    deposit_intent: hasDepositIntent,
    confirmation_intent: hasConfirmationIntent
  };

  const sorted = events
    .slice()
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  for (const event of sorted) {
    if (!bestEvent || event.confidence >= bestEvent.confidence) bestEvent = event;
    if (event.type === "PRODUCT_INTEREST") {
      reasons.push("Detected PRODUCT_INTEREST from IN msg");
      lastTriggerEvent = event;
    } else if (event.type === "PRICE_SENT") {
      reasons.push("Detected PRICE_SENT from OUT msg");
      lastTriggerEvent = event;
    } else if (event.type === "VIDEO_PROPOSED") {
      reasons.push("Detected VIDEO_PROPOSED from OUT msg");
      lastTriggerEvent = event;
    } else if (event.type === "PAYMENT_QUESTION" || event.type === "DEPOSIT_LINK_SENT") {
      reasons.push(event.type === "PAYMENT_QUESTION" ? "Detected PAYMENT_QUESTION from IN msg" : "Detected DEPOSIT_LINK_SENT from OUT msg");
      lastTriggerEvent = event;
    } else if (event.type === "CHAT_CONFIRMED") {
      reasons.push("Detected CHAT_CONFIRMED from IN msg");
      lastTriggerEvent = event;
    }
  }

  const missingEventDate = hasMissingEventDate(lead);
  const missingDestination = hasMissingDestination(lead);
  if (baseStage === "NEW") {
    if (signals.product_interest) {
      target = maxStage(target, missingEventDate ? "QUALIFICATION_PENDING" : "QUALIFIED");
      reasons.push("Product interest moved stage from NEW");
    } else {
      target = "NEW";
    }
  }
  if (missingEventDate || missingDestination) {
    target = maxStage(target, "QUALIFICATION_PENDING");
    reasons.push("Missing date or destination keeps stage at QUALIFICATION_PENDING");
  } else {
    target = maxStage(target, "QUALIFIED");
    reasons.push("Date and destination present: stage can be QUALIFIED");
  }

  if (signals.price_sent) {
    target = maxStage(target, "PRICE_SENT");
    reasons.push("Price signal moved stage to PRICE_SENT");
  } else if (signals.price_sent_ready) {
    reasons.push("Team approved price is ready; waiting for outbound price message before PRICE_SENT");
  }

  if (signals.video_proposed) {
    reasons.push("Detected VIDEO_PROPOSED flag from OUT msg");
  }

  if (signals.deposit_pending) {
    const beforeDepositTarget = target;
    target = maxStage(target, "DEPOSIT_PENDING");
    if (target !== beforeDepositTarget && beforeDepositTarget === "PRICE_SENT" && signals.payment_question) {
      reasons.push("Applied rule: PRICE_SENT->DEPOSIT_PENDING (payment_question)");
    } else if (target !== beforeDepositTarget && beforeDepositTarget === "PRICE_SENT" && signals.deposit_link_sent) {
      reasons.push("Applied rule: PRICE_SENT->DEPOSIT_PENDING (deposit_link_sent)");
    } else {
      reasons.push("Payment signal moved stage to DEPOSIT_PENDING");
    }
  }
  if (confirmedByPayment) {
    target = maxStage(target, "CONFIRMED");
    reasons.push("Payment status moved stage to CONFIRMED");
  }

  return {
    nextStage: target,
    changed: target !== lead.stage,
    reason: reasons.length ? reasons[reasons.length - 1] : null,
    sourceMessageId: lastTriggerEvent?.sourceMessageId || bestEvent?.sourceMessageId || null,
    confidence: lastTriggerEvent?.confidence ?? bestEvent?.confidence ?? null,
    signals
  };
}
