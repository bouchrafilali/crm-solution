import type {
  WhatsAppDetectedSignals,
  WhatsAppLeadRecord,
  WhatsAppLeadStage,
  WhatsAppRuleTriggered,
  WhatsAppSignalEvidence
} from "../db/whatsappLeadsRepo.js";

type RuleTag = "INTERNATIONAL" | "SIZING" | "EVENT_DATE" | "RESERVATION_INTENT" | "URGENCY";
type SignalTag =
  | "PRODUCT_LINK"
  | "INTEREST"
  | "EVENT_DATE"
  | "SHIPPING"
  | "SIZING"
  | "RESERVATION_INTENT"
  | "URGENCY";

export type RuleQualificationResult = {
  tags: SignalTag[];
  recommendedStage: WhatsAppLeadStage | null;
  intentLevel: "LOW" | "MEDIUM" | "HIGH" | null;
  stageAutoReason: string | null;
  recommendedStageReason: string | null;
  confidence: number | null;
  detectedSignals: WhatsAppDetectedSignals;
};

export type QualificationMissingField = "EVENT_DATE" | "DESTINATION";

export type QualificationStatus = {
  qualificationComplete: boolean;
  missingFields: QualificationMissingField[];
  hasEventDate: boolean;
  hasDestination: boolean;
  hasSizing: boolean;
};

const RULES: Array<{ tag: SignalTag; patterns: RegExp[] }> = [
  {
    tag: "SHIPPING",
    patterns: [/international/i, /shipping/i, /livraison/i, /worldwide/i, /douane/i, /paris/i, /france/i]
  },
  {
    tag: "SIZING",
    patterns: [/size/i, /measurement/i, /mesure/i, /taille/i, /tour\s+de/i]
  },
  {
    tag: "EVENT_DATE",
    patterns: [
      /event/i,
      /wedding/i,
      /mariage/i,
      /date/i,
      /ceremon/i,
      /occasion/i,
      /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}\b/i,
      /\b\d{1,2}\s+(janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[ûu]t|septembre|octobre|novembre|d[ée]cembre)\b/i,
      /\b\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?\b/i
    ]
  },
  {
    tag: "RESERVATION_INTENT",
    patterns: [/reserve/i, /book/i, /bloquer/i, /hold/i, /acompte/i, /deposit/i]
  },
  {
    tag: "URGENCY",
    patterns: [/urgent/i, /asap/i, /rapid/i, /quick/i, /soon/i, /vite/i]
  }
];

const PRICE_INQUIRY_PATTERNS: RegExp[] = [
  /\bprice\b/i,
  /\bhow\s+much\b/i,
  /\bcombien\b/i,
  /\bprix\b/i,
  /\btarif\b/i,
  /\bcost\b/i
];

const INTEREST_PATTERNS: RegExp[] = [
  /\binterested\b/i,
  /\binterest\b/i,
  /\bint[ée]ress[ée]?\b/i,
  /\bj[' ]?aime\b/i,
  /\bi\s+like\b/i,
  /\blove\b/i,
  /\badore\b/i
];

const PRODUCT_URL_PATTERN = /\/products\//i;

function hasPriceInquiry(text: string): boolean {
  return PRICE_INQUIRY_PATTERNS.some((pattern) => pattern.test(text));
}

function hasProductInterestSignal(lead: WhatsAppLeadRecord, text: string): boolean {
  const hasUrl = PRODUCT_URL_PATTERN.test(text);
  const hasInterest = INTEREST_PATTERNS.some((pattern) => pattern.test(text));
  const hasProductName = Boolean(String(lead.productReference || "").trim());
  return hasUrl || (hasProductName && hasInterest);
}

export function computeQualificationStatus(
  lead: Pick<WhatsAppLeadRecord, "eventDate" | "eventDateText" | "shipCity" | "shipCountry" | "shipDestinationText" | "qualificationTags" | "detectedSignals" | "internalNotes">,
  options?: { tags?: string[] }
): QualificationStatus {
  const hasEventDate = Boolean(String(lead.eventDate || "").trim() || String(lead.eventDateText || "").trim());
  const hasDestination = Boolean(
    String(lead.shipCity || "").trim() ||
    String(lead.shipCountry || "").trim() ||
    String(lead.shipDestinationText || "").trim()
  );
  const mergedTags = new Set(
    [
      ...(lead.qualificationTags || []),
      ...(Array.isArray(lead.detectedSignals?.tags) ? lead.detectedSignals.tags : []),
      ...(options?.tags || [])
    ]
      .map((t) => String(t || "").trim().toUpperCase())
      .filter(Boolean)
  );
  const hasSizingTag = mergedTags.has("SIZING");
  const hasMeasurementState = /\b(measure|measurement|taille|mesure|sizing)\b/i.test(String(lead.internalNotes || ""));
  const hasSizing = hasSizingTag || hasMeasurementState;
  const missingFields: QualificationMissingField[] = [];
  if (!hasEventDate) missingFields.push("EVENT_DATE");
  if (!hasDestination) missingFields.push("DESTINATION");
  return {
    qualificationComplete: missingFields.length === 0,
    missingFields,
    hasEventDate,
    hasDestination,
    hasSizing
  };
}

export function detectQualificationTags(text: string): SignalTag[] {
  const clean = String(text || "").trim();
  if (!clean) return [];
  const found = new Set<SignalTag>();
  for (const rule of RULES) {
    if (rule.patterns.some((p) => p.test(clean))) {
      found.add(rule.tag);
    }
  }
  return Array.from(found);
}

function extractEvidenceEntries(input: {
  inboundText: string;
  messageId: string;
  createdAt: string;
}): { tags: SignalTag[]; evidence: WhatsAppSignalEvidence[] } {
  const clean = String(input.inboundText || "").trim();
  if (!clean) return { tags: [], evidence: [] };
  const tags: SignalTag[] = [];
  const evidence: WhatsAppSignalEvidence[] = [];
  for (const rule of RULES) {
    let matchedText = "";
    for (const pattern of rule.patterns) {
      pattern.lastIndex = 0;
      const match = clean.match(pattern);
      if (match && match[0]) {
        matchedText = String(match[0]).slice(0, 240);
        break;
      }
    }
    if (!matchedText) continue;
    tags.push(rule.tag);
    evidence.push({
      tag: rule.tag,
      match: matchedText,
      message_id: input.messageId,
      created_at: input.createdAt
    });
  }
  return { tags, evidence };
}

export function mergeTags(existing: string[], newlyDetected: string[]): string[] {
  return Array.from(new Set([...(existing || []), ...(newlyDetected || [])].map((v) => String(v || "").trim()).filter(Boolean)));
}

export function computeRuleQualification(
  lead: WhatsAppLeadRecord,
  inboundText: string,
  context?: { messageId?: string; createdAt?: string }
): RuleQualificationResult {
  const messageId = String(context?.messageId || "").trim() || "inline";
  const createdAt = String(context?.createdAt || new Date().toISOString());
  const cleanText = String(inboundText || "").trim();
  const extracted = extractEvidenceEntries({ inboundText, messageId, createdAt });
  const detected = extracted.tags.length ? extracted.tags : detectQualificationTags(inboundText);
  const merged = mergeTags(lead.qualificationTags || [], detected) as SignalTag[];
  const previousEvidence = Array.isArray(lead.detectedSignals?.evidence) ? lead.detectedSignals.evidence : [];
  const dedupEvidence = new Map<string, WhatsAppSignalEvidence>();
  for (const item of [...previousEvidence, ...extracted.evidence]) {
    const key = `${item.tag}|${item.message_id}|${item.match}`;
    if (!dedupEvidence.has(key)) dedupEvidence.set(key, item);
  }
  const evidence = Array.from(dedupEvidence.values()).slice(-30);
  const rulesTriggered: WhatsAppRuleTriggered[] = Array.isArray(lead.detectedSignals?.rules_triggered)
    ? [...lead.detectedSignals.rules_triggered]
    : [];

  const hasProductLink = PRODUCT_URL_PATTERN.test(cleanText);
  const hasInterestKeyword = INTEREST_PATTERNS.some((pattern) => pattern.test(cleanText));
  const productInterest = hasProductInterestSignal(lead, cleanText);
  const asksPrice = hasPriceInquiry(cleanText);
  const hasPriceAlreadySent = Boolean(lead.priceSent);
  if (hasProductLink && !merged.includes("PRODUCT_LINK")) merged.push("PRODUCT_LINK");
  if (hasInterestKeyword && !merged.includes("INTEREST")) merged.push("INTEREST");
  if (hasProductLink) {
    const key = `PRODUCT_LINK|${messageId}|/products/`;
    if (!dedupEvidence.has(key)) {
      dedupEvidence.set(key, {
        tag: "PRODUCT_LINK",
        match: "/products/",
        message_id: messageId,
        created_at: createdAt
      });
    }
  }
  if (hasInterestKeyword) {
    const interestMatch = INTEREST_PATTERNS.map((pattern) => cleanText.match(pattern)).find((m) => m && m[0]);
    const matchText = interestMatch && interestMatch[0] ? String(interestMatch[0]).slice(0, 120) : "interest";
    const key = `INTEREST|${messageId}|${matchText}`;
    if (!dedupEvidence.has(key)) {
      dedupEvidence.set(key, {
        tag: "INTEREST",
        match: matchText,
        message_id: messageId,
        created_at: createdAt
      });
    }
  }
  const mergedEvidence = Array.from(dedupEvidence.values()).slice(-30);

  if (productInterest && !asksPrice && !hasPriceAlreadySent) {
    const reason = "Product-specific interest detected without explicit price inquiry.";
    rulesTriggered.push({
      rule: "PRODUCT_INTEREST_NO_PRICE_INQUIRY",
      details: "product link/interest detected and no explicit pricing question"
    });
    return {
      tags: merged,
      recommendedStage: "PRODUCT_INTEREST",
      intentLevel: "MEDIUM",
      stageAutoReason: reason,
      recommendedStageReason: "Send structured price + production time response.",
      confidence: 0.84,
      detectedSignals: {
        tags: merged,
        rules_triggered: rulesTriggered.slice(-20),
        evidence: mergedEvidence
      }
    };
  }

  const hasEventDate = merged.includes("EVENT_DATE");
  const hasShipping = merged.includes("SHIPPING");
  const hasSizing = merged.includes("SIZING");
  const hasQualificationSignal = hasEventDate || hasShipping || hasSizing;
  if (hasQualificationSignal) {
    const qualification = computeQualificationStatus(lead, { tags: merged });
    const signalReason = `Qualification signals detected: ${[
      hasEventDate ? "EVENT_DATE" : "",
      hasShipping ? "SHIPPING" : "",
      hasSizing ? "SIZING" : ""
    ].filter(Boolean).join("+")}`;
    const missingReason = qualification.missingFields.map((field) => (field === "EVENT_DATE" ? "EVENT_DATE" : "DESTINATION")).join(", ");
    const reason = qualification.qualificationComplete
      ? signalReason
      : `${signalReason}. Missing required fields: ${missingReason}.`;
    rulesTriggered.push({
      rule: "QUALIFICATION_SIGNAL",
      details: reason
    });
    if (!qualification.qualificationComplete) {
      return {
        tags: merged,
        recommendedStage: "QUALIFICATION_PENDING",
        intentLevel: "MEDIUM",
        stageAutoReason: reason,
        recommendedStageReason: `Qualification gating active. Missing: ${missingReason}.`,
        confidence: 0.86,
        detectedSignals: {
          tags: merged,
          rules_triggered: rulesTriggered.slice(-20),
          evidence: mergedEvidence
        }
      };
    }
    const isHighIntent = qualification.hasEventDate && (qualification.hasDestination || qualification.hasSizing);
    return {
      tags: merged,
      recommendedStage: "QUALIFIED",
      intentLevel: isHighIntent ? "HIGH" : "MEDIUM",
      stageAutoReason: reason,
      recommendedStageReason: reason,
      confidence: isHighIntent ? 0.9 : 0.78,
      detectedSignals: {
        tags: merged,
        rules_triggered: rulesTriggered.slice(-20),
        evidence: mergedEvidence
      }
    };
  }

  return {
    tags: merged,
    recommendedStage: null,
    intentLevel: null,
    stageAutoReason: null,
    recommendedStageReason: null,
    confidence: null,
    detectedSignals: {
      tags: merged,
      rules_triggered: rulesTriggered.slice(-20),
      evidence: mergedEvidence
    }
  };
}
