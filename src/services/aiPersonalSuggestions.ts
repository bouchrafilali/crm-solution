import { env } from "../config/env.js";
import type { WhatsAppLeadMessage, WhatsAppLeadRecord } from "../db/whatsappLeadsRepo.js";
import { sanitizeForPrompt } from "./aiTextService.js";

export type PersonalSuggestion = {
  id: string;
  goal: "QUALIFY" | "PRICE" | "DEPOSIT" | "VIDEO" | "FOLLOW_UP" | "CLOSE";
  language: "fr" | "en" | "ar" | "es" | "it" | "de";
  text: string;
  should_send_price: boolean;
  requires_human_review: boolean;
  confidence: number;
  rationale: string;
  metadata: {
    stage_target: string;
    fields_to_capture: string[];
    template_like: boolean;
  };
};

export type PersonalSuggestionsResponse = {
  suggestions: PersonalSuggestion[];
};

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    suggestions: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          goal: { type: "string", enum: ["QUALIFY", "PRICE", "DEPOSIT", "VIDEO", "FOLLOW_UP", "CLOSE"] },
          language: { type: "string", enum: ["fr", "en", "ar", "es", "it", "de"] },
          text: { type: "string" },
          should_send_price: { type: "boolean" },
          requires_human_review: { type: "boolean" },
          confidence: { type: "integer", minimum: 0, maximum: 100 },
          rationale: { type: "string" },
          metadata: {
            type: "object",
            additionalProperties: false,
            properties: {
              stage_target: { type: "string" },
              fields_to_capture: {
                type: "array",
                items: { type: "string" }
              },
              template_like: { type: "boolean" }
            },
            required: ["stage_target", "fields_to_capture", "template_like"]
          }
        },
        required: [
          "id",
          "goal",
          "language",
          "text",
          "should_send_price",
          "requires_human_review",
          "confidence",
          "rationale",
          "metadata"
        ]
      }
    }
  },
  required: ["suggestions"]
} as const;

const PRICE_ALLOWED_STAGES = new Set(["PRICE_SENT", "DEPOSIT_PENDING", "CONFIRMED", "CONVERTED"]);

function normalizeStage(value: unknown): string {
  return String(value || "").trim().toUpperCase() || "NEW";
}

function priceAllowedForStage(stage: string): boolean {
  return PRICE_ALLOWED_STAGES.has(normalizeStage(stage));
}

function inferLanguage(lead: WhatsAppLeadRecord): "fr" | "en" | "ar" | "es" | "it" | "de" {
  const notes = String(lead.internalNotes || "").toLowerCase();
  if (/\b(arabic|arab|darija)\b/.test(notes)) return "ar";
  if (/\b(spanish|español)\b/.test(notes)) return "es";
  if (/\b(italian|italiano)\b/.test(notes)) return "it";
  if (/\b(german|deutsch)\b/.test(notes)) return "de";
  if (/\b(english|anglais)\b/.test(notes)) return "en";
  const country = String(lead.country || "").trim().toUpperCase();
  if (["US", "GB", "UK", "CA", "AU", "IE"].includes(country)) return "en";
  return "fr";
}

function requiredQualificationFields(lead: WhatsAppLeadRecord): string[] {
  const missing: string[] = [];
  if (!String(lead.eventDate || "").trim()) missing.push("event_date");
  if (
    !String(lead.shipDestinationText || "").trim() &&
    !String(lead.shipCity || "").trim() &&
    !String(lead.shipCountry || "").trim()
  ) {
    missing.push("destination");
  }
  const profile = `${String(lead.productReference || "")} ${String(lead.internalNotes || "")}`.toLowerCase();
  if (!/\b(size|taille|measurement|mesure)\b/.test(profile)) missing.push("size");
  return missing;
}

function compactMessages(messages: WhatsAppLeadMessage[]): Array<{ direction: "IN" | "OUT"; text: string; createdAt: string }> {
  return (Array.isArray(messages) ? messages : [])
    .slice(-20)
    .map((m) => ({
      direction: m.direction,
      text: sanitizeForPrompt(m.text, 380),
      createdAt: m.createdAt
    }));
}

function buildContextSnapshot(lead: WhatsAppLeadRecord, messages: WhatsAppLeadMessage[]) {
  const stage = normalizeStage(lead.stage);
  const qualificationMissing = requiredQualificationFields(lead);
  return {
    lead: {
      id: lead.id,
      clientName: sanitizeForPrompt(lead.clientName, 80),
      country: sanitizeForPrompt(lead.country, 20),
      language: inferLanguage(lead),
      stage,
      stage_auto: Boolean(lead.stageAuto),
      qualification_missing: qualificationMissing,
      event_date: lead.eventDate,
      destination: lead.shipDestinationText || [lead.shipCity, lead.shipRegion, lead.shipCountry].filter(Boolean).join(", "),
      product_reference: sanitizeForPrompt(lead.productReference, 120)
    },
    constraints: {
      quiet_luxury_tone: true,
      max_questions_per_message: 2,
      qualification_before_price: !priceAllowedForStage(stage),
      price_allowed_stage: priceAllowedForStage(stage),
      never_invent_price_or_dates: true
    },
    conversation: compactMessages(messages)
  };
}

function parseSuggestionsPayload(payload: unknown): PersonalSuggestionsResponse | null {
  if (!payload || typeof payload !== "object") return null;
  const rec = payload as Record<string, unknown>;
  if (typeof rec.output_text === "string" && rec.output_text.trim()) {
    try {
      return JSON.parse(rec.output_text) as PersonalSuggestionsResponse;
    } catch {
      // fall through
    }
  }
  const output = Array.isArray(rec.output) ? rec.output : [];
  for (const item of output) {
    const itemRec = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
    if (!itemRec) continue;
    const content = Array.isArray(itemRec.content) ? itemRec.content : [];
    for (const block of content) {
      const b = block && typeof block === "object" ? (block as Record<string, unknown>) : null;
      if (!b) continue;
      const text = typeof b.text === "string" ? b.text : "";
      if (!text.trim()) continue;
      try {
        return JSON.parse(text) as PersonalSuggestionsResponse;
      } catch {
        // continue
      }
    }
  }
  return null;
}

function normalizeSuggestion(
  raw: PersonalSuggestion,
  idx: number,
  stage: string,
  preferredLanguage: "fr" | "en" | "ar" | "es" | "it" | "de"
): PersonalSuggestion {
  const id = String(raw.id || `ai_suggestion_${idx + 1}`).trim() || `ai_suggestion_${idx + 1}`;
  const goal = raw.goal || "QUALIFY";
  const text = String(raw.text || "").trim();
  const base: PersonalSuggestion = {
    id,
    goal,
    language: raw.language || preferredLanguage,
    text,
    should_send_price: Boolean(raw.should_send_price),
    requires_human_review: Boolean(raw.requires_human_review),
    confidence: Math.max(0, Math.min(100, Math.round(Number(raw.confidence || 0)))),
    rationale: String(raw.rationale || "").trim(),
    metadata: {
      stage_target: String(raw.metadata?.stage_target || stage),
      fields_to_capture: Array.isArray(raw.metadata?.fields_to_capture)
        ? raw.metadata.fields_to_capture.map((f) => String(f || "").trim()).filter(Boolean)
        : [],
      template_like: Boolean(raw.metadata?.template_like)
    }
  };

  if (!priceAllowedForStage(stage) && base.should_send_price) {
    const fallbackQuestion =
      base.language === "en"
        ? "Before sharing pricing, may I confirm your event date and delivery destination?"
        : "Avant de partager le prix, puis-je confirmer la date de votre événement et la destination de livraison ?";
    return {
      ...base,
      should_send_price: false,
      requires_human_review: true,
      text: fallbackQuestion,
      rationale: base.rationale
        ? `${base.rationale} | price blocked by stage guardrail`
        : "price blocked by stage guardrail",
      metadata: {
        ...base.metadata,
        fields_to_capture: Array.from(new Set([...(base.metadata.fields_to_capture || []), "event_date", "destination"]))
      }
    };
  }

  return base;
}

function fallbackSuggestions(input: {
  stage: string;
  language: "fr" | "en" | "ar" | "es" | "it" | "de";
  missing: string[];
}): PersonalSuggestion[] {
  const isEn = input.language === "en";
  const stage = normalizeStage(input.stage);
  const missing = input.missing;
  const qualifyText = isEn
    ? "Thank you for your message. May I confirm your event date and delivery destination so I can guide you precisely?"
    : "Merci pour votre message. Puis-je confirmer la date de votre événement et la destination de livraison pour vous guider avec précision ?";
  const followupText = isEn
    ? "I’m at your disposal to finalize the details at your pace. Would you like me to summarize the next step in one message?"
    : "Je reste à votre disposition pour finaliser les détails à votre rythme. Souhaitez-vous que je résume la prochaine étape en un seul message ?";
  const priceTextAllowed = isEn
    ? "Thank you. Based on your details, I can now share a contextualized pricing range and production timing."
    : "Merci. Avec ces éléments, je peux maintenant partager une fourchette de prix contextualisée et le délai de confection.";
  const priceTextBlocked = isEn
    ? "To provide an accurate quotation, may I confirm your size details first?"
    : "Pour vous proposer un prix précis, puis-je d’abord confirmer vos informations de taille ?";

  return [
    {
      id: "fallback_qualify_1",
      goal: "QUALIFY",
      language: input.language,
      text: qualifyText,
      should_send_price: false,
      requires_human_review: false,
      confidence: 68,
      rationale: "Deterministic fallback focusing critical qualification fields.",
      metadata: {
        stage_target: stage,
        fields_to_capture: missing,
        template_like: false
      }
    },
    {
      id: "fallback_followup_2",
      goal: "FOLLOW_UP",
      language: input.language,
      text: followupText,
      should_send_price: false,
      requires_human_review: false,
      confidence: 62,
      rationale: "Deterministic fallback for elegant progression.",
      metadata: {
        stage_target: stage,
        fields_to_capture: missing.slice(0, 2),
        template_like: false
      }
    },
    {
      id: "fallback_price_guarded_3",
      goal: priceAllowedForStage(stage) ? "PRICE" : "QUALIFY",
      language: input.language,
      text: priceAllowedForStage(stage) ? priceTextAllowed : priceTextBlocked,
      should_send_price: priceAllowedForStage(stage),
      requires_human_review: !priceAllowedForStage(stage),
      confidence: 58,
      rationale: "Deterministic fallback with strict price-stage guardrail.",
      metadata: {
        stage_target: stage,
        fields_to_capture: priceAllowedForStage(stage) ? [] : ["size"],
        template_like: true
      }
    }
  ];
}

export async function generateAiPersonalSuggestions(input: {
  lead: WhatsAppLeadRecord;
  messages: WhatsAppLeadMessage[];
  maxMessages?: number;
}): Promise<{
  suggestions: PersonalSuggestion[];
  contextSnapshot: Record<string, unknown>;
  model: string;
  provider: "openai" | "fallback";
  fallbackReason: string | null;
}> {
  const model = String(env.OPENAI_MODEL || "gpt-4.1-mini").trim() || "gpt-4.1-mini";
  const apiKey = String(env.OPENAI_API_KEY || "").trim();
  const lead = input.lead;
  const stage = normalizeStage(lead.stage);
  const language = inferLanguage(lead);
  const messages = (Array.isArray(input.messages) ? input.messages : []).slice(-(Math.max(1, Math.min(50, input.maxMessages || 20))));
  const contextSnapshot = buildContextSnapshot(lead, messages);
  const missing = requiredQualificationFields(lead);

  const fallback = () => fallbackSuggestions({ stage, language, missing });

  if (!apiKey) {
    return {
      suggestions: fallback(),
      contextSnapshot,
      model,
      provider: "fallback",
      fallbackReason: "OPENAI_API_KEY missing"
    };
  }

  try {
    const systemPrompt =
      "You generate luxury WhatsApp sales suggestions. Output STRICT JSON only. Tone: quiet luxury, elegant, concise, no emojis. " +
      "Business rules: qualification before price unless stage in PRICE_SENT/DEPOSIT_PENDING/CONFIRMED/CONVERTED. Ask max 1-2 questions. " +
      "Never invent stock, delivery dates, or exact prices unless price stage allows. Prefer French if language unknown.";
    const userPrompt = JSON.stringify(contextSnapshot);

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        input: [
          { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
          { role: "user", content: [{ type: "input_text", text: userPrompt }] }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "ai_personal_suggestions",
            strict: true,
            schema: OUTPUT_SCHEMA
          }
        }
      })
    });

    if (!response.ok) {
      return {
        suggestions: fallback(),
        contextSnapshot,
        model,
        provider: "fallback",
        fallbackReason: `OpenAI HTTP ${response.status}`
      };
    }
    const payload = (await response.json()) as unknown;
    const parsed = parseSuggestionsPayload(payload);
    if (!parsed || !Array.isArray(parsed.suggestions) || parsed.suggestions.length < 3) {
      return {
        suggestions: fallback(),
        contextSnapshot,
        model,
        provider: "fallback",
        fallbackReason: "OpenAI returned invalid structured output"
      };
    }
    const normalized = parsed.suggestions
      .slice(0, 3)
      .map((item, idx) => normalizeSuggestion(item, idx, stage, language));
    while (normalized.length < 3) {
      normalized.push(fallback()[normalized.length]);
    }
    return {
      suggestions: normalized.slice(0, 3),
      contextSnapshot,
      model,
      provider: "openai",
      fallbackReason: null
    };
  } catch (error) {
    return {
      suggestions: fallback(),
      contextSnapshot,
      model,
      provider: "fallback",
      fallbackReason: error instanceof Error ? error.message : "Unknown OpenAI error"
    };
  }
}
