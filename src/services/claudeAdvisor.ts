import { env } from "../config/env.js";
import {
  createAiAgentRun,
  updateAiAgentRun,
  type AiAgentRunRecord
} from "../db/aiAgentRunsRepo.js";
import { getWhatsAppLeadById, listRecentWhatsAppLeadMessages } from "../db/whatsappLeadsRepo.js";

const DEFAULT_CLAUDE_MODEL = "claude-haiku-4-5-20251001";
const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";
const CLAUDE_TIMEOUT_MS = 15000;
const CLAUDE_MAX_TOKENS_PRIMARY = 700;
const CLAUDE_MAX_TOKENS_RETRY = 1400;
const EMOJI_REGEX = /[\p{Extended_Pictographic}\uFE0F\u200D]/u;
const CLAUDE_MODEL_ALIASES: Record<string, string> = {
  "claude-3-5-haiku-latest": DEFAULT_CLAUDE_MODEL,
  "claude-3-5-haiku-20241022": DEFAULT_CLAUDE_MODEL
};
const ALLOWED_STAGES = new Set([
  "NEW",
  "PRODUCT_INTEREST",
  "QUALIFICATION_PENDING",
  "QUALIFIED",
  "PRICE_SENT",
  "DEPOSIT_PENDING",
  "CONFIRMED",
  "CONVERTED",
  "LOST"
]);
const LEGACY_GOALS = new Set(["qualification", "price", "deposit", "follow_up", "video", "close"]);
const DYNAMIC_CONVERSATION_STATES = new Set([
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
]);
const DYNAMIC_MISSING_INFORMATION = new Set([
  "event_date",
  "destination_country",
  "destination_city",
  "budget_range",
  "product_reference",
  "size_or_measurements"
]);
const DYNAMIC_CUSTOMER_SIGNALS = new Set([
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
]);
const DYNAMIC_NEXT_ACTIONS = new Set([
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
]);

function resolveClaudeModel(rawValue: unknown): string {
  const raw = String(rawValue || "").trim();
  if (!raw) return DEFAULT_CLAUDE_MODEL;
  const normalized = CLAUDE_MODEL_ALIASES[raw];
  if (normalized) {
    console.warn("[claude-advisor] remapped_deprecated_model", { from: raw, to: normalized });
    return normalized;
  }
  return raw;
}

function sanitizeText(input: unknown): string {
  return String(input || "").replace(/\u0000/g, "").trim();
}

function inferPreferredLanguage(
  lead: Awaited<ReturnType<typeof getWhatsAppLeadById>>,
  messages: Awaited<ReturnType<typeof listRecentWhatsAppLeadMessages>>
): "fr" | "en" {
  const recentInbound = (Array.isArray(messages) ? messages : [])
    .filter((m) => String(m.direction || "").toUpperCase() === "IN")
    .slice(-6)
    .map((m) => sanitizeText(m.text))
    .join(" ")
    .toLowerCase();
  const looksEnglish = /\b(hi|hello|thanks|please|interested|price|delivery|event|wedding|available)\b/i.test(recentInbound);
  if (looksEnglish) return "en";
  const country = String(lead?.country || "").trim().toUpperCase();
  if (country === "MA" || country === "MOROCCO") return "fr";
  return "fr";
}

export function safeJsonParse(input: string): Record<string, unknown> | null {
  const raw = String(input || "").trim();
  if (!raw) return null;
  const candidates: string[] = [];
  const fence = raw.match(/```json\s*([\s\S]*?)```/i);
  if (fence && fence[1]) candidates.push(String(fence[1]).trim());
  candidates.push(raw);
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(raw.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : { value: parsed };
    } catch {
      continue;
    }
  }
  return null;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function hasEmoji(value: string): boolean {
  return EMOJI_REGEX.test(String(value || ""));
}

function mapLegacyGoalToAction(goal: string): string {
  const normalized = String(goal || "").trim().toLowerCase();
  if (normalized === "qualification") return "ask_one_key_question";
  if (normalized === "price") return "provide_contextual_price";
  if (normalized === "deposit") return "push_softly_to_deposit";
  if (normalized === "video") return "propose_call";
  if (normalized === "close") return "propose_next_step";
  return "answer_and_qualify_lightly";
}

export function validateAdvisorPayload(rawPayload: Record<string, unknown>): Record<string, unknown> {
  const payload = toRecord(rawPayload);
  const serialized = JSON.stringify(payload);
  if (!serialized) throw new Error("claude_validation_failed:empty_payload");
  if (hasEmoji(serialized)) throw new Error("claude_validation_failed:emoji_detected");

  const analysis = toRecord(payload.analysis);
  const stage = String(analysis.stage || "").trim().toUpperCase();
  if (!ALLOWED_STAGES.has(stage)) throw new Error("claude_validation_failed:analysis_stage_invalid");
  const dynamicDecisionRaw = toRecord(analysis.dynamic_decision || payload.dynamic_decision);
  const dynamicConversationState = Array.isArray(dynamicDecisionRaw.conversation_state)
    ? dynamicDecisionRaw.conversation_state.map((x) => String(x || "").trim()).filter((x) => DYNAMIC_CONVERSATION_STATES.has(x))
    : [];
  const dynamicMissingInformation = Array.isArray(dynamicDecisionRaw.missing_information)
    ? dynamicDecisionRaw.missing_information
        .map((x) => String(x || "").trim())
        .filter((x) => DYNAMIC_MISSING_INFORMATION.has(x))
    : [];
  const dynamicCustomerSignals = Array.isArray(dynamicDecisionRaw.customer_signals)
    ? dynamicDecisionRaw.customer_signals.map((x) => String(x || "").trim()).filter((x) => DYNAMIC_CUSTOMER_SIGNALS.has(x))
    : [];
  const firstSuggestionGoal = Array.isArray(payload.suggestions) && payload.suggestions[0] && typeof payload.suggestions[0] === "object"
    ? String(toRecord(payload.suggestions[0]).goal || "").trim().toLowerCase()
    : "";
  const dynamicNextActionRaw =
    String(dynamicDecisionRaw.recommended_next_action || payload.recommended_next_action || "").trim().toLowerCase() ||
    mapLegacyGoalToAction(firstSuggestionGoal);
  const dynamicNextAction = DYNAMIC_NEXT_ACTIONS.has(dynamicNextActionRaw)
    ? dynamicNextActionRaw
    : "answer_and_qualify_lightly";
  const dynamicConfidenceRaw = Number(dynamicDecisionRaw.confidence);
  const dynamicConfidence =
    Number.isFinite(dynamicConfidenceRaw) && dynamicConfidenceRaw >= 0 && dynamicConfidenceRaw <= 1
      ? dynamicConfidenceRaw
      : 0.62;
  const dynamicReasoningShort = String(dynamicDecisionRaw.reasoning_short || "").trim();

  const suggestionsRaw = Array.isArray(payload.suggestions) ? payload.suggestions : [];
  if (!suggestionsRaw.length) throw new Error("claude_validation_failed:suggestions_missing");

  const suggestions = suggestionsRaw.map((entry, index) => {
    const item = toRecord(entry);
    const id = String(item.id || `s${index + 1}`).trim() || `s${index + 1}`;
    const goal = String(item.goal || dynamicNextAction || "").trim().toLowerCase();
    if (!goal || (!LEGACY_GOALS.has(goal) && !DYNAMIC_NEXT_ACTIONS.has(goal))) {
      throw new Error(`claude_validation_failed:suggestion_goal_invalid_${index + 1}`);
    }
    const confidence = Number(item.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error(`claude_validation_failed:suggestion_confidence_invalid_${index + 1}`);
    }
    const messages = Array.isArray(item.messages)
      ? item.messages.map((x) => String(x || "").trim()).filter(Boolean)
      : [];
    if (messages.length < 2 || messages.length > 4) {
      throw new Error(`claude_validation_failed:suggestion_messages_count_invalid_${index + 1}`);
    }
    for (let i = 0; i < messages.length; i += 1) {
      if (hasEmoji(messages[i])) throw new Error(`claude_validation_failed:emoji_in_message_${index + 1}_${i + 1}`);
    }
    return {
      id,
      goal,
      confidence,
      messages,
      rationale: String(item.rationale || "").trim() || undefined
    };
  });

  return {
    analysis: {
      stage,
      reasoning: String(analysis.reasoning || "").trim(),
      dynamic_decision: {
        conversation_state: dynamicConversationState,
        missing_information: dynamicMissingInformation,
        customer_signals: dynamicCustomerSignals,
        recommended_next_action: dynamicNextAction,
        confidence: dynamicConfidence,
        reasoning_short: dynamicReasoningShort
      },
      missing_information: Array.isArray(analysis.missing_information)
        ? analysis.missing_information.map((x) => String(x || "").trim()).filter(Boolean)
        : [],
      detected_signals: Array.isArray(analysis.detected_signals)
        ? analysis.detected_signals.map((entry) => {
            const signal = toRecord(entry);
            return {
              key: String(signal.key || "").trim(),
              value: String(signal.value || "").trim()
            };
          }).filter((x) => x.key && x.value)
        : [],
      risk_flags: Array.isArray(analysis.risk_flags)
        ? analysis.risk_flags.map((entry) => {
            const flag = toRecord(entry);
            return {
              level: String(flag.level || "").trim().toLowerCase(),
              label: String(flag.label || "").trim(),
              detail: String(flag.detail || "").trim()
            };
          }).filter((x) => x.level && x.label)
        : [],
      urgency: {
        level: String(toRecord(analysis.urgency).level || "").trim().toLowerCase() || "low",
        reason: String(toRecord(analysis.urgency).reason || "").trim()
      }
    },
    dynamic_decision: {
      conversation_state: dynamicConversationState,
      missing_information: dynamicMissingInformation,
      customer_signals: dynamicCustomerSignals,
      recommended_next_action: dynamicNextAction,
      confidence: dynamicConfidence,
      reasoning_short: dynamicReasoningShort
    },
    suggestions
  };
}

export function buildAdvisorPrompt(
  lead: Awaited<ReturnType<typeof getWhatsAppLeadById>>,
  messages: Awaited<ReturnType<typeof listRecentWhatsAppLeadMessages>>
): string {
  const preferredLanguage = inferPreferredLanguage(lead, messages);
  const leadBlock = {
    id: lead?.id || null,
    client_name: lead?.clientName || null,
    stage: lead?.stage || null,
    country: lead?.country || null,
    product_reference: lead?.productReference || null,
    event_date: lead?.eventDate || null,
    destination: {
      city: lead?.shipCity || null,
      region: lead?.shipRegion || null,
      country: lead?.shipCountry || null
    },
    detected_signals: lead?.detectedSignals || null
  };

  const recentMessages = (Array.isArray(messages) ? messages : [])
    .slice(-20)
    .map((m) => ({
      id: m.id,
      direction: m.direction,
      text: sanitizeText(m.text),
      created_at: m.createdAt
    }));

  return [
    "You are Claude acting as a WhatsApp sales advisor.",
    "Return STRICT JSON only.",
    "Do NOT output markdown.",
    "Do NOT output any free text outside JSON.",
    "Do NOT output emoji characters anywhere in JSON.",
    "Primary principle: decide the most appropriate NEXT ACTION now from context.",
    "Stage labels are secondary metadata for CRM/reporting only.",
    "Use this exact output schema:",
    "{",
    '  "analysis": {',
    '    "stage": "NEW | PRODUCT_INTEREST | QUALIFICATION_PENDING | QUALIFIED | PRICE_SENT | DEPOSIT_PENDING | CONFIRMED | CONVERTED | LOST",',
    '    "reasoning": "short internal reasoning",',
    '    "dynamic_decision": {',
    '      "conversation_state": ["qualification_incomplete | pricing_appropriate | objection_active | hesitation_detected | urgency_detected | delivery_concern | ready_for_conversion | stalled_conversation | deposit_likely | availability_check_needed | active_purchase_window"],',
    '      "missing_information": ["event_date | destination_country | destination_city | budget_range | product_reference | size_or_measurements"],',
    '      "customer_signals": ["price_request | availability_request | delivery_question | timeline_shared | budget_shared | objection_price | objection_trust | purchase_intent | hesitation | ready_to_buy"],',
    '      "recommended_next_action": "ask_one_key_question | answer_directly | reassure | propose_call | provide_contextual_price | push_softly_to_deposit | reactivate_gently | availability_request | answer_and_qualify_lightly | propose_next_step",',
    '      "confidence": 0.0,',
    '      "reasoning_short": "short justification"',
    "    },",
    '    "missing_information": ["event_date","destination","budget"],',
    '    "detected_signals": [{ "key": "product", "value": "..." }],',
    '    "risk_flags": [{ "level": "low|medium|high", "label": "...", "detail": "..." }],',
    '    "urgency": { "level": "low|medium|high", "reason": "..." }',
    "  },",
    '  "suggestions": [',
    "    {",
    '      "id": "s1",',
    '      "goal": "recommended_next_action value (preferred) OR qualification | price | deposit | follow_up",',
    '      "confidence": 0.0,',
    '      "messages": ["Message bubble 1","Message bubble 2","Message bubble 3"],',
    '      "rationale": "short internal rationale (drawer only)"',
    "    }",
    "  ]",
    "}",
    "Rules for suggestions[].messages:",
    "1) Client-facing WhatsApp bubbles only (no analysis).",
    "2) 2 to 4 bubbles per suggestion.",
    "3) Keep each bubble short and natural (target <=120 chars when possible).",
    "4) Luxury tone: calm, precise, respectful, minimal.",
    "5) STRICT NO EMOJIS anywhere (analysis or suggestions).",
    "6) Do NOT force qualification just because some fields are missing.",
    "7) Ask missing data only when it blocks the immediate next commercial action.",
    "8) messages[] must be ready to send as-is.",
    "9) Avoid superlatives and hype language.",
    "Return up to 3 suggestions.",
    "Use confidence values between 0 and 1.",
    `Preferred client language: ${preferredLanguage.toUpperCase()} (for Morocco default FR unless conversation is in EN).`,
    "",
    "Lead context:",
    JSON.stringify(leadBlock, null, 2),
    "",
    "Recent messages:",
    JSON.stringify(recentMessages, null, 2)
  ].join("\n");
}

function extractAnthropicText(payload: unknown): string {
  const root = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const content = Array.isArray(root.content) ? root.content : [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const part = item as Record<string, unknown>;
    if (String(part.type || "") === "text") {
      return String(part.text || "");
    }
  }
  return "";
}

async function callClaudeApi(promptText: string, model: string, maxTokens = CLAUDE_MAX_TOKENS_PRIMARY): Promise<Record<string, unknown>> {
  if (!env.CLAUDE_API_KEY) {
    throw new Error("CLAUDE_API_KEY missing");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLAUDE_TIMEOUT_MS);
  try {
    const response = await fetch(CLAUDE_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.CLAUDE_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model,
        max_tokens: Math.max(256, Math.round(Number(maxTokens || CLAUDE_MAX_TOKENS_PRIMARY))),
        temperature: 0.1,
        messages: [{ role: "user", content: promptText }]
      }),
      signal: controller.signal
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`claude_http_${response.status}: ${text.slice(0, 500)}`);
    }
    const parsed = safeJsonParse(text);
    if (!parsed) {
      throw new Error("claude_non_json_response");
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

function extractUsageTokens(payload: unknown): { input: number | null; output: number | null } {
  const root = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const usage = root.usage && typeof root.usage === "object" ? (root.usage as Record<string, unknown>) : {};
  const input = Number(usage.input_tokens);
  const output = Number(usage.output_tokens);
  return {
    input: Number.isFinite(input) ? Math.max(0, Math.round(input)) : null,
    output: Number.isFinite(output) ? Math.max(0, Math.round(output)) : null
  };
}

function extractStopReason(payload: unknown): string {
  const root = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  return String(root.stop_reason || "").trim().toLowerCase();
}

export async function runClaudeAdvisor(input: {
  leadId: string;
  messageId: string;
  triggerSource?: string;
  messageLimit?: number;
}): Promise<AiAgentRunRecord> {
  const leadId = String(input.leadId || "").trim();
  const messageId = String(input.messageId || "").trim();
  if (!leadId || !messageId) {
    throw new Error("invalid_input");
  }

  const lead = await getWhatsAppLeadById(leadId);
  if (!lead) throw new Error("lead_not_found");
  const messageLimit = Math.max(1, Math.min(200, Math.round(Number(input.messageLimit || 20))));
  const messages = await listRecentWhatsAppLeadMessages(leadId, messageLimit);
  const promptText = buildAdvisorPrompt(lead, messages);
  const model = resolveClaudeModel(env.CLAUDE_MODEL);
  const triggerSource = String(input.triggerSource || "message_persisted").trim().slice(0, 80) || "message_persisted";

  const run = await createAiAgentRun({
    leadId,
    messageId,
    status: "queued",
    triggerSource,
    model,
    promptText
  });
  console.info("[claude-advisor] queued", { runId: run.id, leadId, messageId, model, triggerSource });

  const startedAt = Date.now();
  try {
    let raw = await callClaudeApi(promptText, model, CLAUDE_MAX_TOKENS_PRIMARY);
    let responseText = extractAnthropicText(raw);
    let parsedJson = safeJsonParse(responseText);
    const stopReason = extractStopReason(raw);
    if (!parsedJson && stopReason === "max_tokens") {
      raw = await callClaudeApi(promptText, model, CLAUDE_MAX_TOKENS_RETRY);
      responseText = extractAnthropicText(raw);
      parsedJson = safeJsonParse(responseText);
    }
    const tokens = extractUsageTokens(raw);
    if (!parsedJson) throw new Error("claude_validation_failed:non_json_response");
    const validatedPayload = validateAdvisorPayload(parsedJson);
    const latencyMs = Date.now() - startedAt;
    await updateAiAgentRun({
      id: run.id,
      status: "success",
      model,
      latencyMs,
      tokensIn: tokens.input,
      tokensOut: tokens.output,
      responseJson: validatedPayload,
      errorText: null
    });
    console.info("[claude-advisor] success", {
      runId: run.id,
      leadId,
      messageId,
      latencyMs,
      tokensIn: tokens.input,
      tokensOut: tokens.output
    });
    return {
      ...run,
      status: "success",
      latencyMs,
      tokensIn: tokens.input,
      tokensOut: tokens.output,
      responseJson: validatedPayload,
      errorText: null
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const errorText = error instanceof Error ? error.message : String(error);
    await updateAiAgentRun({
      id: run.id,
      status: "error",
      model,
      latencyMs,
      tokensIn: null,
      tokensOut: null,
      responseJson: null,
      errorText
    });
    console.error("[claude-advisor] error", { runId: run.id, leadId, messageId, latencyMs, error: errorText });
    return {
      ...run,
      status: "error",
      latencyMs,
      tokensIn: null,
      tokensOut: null,
      responseJson: null,
      errorText
    };
  }
}
