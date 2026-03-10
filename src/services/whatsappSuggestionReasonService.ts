type ReasonLanguage = "fr" | "en";

export type SuggestionReasonInput = {
  language?: string | null;
  stage?: string | null;
  optionIntent?: string | null;
  optionText?: string | null;
  suggestionType?: string | null;
  recommendedAction?: string | null;
  urgency?: string | null;
  dropoffRisk?: string | number | null;
  paymentIntent?: boolean;
  depositIntent?: boolean;
  priceIntent?: boolean;
  confirmationIntent?: boolean;
  hasObjection?: boolean;
  reactivation?: boolean;
};

export type ReplyOptionLike = {
  label: string;
  intent: string;
  messages: string[];
  reason_short?: string;
};

function normalizeLang(input: string | null | undefined): ReasonLanguage {
  const raw = String(input || "").trim().toLowerCase();
  return raw === "fr" ? "fr" : "en";
}

function normalizeText(value: unknown): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clampSentence(value: string, maxChars = 180): string {
  const clean = normalizeText(value);
  if (!clean) return "";
  const firstSentence = clean.split(/(?<=[.!?])\s+/)[0] || clean;
  const trimmed = firstSentence.slice(0, maxChars).trim();
  const withoutTail = trimmed.replace(/[;,:-]+$/, "").trim();
  return /[.!?]$/.test(withoutTail) ? withoutTail : `${withoutTail}.`;
}

function includesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function detectPriceIntent(text: string): boolean {
  return includesAny(text, [/\b(price|prix|tarif|budget|cost|how much|combien)\b/i]);
}

function detectPaymentIntent(text: string): boolean {
  return includesAny(text, [/\b(payment|paiement|deposit|acompte|book|reserve|reservation|transfer|virement)\b/i]);
}

function detectObjection(text: string): boolean {
  return includesAny(text, [/\b(expensive|cher|timing|deadline|hesitat|h[ée]sit|not sure|pas s[ûu]r)\b/i]);
}

function isHighDropoffRisk(value: string | number | null | undefined): boolean {
  if (typeof value === "number") return value >= 0.7;
  const raw = String(value || "").trim().toLowerCase();
  return raw === "high" || raw === "critical";
}

export function buildSuggestionReasonShort(input: SuggestionReasonInput): string {
  const language = normalizeLang(input.language);
  const stage = String(input.stage || "").trim().toUpperCase();
  const optionIntent = normalizeText(input.optionIntent);
  const optionText = normalizeText(input.optionText);
  const suggestionType = normalizeText(input.suggestionType);
  const recommendedAction = normalizeText(input.recommendedAction).toLowerCase();
  const urgency = String(input.urgency || "").trim().toLowerCase();
  const reactivation = Boolean(input.reactivation) || /reactivat|follow[_ -]?up/i.test(suggestionType);

  const paymentIntent = Boolean(input.paymentIntent) || Boolean(input.depositIntent) || detectPaymentIntent(`${optionIntent} ${optionText}`);
  const priceIntent = Boolean(input.priceIntent) || detectPriceIntent(`${optionIntent} ${optionText}`);
  const objection = Boolean(input.hasObjection) || detectObjection(`${optionIntent} ${optionText}`);
  const highRisk = isHighDropoffRisk(input.dropoffRisk);
  const timelineUrgent = urgency === "high" || /timing|deadline|delivery|event/i.test(`${optionIntent} ${optionText}`);
  const qualificationPending = stage === "NEW" || stage === "PRODUCT_INTEREST" || stage === "QUALIFICATION_PENDING";
  const readyToAdvance =
    stage === "PRICE_SENT" || stage === "VIDEO_PROPOSED" || stage === "DEPOSIT_PENDING" || Boolean(input.confirmationIntent);

  if (reactivation || highRisk) {
    return clampSentence(
      language === "fr"
        ? "La conversation risque de perdre son élan, donc cette option relance l’échange avec tact."
        : "The conversation risks losing momentum, so this option restarts the exchange with tact."
    );
  }
  if (paymentIntent || /deposit|payment|reservation|close|advance_to_deposit/i.test(recommendedAction)) {
    return clampSentence(
      language === "fr"
        ? "Le client montre une intention d’achat claire, donc cette option avance naturellement vers la réservation."
        : "The client shows clear purchase intent, so this option moves naturally toward reservation."
    );
  }
  if (qualificationPending && (priceIntent || /qualif|clarify_missing_info|qualify/i.test(recommendedAction))) {
    return clampSentence(
      language === "fr"
        ? "Il manque encore des éléments clés, donc cette option qualifie la demande avant de parler prix."
        : "More context is still needed, so this option qualifies the request before discussing price."
    );
  }
  if (objection) {
    return clampSentence(
      language === "fr"
        ? "Le client semble hésiter, donc cette version rassure sans créer de pression."
        : "The client may be hesitating, so this version reassures without adding pressure."
    );
  }
  if (timelineUrgent) {
    return clampSentence(
      language === "fr"
        ? "Le timing est sensible, donc cette option aide à faire avancer la décision rapidement."
        : "Timing matters here, so this option helps move the decision forward efficiently."
    );
  }
  if (readyToAdvance) {
    return clampSentence(
      language === "fr"
        ? "Le client est engagé, donc cette option soutient la prochaine étape de conversion."
        : "The client is engaged and ready, so this option supports the next conversion step."
    );
  }
  return clampSentence(
    language === "fr"
      ? "Le client est engagé dans l’échange, donc cette option fait progresser la conversation avec élégance."
      : "The client is engaged in the exchange, so this option advances the conversation with elegance."
  );
}

export function attachReasonShortToReplyOptions<T extends ReplyOptionLike>(
  options: T[],
  context: Omit<SuggestionReasonInput, "optionIntent" | "optionText">
): Array<T & { reason_short: string }> {
  const list = Array.isArray(options) ? options : [];
  return list.map((option) => {
    const text = Array.isArray(option.messages) ? option.messages.map((item) => String(item || "").trim()).filter(Boolean).join(" ") : "";
    return {
      ...option,
      reason_short: buildSuggestionReasonShort({
        ...context,
        optionIntent: option.intent,
        optionText: text
      })
    };
  });
}
