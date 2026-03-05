import type { WhatsAppLeadRecord } from "../db/whatsappLeadsRepo.js";
import {
  getCountrySettings,
  getGlobalSettings,
  listKeywordRules,
  listReplyTemplates,
  listStageRules,
  type CountryGroup,
  type KeywordRule,
  type RuleLanguage,
  type RuleTag
} from "../db/whatsappIntelligenceSettingsRepo.js";
import { computeQualificationStatus, type QualificationMissingField } from "./leadQualificationService.js";

export type SuggestionMessage = { direction: "IN" | "OUT"; text: string; created_at: string };

function toCountryGroup(country: string | null | undefined): CountryGroup {
  const c = String(country || "").trim().toUpperCase();
  if (c === "MA" || c === "MAROC" || c === "MOROCCO") return "MA";
  if (c === "FR" || c === "FRANCE") return "FR";
  return "INTL";
}

function inferLanguage(text: string, fallback: RuleLanguage = "FR"): RuleLanguage {
  const t = String(text || "").toLowerCase();
  if (/\b(the|price|shipping|how much|interested|next week)\b/.test(t)) return "EN";
  if (/[éèàùç]|\b(prix|livraison|mariage|intéressé)\b/.test(t)) return "FR";
  return fallback;
}

function dedupe<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

function detectTags(text: string, rules: KeywordRule[]) {
  const raw = String(text || "");
  const lower = raw.toLowerCase();
  const tags: RuleTag[] = [];
  const evidence: Array<{ tag: RuleTag; match: string }> = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    let matched = false;
    for (const kw of rule.keywords || []) {
      const k = String(kw || "").trim().toLowerCase();
      if (!k) continue;
      if (lower.includes(k)) {
        matched = true;
        evidence.push({ tag: rule.tag, match: kw });
        break;
      }
    }
    if (!matched) {
      for (const p of rule.patterns || []) {
        try {
          const re = new RegExp(p, "i");
          const m = raw.match(re);
          if (m) {
            matched = true;
            evidence.push({ tag: rule.tag, match: m[0] });
            break;
          }
        } catch {
          // ignore bad regex
        }
      }
    }
    if (matched) tags.push(rule.tag);
  }
  if (/\/products\//i.test(raw)) {
    tags.push("PRODUCT_LINK");
    evidence.push({ tag: "PRODUCT_LINK", match: "/products/" });
  }
  return { tags: dedupe(tags), evidence };
}

function applyStageRules(
  currentStage: string,
  tags: RuleTag[],
  stageRules: Array<{
    rule_name: string;
    required_tags: string[];
    forbidden_tags: string[];
    recommended_stage: string;
    priority: number;
    enabled: boolean;
  }>
) {
  const tagSet = new Set(tags.map((t) => String(t).toUpperCase()));
  const sorted = stageRules
    .filter((r) => r.enabled)
    .slice()
    .sort((a, b) => Number(a.priority || 100) - Number(b.priority || 100));

  for (const rule of sorted) {
    const required = (rule.required_tags || []).map((x) => String(x).toUpperCase());
    const forbidden = (rule.forbidden_tags || []).map((x) => String(x).toUpperCase());
    const requiredOk = required.every((r) => tagSet.has(r));
    const forbiddenOk = forbidden.every((f) => !tagSet.has(f));
    if (requiredOk && forbiddenOk) {
      return {
        recommended_stage: String(rule.recommended_stage || currentStage),
        rule_applied: rule.rule_name
      };
    }
  }
  return { recommended_stage: String(currentStage), rule_applied: "fallback_current_stage" };
}

function suggestionTypeForStage(stage: string): "QUALIFICATION" | "PRICE_CONTEXTUALIZED" | "NEXT_STEP" | "SCHEDULE_VIDEO" | "PAYMENT_GUIDE" {
  const s = String(stage || "").toUpperCase();
  if (s === "NEW" || s === "PRODUCT_INTEREST" || s === "QUALIFICATION_PENDING") return "QUALIFICATION";
  if (s === "QUALIFIED") return "PRICE_CONTEXTUALIZED";
  if (s === "PRICE_SENT") return "NEXT_STEP";
  if (s === "DEPOSIT_PENDING" || s === "CONFIRMED") return "PAYMENT_GUIDE";
  throw new Error(`unknown_stage:${stage}`);
}

function normalizeOfficialStage(stage: string): string {
  const s = String(stage || "").toUpperCase();
  if (s === "PRODUCT_INTEREST") return "QUALIFICATION_PENDING";
  if (s === "VIDEO_PROPOSED") return "PRICE_SENT";
  return s;
}

function countryMessageProfile(country: string | null | undefined): { currency: string; tone: "FR" | "US" | "INTL" } {
  const c = String(country || "").trim().toUpperCase();
  if (c === "MA" || c === "MAROC" || c === "MOROCCO") return { currency: "DHS", tone: "FR" };
  if (c === "FR" || c === "FRANCE") return { currency: "€", tone: "FR" };
  if (c === "US" || c === "USA" || c === "UNITED STATES") return { currency: "$", tone: "US" };
  return { currency: "€", tone: "INTL" };
}

function hasPaymentQuestionText(text: string): boolean {
  const raw = String(text || "");
  return /\b(comment\s+je\s+paye|paiement|acompte|how\s+can\s+i\s+pay|payment|deposit)\b/i.test(raw);
}

function isPriceSilent48h(messages: SuggestionMessage[]): boolean {
  const ordered = (Array.isArray(messages) ? messages : [])
    .slice()
    .sort((a, b) => new Date(String(a.created_at || "")).getTime() - new Date(String(b.created_at || "")).getTime());
  let latestPriceOutboundAt: number | null = null;
  for (const msg of ordered) {
    if (String(msg.direction || "").toUpperCase() !== "OUT") continue;
    const text = String(msg.text || "");
    if (/\b(le\s+prix\s+est|price\s+is|priced\s+at|prix)\b/i.test(text) || /\b(?:mad|dhs?|dh|€|\$|eur|usd)\s*[0-9]/i.test(text)) {
      latestPriceOutboundAt = new Date(String(msg.created_at || "")).getTime();
    }
  }
  if (!Number.isFinite(Number(latestPriceOutboundAt))) return false;
  for (const msg of ordered) {
    const ts = new Date(String(msg.created_at || "")).getTime();
    if (ts <= Number(latestPriceOutboundAt)) continue;
    if (String(msg.direction || "").toUpperCase() === "IN") return false;
  }
  return (Date.now() - Number(latestPriceOutboundAt)) >= 48 * 3600 * 1000;
}

function applyGlobalTextPolicies(text: string, opts: { noEmojis: boolean; avoidFollowUpPhrase: boolean; maxLines: number }) {
  let out = String(text || "").trim();
  if (opts.noEmojis) out = out.replace(/[\p{Extended_Pictographic}\u{1F000}-\u{1FAFF}]/gu, "").trim();
  if (opts.avoidFollowUpPhrase) out = out.replace(/\bfollow[\s-]?up\b/gi, "message").trim();
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, Math.max(1, opts.maxLines));
  return lines.join("\n");
}

function enforceNoPriceInFirstResponse(text: string): string {
  return String(text || "")
    .replace(/\{price\}/gi, "")
    .replace(/\[(price|prix)\]/gi, "")
    .replace(/\b(?:mad|eur|usd)\s*\d{2,6}\b/gi, "")
    .replace(/\b\d{2,6}(?:[.,]\d{1,2})?\s?(mad|eur|usd|dh|€|\$)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function formatEventDateLabel(lead: WhatsAppLeadRecord): string {
  const rawText = String(lead.eventDateText || "").trim();
  if (rawText) return rawText;
  const rawIso = String(lead.eventDate || "").trim();
  if (!rawIso) return "[date événement]";
  const d = new Date(rawIso);
  if (Number.isNaN(d.getTime())) return "[date événement]";
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
}

function defaultProductionTimeLabel(lead: WhatsAppLeadRecord): string {
  const c = String(lead.country || "").trim().toUpperCase();
  if (c === "MA" || c === "MAROC" || c === "MOROCCO") return "3 semaines";
  if (c === "FR" || c === "FRANCE") return "4 semaines";
  return "4 weeks";
}

function renderPlaceholders(template: string, lead: WhatsAppLeadRecord): string {
  const tokens: Record<string, string> = {
    client_name: String(lead.clientName || "Client"),
    country: String(lead.country || "-"),
    event_date: formatEventDateLabel(lead),
    event_date_human: formatEventDateLabel(lead),
    product_title: String(lead.productReference || "[pièce]"),
    price: "[prix]",
    production_time: defaultProductionTimeLabel(lead),
    invoice_link: "[lien facture]"
  };
  const rendered = String(template || "").replace(/\{([a-z_]+)\}/gi, (_m, key) => tokens[String(key || "").toLowerCase()] ?? "");
  const eventDate = tokens.event_date;
  return rendered
    .replace(/\[date événement\]/gi, eventDate)
    .replace(/\[date evenement\]/gi, eventDate);
}

function inboundLooksQualified(text: string): boolean {
  const raw = String(text || "");
  if (!raw) return false;
  const hasDateHint =
    /\b(demain|après[-\s]?demain|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|next week|tomorrow|today)\b/i.test(raw) ||
    /\b\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?\b/.test(raw) ||
    /\b\d{1,2}\s+(janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[ûu]t|septembre|octobre|novembre|d[ée]cembre)\b/i.test(raw);
  const hasDestinationHint =
    /\b(paris|madrid|casablanca|rabat|marrakech|tanger|fes|barcelona|london|dubai)\b/i.test(raw) ||
    /,\s*[a-zà-ÿ][a-zà-ÿ' -]{2,}/i.test(raw);
  return hasDateHint && hasDestinationHint;
}

export async function suggestReplyRulesFirst(input: {
  lead: WhatsAppLeadRecord;
  messages: SuggestionMessage[];
  targetStage?: string;
}): Promise<{
  suggested_message: string;
  stage_used: string;
  tags_detected: string[];
  rule_applied: string;
  suggestion_type: string;
  suggestionType: "QUALIFICATION" | "PRICE_CONTEXTUALIZED" | "FOLLOW_UP" | "DEPOSIT_STEP" | "CONFIRMATION_STEP";
  recommended_stage: string;
  qualification_complete: boolean;
  missing_fields: QualificationMissingField[];
  suggested_reply: string;
  why: string;
}> {
  const lead = input.lead;
  const messages = Array.isArray(input.messages) ? input.messages.slice(-10) : [];
  const lastInbound = messages.slice().reverse().find((m) => String(m.direction || "").toUpperCase() === "IN");
  if (!lastInbound) throw new Error("no_inbound_message");

  const countryGroup = toCountryGroup(lead.country);
  const globalSettings = await getGlobalSettings();
  const countrySettings = await getCountrySettings(countryGroup);
  const language: RuleLanguage =
    countrySettings?.language === "FR"
      ? "FR"
      : countrySettings?.language === "EN"
        ? "EN"
        : inferLanguage(lastInbound.text, countryGroup === "INTL" ? "EN" : "FR");

  const keywordRules = await listKeywordRules(language);
  const stageRules = await listStageRules();
  const detected = detectTags(lastInbound.text, keywordRules);
  const applied = applyStageRules(lead.stage, detected.tags, stageRules);
  const qualification = computeQualificationStatus(lead, { tags: detected.tags });
  const inlineQualified = inboundLooksQualified(lastInbound.text);
  const qualificationComplete = qualification.qualificationComplete || inlineQualified;
  const hasQualificationSignal = detected.tags.includes("EVENT_DATE") || detected.tags.includes("SHIPPING") || detected.tags.includes("SIZING");
  const initialStage = normalizeOfficialStage(String(input.targetStage || applied.recommended_stage || lead.stage).toUpperCase());
  const shouldGate =
    hasQualificationSignal &&
    ["NEW", "PRODUCT_INTEREST", "QUALIFICATION_PENDING", "QUALIFIED"].includes(initialStage);
  const stageUsed = shouldGate
    ? (qualificationComplete ? "QUALIFIED" : "QUALIFICATION_PENDING")
    : qualificationComplete &&
      ["NEW", "PRODUCT_INTEREST", "QUALIFICATION_PENDING"].includes(initialStage)
      ? "QUALIFIED"
      : initialStage;
  const suggestionType = suggestionTypeForStage(stageUsed);
  const profile = countryMessageProfile(lead.country);
  const paymentQuestionDetected =
    Boolean(lead.hasPaymentQuestion) ||
    detected.tags.includes("PAYMENT") ||
    hasPaymentQuestionText(lastInbound.text);
  const silent48hAfterPrice = stageUsed === "PRICE_SENT" && isPriceSilent48h(messages);
  const funnelSuggestionType: "QUALIFICATION" | "PRICE_CONTEXTUALIZED" | "FOLLOW_UP" | "DEPOSIT_STEP" | "CONFIRMATION_STEP" =
    stageUsed === "QUALIFIED"
      ? "PRICE_CONTEXTUALIZED"
      : stageUsed === "PRICE_SENT"
        ? (paymentQuestionDetected ? "DEPOSIT_STEP" : "FOLLOW_UP")
      : stageUsed === "DEPOSIT_PENDING"
        ? "DEPOSIT_STEP"
        : stageUsed === "CONFIRMED"
            ? "CONFIRMATION_STEP"
            : "QUALIFICATION";

  const templates = await listReplyTemplates({ stage: stageUsed, language, country_group: countryGroup });
  const globalTemplates = templates.length ? templates : await listReplyTemplates({ stage: stageUsed, language, country_group: "GLOBAL" });
  const selected = (globalTemplates.find((t) => t.enabled) || globalTemplates[0]) ?? null;
  let text = selected ? renderPlaceholders(selected.text, lead) : "";
  const hasPriceRequest = detected.tags.includes("PRICE_REQUEST");

  if (!text) {
    text =
      suggestionType === "QUALIFICATION"
        ? "Merci pour votre message. Pour vous orienter avec précision, pourriez-vous me confirmer la date de votre événement et la ville/pays de livraison ?"
        : suggestionType === "PRICE_CONTEXTUALIZED"
          ? "Parfait, nous sommes dans les délais. Le prix est de [prix] avec un délai de confection de [délai]. Si vous le souhaitez, je peux vous proposer une courte visio privée pour valider les détails."
          : suggestionType === "NEXT_STEP"
            ? "Merci pour votre retour. Si vous le souhaitez, nous pouvons valider les mesures et réserver votre créneau."
            : suggestionType === "SCHEDULE_VIDEO"
              ? "Je peux vous proposer une visio privée demain à 11h00 ou 16h30. Quel créneau préférez-vous ?"
              : "Parfait. Voici la prochaine étape d’acompte: [lien facture].";
  }

  if (funnelSuggestionType === "QUALIFICATION") {
    const missing = qualification.missingFields.map((field) => String(field).toUpperCase());
    if (missing.includes("EVENT_DATE") && missing.includes("DESTINATION")) {
      text = "Merci pour votre message. Pour vous guider précisément, pourriez-vous me confirmer la date de votre événement et la ville/pays de livraison ?";
    } else if (missing.includes("EVENT_DATE")) {
      text = "Merci pour votre retour. Pouvez-vous me confirmer uniquement la date de votre événement ?";
    } else if (missing.includes("DESTINATION")) {
      text = "Merci pour votre retour. Pouvez-vous me confirmer uniquement la ville/pays de livraison ?";
    }
  }

  if (stageUsed === "QUALIFIED") {
    text =
      "Parfait, nous sommes dans les délais pour {event_date}. Le prix est de [prix] " + profile.currency + " avec un délai de confection de [délai]. Si vous le souhaitez, nous pouvons faire une courte visio privée.";
    text = renderPlaceholders(text, lead);
  }

  if (stageUsed === "PRICE_SENT") {
    if (paymentQuestionDetected || lead.hasDepositLinkSent) {
      text = "Parfait, je peux vous envoyer le lien d’acompte sécurisé pour bloquer votre créneau de confection.";
    } else {
      const productionTime = profile.tone === "US" ? "4 weeks" : "3 semaines";
      text = "Parfait, nous sommes dans les délais pour {event_date_human}. Le prix est de [prix] " + profile.currency + ", avec un délai de confection d’environ " + productionTime + ". Si vous le souhaitez, je peux organiser une courte visio privée.";
      text = renderPlaceholders(text, lead);
      if (silent48hAfterPrice) {
        text += profile.tone === "US"
          ? "\nIf helpful, I can guide you through the next step at your pace."
          : "\nSi vous le souhaitez, je peux vous guider sur la prochaine étape, à votre rythme.";
      }
    }
  }

  if (stageUsed === "CONFIRMED") {
    text = "Parfait, merci pour votre confirmation. Souhaitez-vous que je vous envoie le lien d’acompte/checkout ou que nous validions d’abord les mesures ?";
  }

  const noPriceFirst = funnelSuggestionType === "QUALIFICATION" || countrySettings?.price_policy === "NEVER_FIRST";
  if (noPriceFirst) text = enforceNoPriceInFirstResponse(text);

  text = applyGlobalTextPolicies(text, {
    noEmojis: Boolean(globalSettings.no_emojis),
    avoidFollowUpPhrase: Boolean(globalSettings.avoid_follow_up_phrase),
    maxLines: globalSettings.message_length === "MEDIUM" ? 5 : 4
  });

  if (globalSettings.signature_enabled && globalSettings.signature_text && !text.endsWith(globalSettings.signature_text)) {
    text = `${text}\n${globalSettings.signature_text}`.trim();
  }

  return {
    suggested_message: text,
    suggested_reply: text,
    stage_used: stageUsed,
    recommended_stage: stageUsed,
    tags_detected: detected.tags,
    rule_applied: input.targetStage ? "manual_stage_target" : applied.rule_applied,
    suggestion_type: funnelSuggestionType,
    suggestionType: funnelSuggestionType,
    qualification_complete: qualificationComplete,
    missing_fields: qualificationComplete ? [] : qualification.missingFields,
    why: `Targeted ${funnelSuggestionType.toLowerCase()} with qualification gating.`
  };
}
