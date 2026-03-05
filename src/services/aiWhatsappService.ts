import type { WhatsAppLeadRecord } from "../db/whatsappLeadsRepo.js";
import type { AiSettings } from "../db/aiSettingsRepo.js";
import { generateAiText, sanitizeForPrompt } from "./aiTextService.js";
import { computeQualificationStatus, type QualificationMissingField } from "./leadQualificationService.js";

export type FollowUpType = "48H_PRICE" | "72H_PRICE" | "72H_QUALIFIED_VIDEO";

const FOLLOW_UP_FALLBACKS: Record<FollowUpType, string> = {
  "48H_PRICE":
    "Just checking in regarding the piece you loved — I would be happy to arrange a short private presentation if helpful.",
  "72H_PRICE":
    "As we are scheduling production for the coming weeks, I wanted to ensure availability remains open for your date.",
  "72H_QUALIFIED_VIDEO":
    "If helpful, I would be delighted to arrange a short private video call to present the embroidery and structure in detail."
};

function followUpInstruction(type: FollowUpType): string {
  if (type === "48H_PRICE") return "Create a 1-2 sentence follow-up for a PRICE_SENT lead after 48h without reply.";
  if (type === "72H_PRICE") return "Create a 1-2 sentence follow-up for a PRICE_SENT lead after 72h without reply.";
  return "Create a 1-2 sentence follow-up for a QUALIFIED/VIDEO_PROPOSED lead after 72h without reply.";
}

function leadContext(lead: WhatsAppLeadRecord): string {
  return JSON.stringify(
    {
      client_name: sanitizeForPrompt(lead.clientName, 80),
      country: sanitizeForPrompt(lead.country, 40),
      product_reference: sanitizeForPrompt(lead.productReference, 100),
      stage: sanitizeForPrompt(lead.stage, 40),
      first_response_time_minutes: lead.firstResponseTimeMinutes,
      last_activity_at: lead.lastActivityAt,
      price_sent: lead.priceSent,
      production_time_sent: lead.productionTimeSent,
      internal_notes: sanitizeForPrompt(lead.internalNotes, 200)
    },
    null,
    2
  );
}

function styleInstruction(settings?: AiSettings): string {
  if (!settings) {
    return "Tone: quiet luxury. Keep it concise. No emojis.";
  }
  const languageRule =
    settings.defaultLanguage === "FR"
      ? "Language: French."
      : settings.defaultLanguage === "EN"
        ? "Language: English."
        : "Language: AUTO (follow lead language).";
  const toneRule =
    settings.tone === "FORMEL"
      ? "Tone: formal, refined."
      : settings.tone === "DIRECT"
        ? "Tone: direct and clear, still premium."
        : "Tone: quiet luxury, elegant, discreet.";
  const lengthRule =
    settings.messageLength === "SHORT"
      ? "Length: SHORT (2-4 lines, max 4 lines)."
      : "Length: MEDIUM (up to 5 lines).";
  const videoRule =
    settings.includeVideoCall === "NEVER"
      ? "Never propose a video call."
      : settings.includeVideoCall === "ALWAYS"
        ? "By default, include a short private video call option."
        : "Include video call only when high intent / high urgency.";
  const urgencyRule =
    settings.urgencyStyle === "SUBTLE"
      ? "Urgency style: subtle and elegant."
      : "Urgency style: neutral and factual.";
  const emojiRule = settings.noEmojis ? "No emojis." : "Emojis allowed but keep minimal.";
  const followUpRule = settings.avoidFollowUpPhrase ? "Avoid using the exact phrase 'follow up'." : "";
  const signatureRule =
    settings.signatureEnabled && settings.signatureText
      ? `Append signature exactly as: ${settings.signatureText}`
      : "Do not append signature.";

  return [languageRule, toneRule, lengthRule, videoRule, urgencyRule, emojiRule, followUpRule, signatureRule]
    .filter(Boolean)
    .join(" ");
}

function enforceMessageLength(message: string, settings?: AiSettings): string {
  const maxLines = settings?.messageLength === "MEDIUM" ? 5 : 4;
  const lines = String(message || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(0, maxLines).join("\n");
}

function sanitizeMessageBySettings(message: string, settings?: AiSettings): string {
  let text = String(message || "").trim();
  if (!text) return text;
  if (settings?.noEmojis) {
    text = text.replace(/[\p{Extended_Pictographic}\u{1F000}-\u{1FAFF}]/gu, "").trim();
  }
  if (settings?.avoidFollowUpPhrase) {
    text = text.replace(/\bfollow[\s-]?up\b/gi, "message").trim();
  }
  text = enforceMessageLength(text, settings);
  if (settings?.signatureEnabled && settings.signatureText) {
    const sig = String(settings.signatureText).trim();
    if (sig && !text.endsWith(sig)) text = `${text}\n${sig}`;
  }
  return text.trim();
}

export async function generateFollowUp(lead: WhatsAppLeadRecord, type: FollowUpType, settings?: AiSettings): Promise<string> {
  const fallbackText = FOLLOW_UP_FALLBACKS[type];
  const ai = await generateAiText({
    systemPrompt:
      "You write WhatsApp follow-up messages for a couture maison. Messages must be concise, elegant and non-pushy.",
    userPrompt: `${followUpInstruction(type)}\n${styleInstruction(settings)}\nReturn only the message text.\nLead context:\n${leadContext(lead)}`,
    temperature: 0.25,
    maxOutputTokens: 120,
    fallbackText
  });
  return sanitizeMessageBySettings(String(ai.text || fallbackText).trim(), settings);
}

export type DailyBriefInput = {
  newInquiries: number;
  avgResponseTimeMinutes: number;
  conversions: number;
  leadsAtRisk: number;
  priceSentCount: number;
  dropOffCount: number;
};

export type DailyBriefOutput = {
  summary: string;
  insights: string;
  action_items: string[];
};

export type WhatsAppAiStage =
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

export type AiClassificationOutput = {
  detected_stage: WhatsAppAiStage;
  recommended_stage: WhatsAppAiStage;
  confidence: number; // 0..100
  urgency: "LOW" | "MEDIUM" | "HIGH";
  signals_detected: string[];
  qualification_complete: boolean;
  missing_fields: QualificationMissingField[];
  suggestion_type: "QUALIFICATION" | "PRICE_CONTEXTUALIZED";
  score: number;
  score_breakdown: Array<{ label: string; points: number }>;
  suggested_message: string;
  suggested_reply: string;
  recommended_next_action: string;
  explanation: string;
};

function formatMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "0m";
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (!h) return `${m}m`;
  return `${h}h${String(m).padStart(2, "0")}m`;
}

function fallbackBrief(input: DailyBriefInput): DailyBriefOutput {
  const summary = [
    "WhatsApp Performance Yesterday",
    `- ${input.newInquiries} new inquiries`,
    `- Avg response time: ${formatMinutes(input.avgResponseTimeMinutes)}`,
    `- ${input.conversions} conversions`,
    `- ${input.leadsAtRisk} leads at risk`
  ].join("\n");

  const insights =
    input.avgResponseTimeMinutes > 60
      ? "Response time above 1 hour correlates with lower conversion progression from PRICE_SENT."
      : "Response speed stayed healthy and supported stronger conversion progression.";

  const actionItems = [
    `Prioritize follow-up on ${input.leadsAtRisk} at-risk lead(s) older than 48h.`,
    `Review ${input.dropOffCount} PRICE_SENT drop-off lead(s) and adjust offer framing.`,
    `Protect conversion momentum on ${input.priceSentCount} lead(s) with pricing already shared.`
  ];

  return {
    summary,
    insights,
    action_items: actionItems
  };
}

export async function generateDailyBusinessBrief(input: DailyBriefInput): Promise<DailyBriefOutput> {
  const fallback = fallbackBrief(input);
  const ai = await generateAiText({
    systemPrompt:
      "You are an executive conversion analyst. Output concise, action-oriented operational guidance. No emojis.",
    userPrompt:
      "Using this JSON, generate:\n1) summary (short multiline text)\n2) insights (one paragraph)\n3) action_items (3 bullets).\nReturn strict JSON object with keys summary, insights, action_items.\nData:\n" +
      JSON.stringify(input, null, 2),
    temperature: 0.2,
    maxOutputTokens: 260,
    fallbackText: JSON.stringify(fallback)
  });

  try {
    const parsed = JSON.parse(String(ai.text || "")) as Partial<DailyBriefOutput>;
    if (!parsed || typeof parsed !== "object") return fallback;
    const actionItems = Array.isArray(parsed.action_items)
      ? parsed.action_items.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 5)
      : fallback.action_items;
    return {
      summary: String(parsed.summary || fallback.summary).trim(),
      insights: String(parsed.insights || fallback.insights).trim(),
      action_items: actionItems.length ? actionItems : fallback.action_items
    };
  } catch {
    return fallback;
  }
}

const PRODUCT_URL_PATTERN = /\/products\//i;
const INTEREST_PATTERNS: RegExp[] = [
  /\binterested\b/i,
  /\binterest\b/i,
  /\bint[ée]ress[ée]?\b/i,
  /\bje\s*veux\b/i,
  /\bj[' ]?aime\b/i,
  /\bi\s+like\b/i,
  /\blove\b/i,
  /\bce\s+mod[eè]le\b/i
];
const PRICE_INQUIRY_PATTERNS: RegExp[] = [
  /\bprice\b/i,
  /\bhow\s+much\b/i,
  /\bcombien\b/i,
  /\bprix\b/i,
  /\btarif\b/i,
  /\bcost\b/i
];
const EVENT_DATE_PATTERNS: RegExp[] = [
  /wedding/i,
  /mariage/i,
  /\beid\b/i,
  /\bdate\b/i,
  /\ben\s+\w+/i,
  /\bdans\s+\d+\s+semaines?/i,
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}\b/i,
  /\b\d{1,2}\s+(janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[ûu]t|septembre|octobre|novembre|d[ée]cembre)\b/i,
  /\b\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?\b/i
];
const SHIPPING_PATTERNS: RegExp[] = [/shipping/i, /livraison/i, /france/i, /paris/i, /international/i];
const SIZING_PATTERNS: RegExp[] = [/taille/i, /mesure/i, /measurement/i, /tour\s+de/i, /\bsize\b/i];
const DEPOSIT_PATTERNS: RegExp[] = [/\bhow\s+to\s+order\b/i, /\bhow\s+to\s+pay\b/i, /\breserve\b/i, /\br[ée]server\b/i, /\bacompte\b/i];

function containsProductSignal(input: { lead: WhatsAppLeadRecord; text: string }): boolean {
  const text = input.text;
  if (PRODUCT_URL_PATTERN.test(text)) return true;
  const hasInterest = INTEREST_PATTERNS.some((pattern) => pattern.test(text));
  const hasProductReference = Boolean(String(input.lead.productReference || "").trim());
  return hasInterest && hasProductReference;
}

function containsPriceInquiry(text: string): boolean {
  return PRICE_INQUIRY_PATTERNS.some((pattern) => pattern.test(text));
}

function detectQualificationSignals(text: string): { eventDate: boolean; shipping: boolean; sizing: boolean } {
  return {
    eventDate: EVENT_DATE_PATTERNS.some((pattern) => pattern.test(text)),
    shipping: SHIPPING_PATTERNS.some((pattern) => pattern.test(text)),
    sizing: SIZING_PATTERNS.some((pattern) => pattern.test(text))
  };
}

function detectUrgency(input: string): { urgency: "LOW" | "MEDIUM" | "HIGH"; needsPriority: boolean } {
  const text = String(input || "").toLowerCase();
  if (/next week|semaine prochaine/.test(text)) return { urgency: "HIGH", needsPriority: true };
  const daysMatch = text.match(/(?:in|dans)\s+(\d{1,2})\s+days?/i);
  if (daysMatch) {
    const days = Number(daysMatch[1]);
    if (Number.isFinite(days) && days < 10) return { urgency: "HIGH", needsPriority: true };
  }
  const dmy = text.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]) - 1;
    const year = dmy[3] ? Number(dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3]) : new Date().getFullYear();
    const dt = new Date(year, month, day);
    const diffDays = (dt.getTime() - Date.now()) / 86400000;
    if (Number.isFinite(diffDays) && diffDays >= 0 && diffDays < 10) return { urgency: "HIGH", needsPriority: true };
  }
  if (EVENT_DATE_PATTERNS.some((pattern) => pattern.test(text))) {
    return { urgency: "MEDIUM", needsPriority: false };
  }
  return { urgency: "LOW", needsPriority: false };
}

function daysSince(dateIso: string | null | undefined): number {
  const ts = new Date(String(dateIso || "")).getTime();
  if (!Number.isFinite(ts)) return 0;
  return (Date.now() - ts) / 86400000;
}

function baseScoreByStage(stage: WhatsAppAiStage): number {
  if (stage === "NEW") return 15;
  if (stage === "PRODUCT_INTEREST") return 45;
  if (stage === "QUALIFIED") return 70;
  if (stage === "QUALIFICATION_PENDING") return 45;
  if (stage === "PRICE_SENT") return 75;
  if (stage === "VIDEO_PROPOSED") return 75;
  if (stage === "DEPOSIT_PENDING") return 85;
  if (stage === "CONFIRMED") return 92;
  if (stage === "CONVERTED") return 100;
  return 0;
}

function buildSuggestedMessage(input: {
  stage: WhatsAppAiStage;
  urgency: "LOW" | "MEDIUM" | "HIGH";
  priceSent: boolean;
  noReply48h: boolean;
  qualificationComplete?: boolean;
  missingFields?: QualificationMissingField[];
  pricePolicy?: "NEVER_FIRST" | "AFTER_QUALIFIED";
}): string {
  if (input.stage === "PRODUCT_INTEREST" || input.stage === "NEW") {
    return [
      "Merci pour votre message.",
      "Pour vous accompagner avec précision, pourriez-vous me confirmer la date de votre événement",
      "ainsi que la ville ou le pays de livraison ?"
    ].join("\n");
  }
  if (input.stage === "QUALIFIED") {
    if (input.pricePolicy && input.pricePolicy !== "AFTER_QUALIFIED") {
      return [
        "Parfait, votre qualification est complète.",
        "Je peux vous proposer une courte visio privée pour valider les détails,",
        "puis je vous partagerai le prix contextualisé et le délai de confection."
      ].join("\n");
    }
    if (input.urgency === "HIGH") {
      return [
        "Parfait, nous pouvons prioriser votre pièce pour respecter votre échéance.",
        "Je peux vous partager immédiatement un prix contextualisé et un délai de confection précis.",
        "Si vous le souhaitez, nous pouvons faire un court appel privé dès maintenant."
      ].join("\n");
    }
    return [
      "Parfait, nous sommes alignés sur votre timeline.",
      "Je vais vous partager un prix contextualisé avec délai de confection.",
      "Si utile, je peux aussi organiser une courte visio privée."
    ].join("\n");
  }
  if (input.stage === "PRICE_SENT" && input.noReply48h) {
    return [
      "Je me permets un suivi discret concernant la pièce sélectionnée.",
      "Si vous le souhaitez, je peux réserver votre créneau de confection",
      "et finaliser les derniers détails avec vous."
    ].join("\n");
  }
  if (input.stage === "DEPOSIT_PENDING") {
    return [
      "Merci pour votre retour.",
      "Je peux vous guider en une minute sur l’étape de réservation",
      "et confirmer immédiatement la disponibilité de votre créneau."
    ].join("\n");
  }
  if (input.stage === "CONFIRMED") {
    return [
      "Merci pour votre confirmation.",
      "Je vous partage la prochaine étape de paiement pour bloquer votre créneau,",
      "puis nous lançons la confection."
    ].join("\n");
  }
  return "Je reste à votre disposition pour vous accompagner sur la suite.";
}

export async function classifyLeadWithAi(input: {
  lead: WhatsAppLeadRecord;
  messages: Array<{ direction: "IN" | "OUT"; text: string; createdAt: string }>;
  settings?: AiSettings;
}): Promise<AiClassificationOutput> {
  const lastInbound = input.messages
    .slice()
    .reverse()
    .find((m) => m.direction === "IN");
  const inboundText = String(lastInbound?.text || "").trim();
  const productSignal = containsProductSignal({ lead: input.lead, text: inboundText });
  const explicitPriceInquiry = containsPriceInquiry(inboundText);
  const qSignals = detectQualificationSignals(inboundText);
  const depositIntent = DEPOSIT_PATTERNS.some((p) => p.test(inboundText));
  const urgency = detectUrgency(inboundText);
  const signals: string[] = [];
  if (PRODUCT_URL_PATTERN.test(inboundText)) signals.push("PRODUCT_LINK");
  if (INTEREST_PATTERNS.some((p) => p.test(inboundText))) signals.push("INTEREST");
  if (qSignals.eventDate) signals.push("EVENT_DATE");
  if (qSignals.shipping) signals.push("SHIPPING");
  if (qSignals.sizing) signals.push("SIZING");
  if (explicitPriceInquiry) signals.push("PRICE_REQUEST");
  if (depositIntent) signals.push("DEPOSIT_INTENT");
  if (urgency.needsPriority) signals.push("URGENT_TIMELINE");

  const qualification = computeQualificationStatus(input.lead, { tags: signals });
  if (qualification.hasEventDate && !signals.includes("EVENT_DATE")) signals.push("EVENT_DATE");
  if (qualification.hasDestination && !signals.includes("SHIPPING")) signals.push("SHIPPING");
  if (qualification.hasSizing && !signals.includes("SIZING")) signals.push("SIZING");
  const hasQualificationSignal =
    qSignals.eventDate ||
    qSignals.shipping ||
    qSignals.sizing ||
    qualification.hasEventDate ||
    qualification.hasDestination ||
    qualification.hasSizing;
  let stage: WhatsAppAiStage = "NEW";
  let confidence = 60;
  let explanation = "No strong signal detected; keep qualification flow.";
  if (input.lead.stage === "CONVERTED") {
    stage = "CONVERTED";
    confidence = 100;
    explanation = "Lead already converted from business event.";
  } else if (depositIntent) {
    stage = "DEPOSIT_PENDING";
    confidence = 88;
    explanation = "Deposit/order intent detected in inbound message.";
  } else if (hasQualificationSignal) {
    if (qualification.qualificationComplete) {
      stage = "QUALIFIED";
      confidence = (qSignals.eventDate && (qSignals.shipping || qSignals.sizing)) ? 92 : 86;
      explanation = "Qualification signals detected and required fields are complete.";
    } else {
      stage = "QUALIFICATION_PENDING";
      confidence = 88;
      explanation = `Qualification gating: missing ${qualification.missingFields.join(", ")}.`;
    }
  } else if (productSignal && !explicitPriceInquiry) {
    stage = "QUALIFICATION_PENDING";
    confidence = 86;
    explanation = "Product interest detected; proceed with qualification pending.";
  } else if (explicitPriceInquiry) {
    stage = "PRICE_SENT";
    confidence = 80;
    explanation = "Explicit price inquiry detected; prepare price response stage.";
  }

  const scoreBreakdown: Array<{ label: string; points: number }> = [{ label: `Stage ${stage}`, points: baseScoreByStage(stage) }];
  if (urgency.urgency === "HIGH") scoreBreakdown.push({ label: "Urgency HIGH", points: 15 });
  if (qSignals.eventDate) scoreBreakdown.push({ label: "Event date detected", points: 10 });
  if (qSignals.shipping && String(input.lead.country || "").toUpperCase() !== "MA") {
    scoreBreakdown.push({ label: "International shipping", points: 8 });
  }
  if (daysSince(input.lead.lastActivityAt) > 3) scoreBreakdown.push({ label: "No reply > 72h", points: -15 });
  const score = scoreBreakdown.reduce((sum, x) => sum + x.points, 0);

  const noReply48h = (Date.now() - new Date(String(input.lead.lastActivityAt || "")).getTime()) / 3600000 >= 48;
  const suggestionType: "QUALIFICATION" | "PRICE_CONTEXTUALIZED" =
    stage === "QUALIFIED" ? "PRICE_CONTEXTUALIZED" : "QUALIFICATION";
  const suggestedMessage = (() => {
    if (suggestionType === "QUALIFICATION") {
      const missing = qualification.missingFields.slice(0, 2);
      const asksEvent = missing.includes("EVENT_DATE");
      const asksDestination = missing.includes("DESTINATION");
      if (asksEvent && asksDestination) {
        return "Merci pour votre message. Pour bien vous orienter, pourriez-vous me confirmer la date de votre événement et la ville/pays de livraison ?";
      }
      if (asksEvent) {
        return "Merci pour votre message. Pour finaliser votre qualification, pourriez-vous me confirmer la date de votre événement ?";
      }
      if (asksDestination) {
        return "Merci pour votre message. Pour finaliser votre qualification, pourriez-vous me confirmer la ville/pays de livraison ?";
      }
    }
    return buildSuggestedMessage({
      stage,
      urgency: urgency.urgency,
      priceSent: input.lead.priceSent,
      noReply48h,
      qualificationComplete: qualification.qualificationComplete,
      missingFields: qualification.missingFields,
      pricePolicy: input.settings?.includePricePolicy
    });
  })();

  let nextAction = "Continue qualification flow with clear next-step question.";
  if (stage === "QUALIFICATION_PENDING") nextAction = "Ask only missing qualification fields (event date and/or destination). No price.";
  if (stage === "QUALIFIED") {
    nextAction =
      input.settings?.includePricePolicy === "AFTER_QUALIFIED"
        ? "Send contextualized price + production timeline."
        : "Propose short video call first, then share contextualized price and timeline.";
  }
  if (stage === "PRICE_SENT") nextAction = "Track reply window and follow up elegantly at 48h if silent.";
  if (stage === "DEPOSIT_PENDING") nextAction = "Share payment/reservation instructions and secure production slot.";
  if (String(stage) === "CONFIRMED") nextAction = "Client confirmed in chat; finalize payment and lock production slot.";

  return {
    detected_stage: stage,
    recommended_stage: stage,
    confidence,
    urgency: urgency.urgency,
    signals_detected: Array.from(new Set(signals)),
    qualification_complete: qualification.qualificationComplete,
    missing_fields: qualification.missingFields,
    suggestion_type: suggestionType,
    score,
    score_breakdown: scoreBreakdown,
    suggested_message: suggestedMessage,
    suggested_reply: suggestedMessage,
    recommended_next_action: nextAction,
    explanation
  };
}

export type DraftType = "FIRST_RESPONSE" | "PRICE_CONTEXTUALIZED" | "FOLLOW_UP_48H" | "REFLECTION_72H";

export type SuggestionType =
  | "QUALIFICATION"
  | "PRICE_CONTEXTUALIZED"
  | "NEXT_STEP"
  | "SCHEDULE_VIDEO"
  | "PAYMENT_GUIDE";

export type SuggestionContext = {
  lead: {
    id: string;
    client_name: string;
    country_group: "MA" | "FR" | "INTL";
    current_stage: WhatsAppAiStage;
    recommended_stage: WhatsAppAiStage | null;
    conversion_probability: number;
    last_activity_at: string | null;
  };
  messages: {
    last_inbound_text: string;
    last_outbound_text: string;
    last_10_messages: Array<{ direction: "IN" | "OUT"; text: string; created_at: string }>;
  };
  signals_detected: { tags: string[]; evidence: Array<{ tag: string; match: string; created_at?: string }>; urgency: "LOW" | "MEDIUM" | "HIGH" };
  settings: {
    global: AiSettings;
    byCountryGroup: {
      group: "MA" | "FR" | "INTL";
      language_hint: "FR" | "EN" | "AUTO";
      currency_hint: "MAD" | "EUR" | "USD";
    };
  };
};

export async function generateStageDraft(input: {
  lead: WhatsAppLeadRecord;
  type: DraftType;
  settings?: AiSettings;
}): Promise<{ type: DraftType; text: string; recommended_next_action: string }> {
  const context = leadContext(input.lead);
  const fallbackMap: Record<DraftType, { text: string; action: string }> = {
    FIRST_RESPONSE: {
      text:
        "Merci pour votre message. Pour vous orienter avec précision, pourriez-vous me confirmer la date de votre événement ainsi que la ville/pays de livraison ?",
      action: "Collect event date and delivery location before sharing any price."
    },
    PRICE_CONTEXTUALIZED: {
      text:
        "Parfait, nous sommes dans les délais pour votre date. Le prix de cette pièce est de [à compléter], avec un délai de confection estimé à [à compléter]. Si vous le souhaitez, je peux organiser une courte visio privée.",
      action: "Share structured price and production timeline, then softly propose private video call."
    },
    FOLLOW_UP_48H: {
      text:
        "Je me permets un court suivi concernant la pièce sélectionnée. Si vous le souhaitez, je peux vous aider à finaliser les détails en quelques minutes.",
      action: "Follow up elegantly without pressure."
    },
    REFLECTION_72H: {
      text:
        "Je comprends parfaitement votre réflexion. Si utile, je peux vous préparer un récapitulatif très précis (délais, finitions, livraison) pour vous aider à décider sereinement.",
      action: "Offer precision and reassurance without urgency pressure."
    }
  };
  const fallback = fallbackMap[input.type];
  const instructionByType: Record<DraftType, string> = {
    FIRST_RESPONSE:
      "Write first response for NEW/PRODUCT_INTEREST. No price. Ask exactly two questions: event date and delivery city/country.",
    PRICE_CONTEXTUALIZED:
      "Write contextualized pricing response only after qualification. Must include: timeline validation, price mention placeholder, production time, soft private video proposal.",
    FOLLOW_UP_48H:
      "Write an elegant 48h follow-up after PRICE_SENT without response. No pressure.",
    REFLECTION_72H:
      "Write a 72h follow-up for 'I will think about it' (France style). Precision and accompaniment, no pressure."
  };
  const includePriceAllowed =
    input.settings?.includePricePolicy === "AFTER_QUALIFIED" &&
    ["QUALIFIED", "PRICE_SENT", "VIDEO_PROPOSED", "DEPOSIT_PENDING", "CONFIRMED", "CONVERTED"].includes(String(input.lead.stage || "").toUpperCase());

  const ai = await generateAiText({
    systemPrompt:
      "You write luxury WhatsApp drafts for couture sales operators. Tone: elegant, concise, premium.",
    userPrompt:
      `${instructionByType[input.type]}\n${styleInstruction(input.settings)}\n` +
      `Pricing policy: ${input.settings?.includePricePolicy || "AFTER_QUALIFIED"}.\n` +
      `For FIRST_RESPONSE, do not include any price.\n` +
      `For PRICE_CONTEXTUALIZED, include price only when allowed by policy and lead stage.\n` +
      `Price allowed now: ${includePriceAllowed ? "YES" : "NO"}.\n` +
      `Return only message text.\nLead context:\n${context}`,
    temperature: 0.2,
    maxOutputTokens: 180,
    fallbackText: fallback.text
  });
  let text = String(ai.text || fallback.text).trim();
  if (input.type === "FIRST_RESPONSE") {
    if (input.settings?.includePricePolicy === "NEVER_FIRST") {
      text = text.replace(/\b(price|prix|cost|tarif|combien|how much)\b[^.\n]*/gi, "").trim();
    }
    if (!text) text = fallbackMap.FIRST_RESPONSE.text;
  }
  text = sanitizeMessageBySettings(text, input.settings);
  return {
    type: input.type,
    text,
    recommended_next_action: fallback.action
  };
}

function buildStrategicFacts(lead: WhatsAppLeadRecord): string {
  return JSON.stringify(
    {
      stage: lead.stage,
      event_date: lead.eventDate,
      event_date_text: lead.eventDateText,
      destination:
        lead.shipDestinationText ||
        [lead.shipCity, lead.shipCountry].filter(Boolean).join(", ") ||
        null,
      product_reference: lead.productReference,
      country: lead.country,
      price_sent: lead.priceSent,
      conversion_score: lead.conversionScore,
      ticket_value: lead.ticketValue,
      qualification_tags: lead.qualificationTags,
      intents: {
        price: lead.priceIntent,
        video: lead.videoIntent,
        payment: lead.paymentIntent,
        deposit: lead.depositIntent,
        confirmation: lead.confirmationIntent
      },
      internal_notes: lead.internalNotes ? sanitizeForPrompt(lead.internalNotes, 200) : null
    },
    null,
    2
  );
}

function buildConversationText(messages: Array<{ direction: string; text: string }>): string {
  return messages
    .map((m) => `[${m.direction === "IN" ? "CLIENT" : "BFL"}] ${sanitizeForPrompt(m.text, 400)}`)
    .join("\n");
}

const STRATEGIC_ADVISOR_SYSTEM =
  `You are the Strategic Sales Advisor for Maison BFL, a high-end luxury couture brand.

Your mission:
Analyze a WhatsApp conversation and propose the most intelligent next best action to maximize conversion while preserving quiet luxury positioning.

Brand Identity:
- Refined, structured, calm, confident
- No emojis
- No slang
- No pressure selling
- Elegant and minimal communication

Sales Funnel:
NEW → QUALIFICATION_PENDING → QUALIFIED → PRICE_SENT → DEPOSIT_PENDING → CONFIRMED → CONVERTED

Strategic Rules:
- Do not send price unless minimum qualification is met (event date, destination, sizing/measurements).
- If urgency is high but feasibility uncertain, recommend escalation.
- Never invent missing information.
- Prefer intelligent qualification over rushing to pricing.
- Protect brand positioning at all times.`;

const STRATEGIC_ADVISOR_USER_TEMPLATE =
  `Current Stage:
{{CURRENT_STAGE}}

Extracted Facts (system generated):
{{FACTS_JSON}}

Conversation (chronological):
{{CONVERSATION_TEXT}}

------------------------------------------------------------

OUTPUT REQUIREMENTS

Return a HUMAN-style advisory response.
Do NOT return JSON.
Do NOT use markdown formatting.
Separate sections using empty lines.
Keep it concise and executive-level.

Structure your response EXACTLY as follows:

==================================================

AI SUMMARY
(1-2 sentences explaining what is happening and client intent.)

==================================================

READINESS LEVEL
Low / Medium / High

Key Signals:
- bullet
- bullet

Main Risks:
- bullet
- bullet

==================================================

STRATEGIC DECISION
Recommended Action: (Ask Qualification / Send Contextualized Price / Request Deposit / Confirm Details / Propose Appointment / Escalate)

Stage Movement:
Current -> Suggested

Why This Decision:
- bullet
- bullet

Confidence Score: XX%

==================================================

CLAUDE SUGGESTION BUTTON
Button Label: (Maximum 4 words. Clear and decisive.)
Trigger Type: (QUALIFY / SEND_PRICE / REQUEST_DEPOSIT / CONFIRM / ESCALATE)
Execution Preview:
(One short sentence explaining what pressing this button will do.)

==================================================

DRAFT MESSAGE TO CLIENT
(WhatsApp-ready message, maximum 3 sentences, luxury tone.)

==================================================

MANAGER VALIDATION NOTE
(One short sentence telling the manager what to validate.)`;

export async function generateStrategicAdvisorResponse(input: {
  lead: WhatsAppLeadRecord;
  messages: Array<{ direction: string; text: string }>;
}): Promise<{ text: string; provider: "openai" | "fallback"; model: string }> {
  const facts = buildStrategicFacts(input.lead);
  const conversationText = buildConversationText(input.messages);
  const userPrompt = STRATEGIC_ADVISOR_USER_TEMPLATE
    .replace("{{CURRENT_STAGE}}", String(input.lead.stage || "UNKNOWN"))
    .replace("{{FACTS_JSON}}", facts)
    .replace("{{CONVERSATION_TEXT}}", conversationText);

  const fallbackText = [
    "==================================================",
    "",
    "AI SUMMARY",
    "Strategic analysis is temporarily unavailable. Please review the conversation manually.",
    "",
    "==================================================",
    "",
    "MANAGER VALIDATION NOTE",
    "Review lead facts and conversation manually to determine the next best action."
  ].join("\n");

  return generateAiText({
    systemPrompt: STRATEGIC_ADVISOR_SYSTEM,
    userPrompt,
    temperature: 0.3,
    maxOutputTokens: 900,
    fallbackText
  });
}

function toCountryGroup(country: string | null | undefined): "MA" | "FR" | "INTL" {
  const c = String(country || "").trim().toUpperCase();
  if (c === "MA" || c === "MAROC" || c === "MOROCCO") return "MA";
  if (c === "FR" || c === "FRANCE") return "FR";
  return "INTL";
}

function sanitizeNoPrice(text: string): string {
  return String(text || "")
    .replace(/\b\d{2,6}\s?(mad|eur|usd|dh|€|\$)\b/gi, "")
    .replace(/(?:prix|price|cost|tarif)\s*[:\-]?\s*\S+/gi, "")
    .trim();
}

function deriveSuggestionType(stage: WhatsAppAiStage): SuggestionType {
  if (stage === "NEW" || stage === "PRODUCT_INTEREST" || stage === "QUALIFICATION_PENDING") return "QUALIFICATION";
  if (stage === "QUALIFIED") return "PRICE_CONTEXTUALIZED";
  if (stage === "PRICE_SENT") return "NEXT_STEP";
  if (stage === "VIDEO_PROPOSED") return "NEXT_STEP";
  if (stage === "DEPOSIT_PENDING" || stage === "CONFIRMED") return "PAYMENT_GUIDE";
  throw new Error(`unsupported_stage_for_suggestion:${stage}`);
}

function pickTopSignals(tags: string[], limit = 3): string[] {
  const preferred = ["URGENT_TIMELINE", "EVENT_DATE", "SHIPPING", "INTERNATIONAL", "SIZING", "PRICE_REQUEST", "PRODUCT_LINK", "INTEREST"];
  const set = new Set((tags || []).map((t) => String(t || "").toUpperCase()));
  const sorted = preferred.filter((t) => set.has(t));
  const extra = Array.from(set).filter((t) => !preferred.includes(t));
  return [...sorted, ...extra].slice(0, limit);
}

function fallbackSuggestionText(input: {
  suggestionType: SuggestionType;
  countryGroup: "MA" | "FR" | "INTL";
  explicitPriceQuestion: boolean;
}): { text: string; why: string; nextAction: string } {
  if (input.suggestionType === "QUALIFICATION") {
    if (input.explicitPriceQuestion) {
      return {
        text: "Merci pour votre message. Pour vous donner un prix juste et précis, pourriez-vous me confirmer la date de votre événement ? Je vous partage le prix juste après.",
        why: "Qualification: price question detected, asked one qualifier before price.",
        nextAction: "Collect event date then send contextualized price."
      };
    }
    return {
      text: "Merci pour votre intérêt. Pour vous orienter avec précision, pourriez-vous me confirmer la date de votre événement ainsi que la ville/pays de livraison ?",
      why: "Qualification: asked event date + shipping location, no price.",
      nextAction: "Collect qualification details before sharing price."
    };
  }
  if (input.suggestionType === "PRICE_CONTEXTUALIZED") {
    const currency = input.countryGroup === "FR" ? "EUR" : input.countryGroup === "MA" ? "MAD" : "USD";
    return {
      text: `Parfait, nous sommes dans les délais pour votre date. Le prix de cette pièce est de [PRIX ${currency}] avec un délai de confection de [DÉLAI]. Si utile, je peux organiser une courte visio privée.`,
      why: "Qualified stage: contextualized price + production timeline + optional video call.",
      nextAction: "Send pricing details and secure commitment."
    };
  }
  if (input.suggestionType === "NEXT_STEP") {
    return {
      text: "Merci pour votre retour. Si vous le souhaitez, nous pouvons valider les mesures finales et organiser une courte visio privée pour confirmer les détails avant réservation.",
      why: "Price already sent: moved to decision support without repeating price.",
      nextAction: "Advance toward reservation with measurements/video."
    };
  }
  if (input.suggestionType === "SCHEDULE_VIDEO") {
    return {
      text: "Avec plaisir. Je peux vous proposer une courte visio privée demain à 11h00 ou à 16h30. Dites-moi le créneau qui vous convient le mieux.",
      why: "Video proposed stage: offered two concrete slots.",
      nextAction: "Book video call slot."
    };
  }
  return {
    text: "Parfait. Pour finaliser votre réservation, je peux vous envoyer les étapes d’acompte et le lien de facture sécurisé dès maintenant.",
    why: "Deposit pending stage: provided payment next step.",
    nextAction: "Share payment guide/invoice link."
  };
}

export async function generateContextAwareSuggestion(input: { context: SuggestionContext }): Promise<{
  text: string;
  suggestion_type: SuggestionType;
  why: string;
  based_on: string;
}> {
  const ctx = input.context;
  const stage = ctx.lead.current_stage;
  const suggestionType = deriveSuggestionType(stage);
  const explicitPriceQuestion = /\b(price|prix|combien|how\s+much|cost)\b/i.test(ctx.messages.last_inbound_text || "");
  const fallback = fallbackSuggestionText({
    suggestionType,
    countryGroup: ctx.lead.country_group,
    explicitPriceQuestion
  });

  const includePriceAllowed =
    suggestionType !== "QUALIFICATION" &&
    ctx.settings.global.includePricePolicy !== "NEVER_FIRST";
  const priceRule = includePriceAllowed
    ? "Price may be included where relevant."
    : "Do NOT include any price in this message.";

  const ai = await generateAiText({
    systemPrompt: "You write one WhatsApp sales message for couture client conversion. Keep it elegant, concise, premium.",
    userPrompt:
      `Stage: ${stage}\nSuggestionType: ${suggestionType}\n` +
      `Last inbound message (must be addressed): "${sanitizeForPrompt(ctx.messages.last_inbound_text, 300)}"\n` +
      `Last outbound message: "${sanitizeForPrompt(ctx.messages.last_outbound_text, 300)}"\n` +
      `Country group: ${ctx.lead.country_group}\n` +
      `Signals (max 3): ${pickTopSignals(ctx.signals_detected.tags, 3).join(", ") || "none"}\n` +
      `Urgency: ${ctx.signals_detected.urgency}\n` +
      `${styleInstruction(ctx.settings.global)}\n` +
      `${priceRule}\n` +
      `Hard rules:\n` +
      `- QUALIFICATION: ask event date + shipping city/country, no price.\n` +
      `- PRICE_CONTEXTUALIZED: include timeline validation + price + production time + optional video call.\n` +
      `- NEXT_STEP: do not repeat price, propose video/measurements/reservation.\n` +
      `- SCHEDULE_VIDEO: propose exactly two time slots.\n` +
      `- PAYMENT_GUIDE: provide deposit next step with invoice link placeholder.\n` +
      `Return one message only under ${ctx.settings.global.messageLength === "MEDIUM" ? "5" : "4"} lines.`,
    temperature: 0.2,
    maxOutputTokens: 170,
    fallbackText: fallback.text
  });

  let text = sanitizeMessageBySettings(String(ai.text || fallback.text), ctx.settings.global);
  if (suggestionType === "QUALIFICATION" || !includePriceAllowed) {
    text = sanitizeNoPrice(text) || sanitizeNoPrice(fallback.text);
  }

  return {
    text: text.trim(),
    suggestion_type: suggestionType,
    why: fallback.why,
    based_on: "last inbound message + current stage"
  };
}
