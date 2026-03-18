import { z } from "zod";
import { env } from "../config/env.js";
import { buildLeadTranscript, type LeadTranscriptResult } from "./whatsappTranscriptFormatter.js";
import { sanitizeForPrompt } from "./aiTextService.js";
import { getAiProviderForStep, type AiProvider } from "./aiProviderRouting.js";
import type { AiUsageMetrics } from "./aiPricing.js";
import {
  buildAiStepCacheKey,
  getAiStepCache,
  runAiStepSingleFlight,
  resolveLatestMessageIdForLead,
  setAiStepCache
} from "./aiStepCache.js";
import { enforceTokenBudget } from "./aiTokenBudget.js";

const STAGE_VALUES = [
  "NEW",
  "PRODUCT_INTEREST",
  "QUALIFICATION_PENDING",
  "QUALIFIED",
  "PRICE_SENT",
  "VIDEO_PROPOSED",
  "VIDEO_DONE",
  "DEPOSIT_PENDING",
  "CONFIRMED",
  "CONVERTED",
  "LOST",
  "STALLED"
] as const;

const NEXT_ACTION_VALUES = [
  "qualify",
  "answer_precisely",
  "propose_video",
  "reassure",
  "push_softly_to_deposit",
  "reactivate_gently",
  "wait",
  "clarify_timing",
  "close_out"
] as const;

const URGENCY_VALUES = ["low", "medium", "high"] as const;
const DROPOFF_RISK_VALUES = ["low", "medium", "high"] as const;

const SIGNAL_TYPE_VALUES = [
  "product_interest",
  "price_request",
  "customization_request",
  "event_date",
  "urgency",
  "shipping_question",
  "payment_intent",
  "hesitation",
  "objection",
  "video_interest",
  "deadline_risk"
] as const;

const OBJECTION_TYPE_VALUES = ["price", "timing", "trust", "fit", "fabric", "uncertainty", "external_approval", "other"] as const;
const STAGE_PROMPT_VERSION = "v2";

export type StageDetectionStage = (typeof STAGE_VALUES)[number];
export type StageDetectionNextAction = (typeof NEXT_ACTION_VALUES)[number];
export type StageDetectionUrgency = (typeof URGENCY_VALUES)[number];

export class StageDetectionError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

type ProviderFailureClass =
  | "timeout"
  | "network"
  | "http_5xx"
  | "http_4xx"
  | "validation"
  | "schema"
  | "config"
  | "unknown";

const StageDetectionAnalysisSchema = z
  .object({
    stage: z.enum(STAGE_VALUES),
    stage_confidence: z.number().min(0).max(1),
    priority_score: z.number().int().min(0).max(100),
    urgency: z.enum(URGENCY_VALUES),
    payment_intent: z.boolean(),
    dropoff_risk: z.enum(DROPOFF_RISK_VALUES),
    signals: z.array(
      z
        .object({
          type: z.enum(SIGNAL_TYPE_VALUES),
          evidence: z.string().min(1)
        })
        .strict()
    ),
    facts: z
      .object({
        products_of_interest: z.array(z.string()),
        event_date: z.string().nullable(),
        delivery_deadline: z.string().nullable(),
        destination_country: z.string().nullable(),
        budget: z.string().nullable(),
        price_points_detected: z.array(z.union([z.string(), z.number()])),
        customization_requests: z.array(z.string()),
        preferred_colors: z.array(z.string()),
        preferred_fabrics: z.array(z.string()),
        payment_method_preference: z.string().nullable()
      })
      .strict(),
    objections: z.array(
      z
        .object({
          type: z.enum(OBJECTION_TYPE_VALUES),
          evidence: z.string().min(1)
        })
        .strict()
    ),
    recommended_next_action: z.enum(NEXT_ACTION_VALUES),
    reasoning_summary: z.array(z.string())
  })
  .strict();

export type StageDetectionAnalysis = z.infer<typeof StageDetectionAnalysisSchema>;

export type StageDetectionResult = {
  analysis: StageDetectionAnalysis;
  transcriptLength: number;
  messageCount: number;
  source?: "state_delta" | "transcript_fallback";
  provider: AiProvider;
  model: string;
  usage?: AiUsageMetrics | null;
  timestamp: string;
};

function toUsageMetrics(value: unknown): AiUsageMetrics | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const input = Number(row.input_tokens ?? row.prompt_tokens);
  const output = Number(row.output_tokens ?? row.completion_tokens);
  const cached = Number(
    row.cache_read_input_tokens ??
      (row.prompt_tokens_details && typeof row.prompt_tokens_details === "object"
        ? (row.prompt_tokens_details as Record<string, unknown>).cached_tokens
        : NaN)
  );
  return {
    inputTokens: Number.isFinite(input) ? Math.max(0, Math.round(input)) : null,
    outputTokens: Number.isFinite(output) ? Math.max(0, Math.round(output)) : null,
    cachedInputTokens: Number.isFinite(cached) ? Math.max(0, Math.round(cached)) : null
  };
}

export function parseStageDetectionJson(raw: string): unknown {
  const source = String(raw || "").trim();
  if (!source) {
    throw new StageDetectionError("stage_detection_empty_ai_output", "AI output is empty");
  }

  const candidates: string[] = [];
  const fencedJson = source.match(/```json\s*([\s\S]*?)```/i);
  if (fencedJson?.[1]) candidates.push(String(fencedJson[1]).trim());
  const fenced = source.match(/```\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(String(fenced[1]).trim());
  candidates.push(source);

  const firstBrace = source.indexOf("{");
  const lastBrace = source.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(source.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }

  throw new StageDetectionError("stage_detection_invalid_json", "AI output is not valid JSON");
}

export function validateStageDetectionAnalysis(parsed: unknown): StageDetectionAnalysis {
  const result = StageDetectionAnalysisSchema.safeParse(parsed);
  if (!result.success) {
    throw new StageDetectionError(
      "stage_detection_invalid_schema",
      `Stage detection schema validation failed: ${result.error.issues.map((i) => i.path.join(".")).join(", ") || "unknown"}`
    );
  }
  return result.data;
}

function buildStageDetectionSystemPrompt(): string {
  return [
    "Analyze a luxury WhatsApp sales conversation.",
    "Return JSON only. No markdown.",
    "Do not generate reply text.",
    `Allowed stages: ${STAGE_VALUES.join(", ")}`,
    `Allowed recommended_next_action: ${NEXT_ACTION_VALUES.join(", ")}`
  ].join("\n");
}

function buildStageDetectionUserPrompt(transcript: string): string {
  return [
    "Return JSON keys exactly:",
    "stage, stage_confidence, priority_score, urgency, payment_intent, dropoff_risk, signals, facts, objections, recommended_next_action, reasoning_summary",
    "Transcript:",
    transcript
  ].join("\n");
}

function buildStageDetectionStateDeltaUserPrompt(input: {
  currentState: Record<string, unknown>;
  latestMessageDelta: Record<string, unknown>;
  recentMinimalContext: Array<Record<string, unknown>>;
}): string {
  return [
    "Return JSON keys exactly:",
    "stage, stage_confidence, priority_score, urgency, payment_intent, dropoff_risk, signals, facts, objections, recommended_next_action, reasoning_summary",
    "Current structured state JSON:",
    JSON.stringify(input.currentState),
    "Latest message delta JSON:",
    JSON.stringify(input.latestMessageDelta),
    "Recent minimal context JSON:",
    JSON.stringify(input.recentMinimalContext)
  ].join("\n");
}

function isCrossProviderFallbackEnabled(): boolean {
  const raw = String(env.AI_CROSS_PROVIDER_FALLBACK_ENABLED || "").trim().toLowerCase();
  if (!raw) return true;
  return ["1", "true", "yes", "on"].includes(raw);
}

function classifyProviderFailure(error: unknown): { failureClass: ProviderFailureClass; fallbackAllowed: boolean } {
  const message = error instanceof Error ? String(error.message || "") : String(error || "");
  const lower = message.toLowerCase();
  if (error instanceof StageDetectionError) {
    const code = String(error.code || "").toLowerCase();
    if (code.includes("provider_not_configured")) return { failureClass: "config", fallbackAllowed: false };
    if (code.includes("invalid_json") || code.includes("invalid_schema") || code.includes("provider_non_json")) {
      return { failureClass: "schema", fallbackAllowed: false };
    }
  }
  if (error instanceof Error && String(error.name || "").toLowerCase() === "aborterror") {
    return { failureClass: "timeout", fallbackAllowed: true };
  }
  if (/(timed?\s*out|timeout|etimedout)/i.test(lower)) {
    return { failureClass: "timeout", fallbackAllowed: true };
  }
  if (/(econnreset|econnrefused|enotfound|eai_again|fetch failed|networkerror|network error)/i.test(lower)) {
    return { failureClass: "network", fallbackAllowed: true };
  }
  const httpStatus = lower.match(/\((\d{3})\)/);
  if (httpStatus && httpStatus[1]) {
    const status = Number(httpStatus[1]);
    if (Number.isFinite(status) && status >= 500 && status <= 599) {
      return { failureClass: "http_5xx", fallbackAllowed: true };
    }
    if (Number.isFinite(status) && status >= 400 && status <= 499) {
      return { failureClass: "http_4xx", fallbackAllowed: false };
    }
  }
  if (/invalid|schema|validation|bad request|context|prompt too large|token/i.test(lower)) {
    return { failureClass: "validation", fallbackAllowed: false };
  }
  return { failureClass: "unknown", fallbackAllowed: false };
}

export async function callStageDetectionModel(input: {
  systemPrompt: string;
  userPrompt: string;
}): Promise<{ provider: AiProvider; model: string; rawOutput: string; usage: AiUsageMetrics | null }> {
  const provider = getAiProviderForStep("stage");

  if (provider === "claude") {
    try {
      const apiKey = String(env.CLAUDE_API_KEY || "").trim();
      const model = String(env.CLAUDE_MODEL || "claude-haiku-4-5-20251001").trim() || "claude-haiku-4-5-20251001";
      if (!apiKey) {
        throw new StageDetectionError("stage_detection_provider_not_configured", "CLAUDE_API_KEY missing");
      }

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 900,
          system: input.systemPrompt,
          messages: [{ role: "user", content: input.userPrompt }]
        })
      });

      const rawResponseText = await response.text();
      if (!response.ok) {
        throw new StageDetectionError(
          `stage_detection_provider_http_${response.status}`,
          `Claude request failed (${response.status}): ${rawResponseText.slice(0, 500)}`
        );
      }

      let payload: unknown;
      try {
        payload = JSON.parse(rawResponseText);
      } catch {
        throw new StageDetectionError("stage_detection_provider_non_json", "Provider response is not valid JSON");
      }

      const root = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
      const contentBlocks = Array.isArray(root.content) ? root.content : [];
      const textBlock =
        contentBlocks.find((block) => block && typeof block === "object" && (block as Record<string, unknown>).type === "text") || null;
      const text = textBlock && typeof textBlock === "object" ? String((textBlock as Record<string, unknown>).text || "").trim() : "";
      if (!text) {
        throw new StageDetectionError("stage_detection_empty_ai_output", "Provider content is empty");
      }

      return { provider: "claude", model, rawOutput: text, usage: toUsageMetrics(root.usage) };
    } catch (error) {
      const openAiConfigured = Boolean(String(env.OPENAI_API_KEY || "").trim());
      const fallbackEnabled = isCrossProviderFallbackEnabled();
      const classified = classifyProviderFailure(error);
      const fallbackAllowed = openAiConfigured && fallbackEnabled && classified.fallbackAllowed;
      console.warn("[stage-detection] provider_failure", {
        originalProvider: "claude",
        failureClass: classified.failureClass,
        fallbackAllowed,
        fallbackProvider: fallbackAllowed ? "openai" : null,
        error: error instanceof Error ? error.message : String(error)
      });
      if (!fallbackAllowed) {
        throw error;
      }
    }
  }

  const apiKey = String(env.OPENAI_API_KEY || "").trim();
  const model = String(env.OPENAI_MODEL || "gpt-4.1-mini").trim() || "gpt-4.1-mini";
  if (!apiKey) {
    throw new StageDetectionError("stage_detection_provider_not_configured", "OPENAI_API_KEY missing");
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 900,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: input.systemPrompt },
        { role: "user", content: input.userPrompt }
      ]
    })
  });

  const rawResponseText = await response.text();
  if (!response.ok) {
    throw new StageDetectionError(
      "stage_detection_provider_error",
      `OpenAI request failed (${response.status}): ${rawResponseText.slice(0, 500)}`
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawResponseText);
  } catch {
    throw new StageDetectionError("stage_detection_provider_non_json", "Provider response is not valid JSON");
  }

  const root = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const first = choices[0] && typeof choices[0] === "object" ? (choices[0] as Record<string, unknown>) : {};
  const message = first.message && typeof first.message === "object" ? (first.message as Record<string, unknown>) : {};
  const content = String(message.content || "").trim();
  if (!content) {
    throw new StageDetectionError("stage_detection_empty_ai_output", "Provider content is empty");
  }

  return {
    provider: "openai",
    model,
    rawOutput: content,
    usage: toUsageMetrics(root.usage)
  };
}

export async function detectStageFromTranscript(input: {
  leadId: string;
  transcript: LeadTranscriptResult;
  callModel?: typeof callStageDetectionModel;
}): Promise<StageDetectionResult> {
  const safeLeadId = String(input.leadId || "").trim();
  if (!safeLeadId) {
    throw new StageDetectionError("invalid_lead_id", "Lead ID is required");
  }

  const messageCount = Number(input.transcript.messageCount || 0);
  const transcriptLength = Number(input.transcript.transcriptLength || 0);
  const transcriptText = String(input.transcript.transcript || "").trim();

  if (messageCount <= 0 || !transcriptText) {
    throw new StageDetectionError("stage_detection_empty_transcript", "Transcript is empty");
  }

  if (transcriptLength < 30 || messageCount < 1) {
    throw new StageDetectionError(
      "stage_detection_transcript_too_short",
      "Transcript is too short for reliable stage detection"
    );
  }

  console.info("[stage-detection] request", {
    leadId: safeLeadId,
    messageCount,
    transcriptLength,
    transcriptPreview: sanitizeForPrompt(transcriptText, 500)
  });

  const providerForKey = getAiProviderForStep("stage");
  const modelForKey = providerForKey === "claude"
    ? (String(env.CLAUDE_MODEL || "claude-haiku-4-5-20251001").trim() || "claude-haiku-4-5-20251001")
    : (String(env.OPENAI_MODEL || "gpt-4.1-mini").trim() || "gpt-4.1-mini");
  const latestMessageId = await resolveLatestMessageIdForLead(safeLeadId);
  const cacheKey = latestMessageId
    ? buildAiStepCacheKey({
        leadId: safeLeadId,
        latestMessageId,
        step: "stage_detection",
        provider: providerForKey,
        model: modelForKey,
        promptVersion: STAGE_PROMPT_VERSION
      })
    : "";
  if (cacheKey) {
    const cached = getAiStepCache<StageDetectionResult>(cacheKey);
    if (cached) {
      console.info("[stage-detection] cache_hit", { leadId: safeLeadId, latestMessageId, provider: providerForKey, model: modelForKey });
      return {
        ...cached,
        usage: null,
        timestamp: new Date().toISOString()
      };
    }
  }

  const execution = await runAiStepSingleFlight(cacheKey, async () => {
    const cachedInside = cacheKey ? getAiStepCache<StageDetectionResult>(cacheKey) : null;
    if (cachedInside) return cachedInside;
    const systemPrompt = buildStageDetectionSystemPrompt();
    const budgeted = enforceTokenBudget({
      step: "stage_detection",
      transcript: transcriptText,
      context: {}
    });
    const userPrompt = buildStageDetectionUserPrompt(budgeted.transcript);
    const modelCaller = input.callModel || callStageDetectionModel;
    const modelResult = await modelCaller({ systemPrompt, userPrompt });

    console.info("[stage-detection] raw-output", {
      leadId: safeLeadId,
      provider: modelResult.provider,
      model: modelResult.model,
      rawOutput: modelResult.rawOutput
    });

    const parsed = parseStageDetectionJson(modelResult.rawOutput);
    const analysis = validateStageDetectionAnalysis(parsed);
    const output: StageDetectionResult = {
      analysis,
      transcriptLength,
      messageCount,
      source: "transcript_fallback",
      provider: modelResult.provider,
      model: modelResult.model,
      usage: modelResult.usage,
      timestamp: new Date().toISOString()
    };
    if (cacheKey) {
      setAiStepCache(cacheKey, output);
    }
    return output;
  });
  if (execution.joined && cacheKey) {
    console.info("[stage-detection] singleflight_join", { leadId: safeLeadId, latestMessageId, cacheKey });
  }
  return {
    ...execution.value,
    usage: execution.joined ? null : execution.value.usage,
    timestamp: new Date().toISOString()
  };
}

export async function detectStageFromStateDelta(input: {
  leadId: string;
  currentState: Record<string, unknown>;
  latestMessageDelta: Record<string, unknown>;
  recentMinimalContext: Array<Record<string, unknown>>;
  callModel?: typeof callStageDetectionModel;
}): Promise<StageDetectionResult> {
  const safeLeadId = String(input.leadId || "").trim();
  if (!safeLeadId) {
    throw new StageDetectionError("invalid_lead_id", "Lead ID is required");
  }

  const providerForKey = getAiProviderForStep("stage");
  const modelForKey = providerForKey === "claude"
    ? (String(env.CLAUDE_MODEL || "claude-haiku-4-5-20251001").trim() || "claude-haiku-4-5-20251001")
    : (String(env.OPENAI_MODEL || "gpt-4.1-mini").trim() || "gpt-4.1-mini");
  const latestMessageId = String((input.latestMessageDelta && input.latestMessageDelta.id) || "").trim() || await resolveLatestMessageIdForLead(safeLeadId);
  const cacheKey = latestMessageId
    ? buildAiStepCacheKey({
        leadId: safeLeadId,
        latestMessageId,
        step: "stage_detection",
        provider: providerForKey,
        model: modelForKey,
        promptVersion: STAGE_PROMPT_VERSION
      })
    : "";
  if (cacheKey) {
    const cached = getAiStepCache<StageDetectionResult>(cacheKey);
    if (cached) {
      console.info("[stage-detection] cache_hit_state_delta", { leadId: safeLeadId, latestMessageId, provider: providerForKey, model: modelForKey });
      return {
        ...cached,
        usage: null,
        timestamp: new Date().toISOString()
      };
    }
  }

  const execution = await runAiStepSingleFlight(cacheKey, async () => {
    const cachedInside = cacheKey ? getAiStepCache<StageDetectionResult>(cacheKey) : null;
    if (cachedInside) return cachedInside;
    const systemPrompt = buildStageDetectionSystemPrompt();
    const deltaTranscript = JSON.stringify({
      currentState: input.currentState || {},
      latestMessageDelta: input.latestMessageDelta || {},
      recentMinimalContext: Array.isArray(input.recentMinimalContext) ? input.recentMinimalContext : []
    });
    const budgeted = enforceTokenBudget({
      step: "stage_detection",
      transcript: deltaTranscript,
      context: {}
    });
    const safeDelta = (() => {
      try {
        return JSON.parse(budgeted.transcript) as {
          currentState: Record<string, unknown>;
          latestMessageDelta: Record<string, unknown>;
          recentMinimalContext: Array<Record<string, unknown>>;
        };
      } catch {
        return {
          currentState: input.currentState || {},
          latestMessageDelta: input.latestMessageDelta || {},
          recentMinimalContext: Array.isArray(input.recentMinimalContext) ? input.recentMinimalContext : []
        };
      }
    })();
    const userPrompt = buildStageDetectionStateDeltaUserPrompt({
      currentState: safeDelta.currentState || {},
      latestMessageDelta: safeDelta.latestMessageDelta || {},
      recentMinimalContext: Array.isArray(safeDelta.recentMinimalContext) ? safeDelta.recentMinimalContext : []
    });
    const modelCaller = input.callModel || callStageDetectionModel;
    const modelResult = await modelCaller({ systemPrompt, userPrompt });
    const parsed = parseStageDetectionJson(modelResult.rawOutput);
    const analysis = validateStageDetectionAnalysis(parsed);
    const output: StageDetectionResult = {
      analysis,
      transcriptLength: JSON.stringify(input.recentMinimalContext || []).length,
      messageCount: Array.isArray(input.recentMinimalContext) ? input.recentMinimalContext.length : 0,
      source: "state_delta",
      provider: modelResult.provider,
      model: modelResult.model,
      usage: modelResult.usage,
      timestamp: new Date().toISOString()
    };
    if (cacheKey) {
      setAiStepCache(cacheKey, output);
    }
    return output;
  });
  if (execution.joined && cacheKey) {
    console.info("[stage-detection] singleflight_join_state_delta", { leadId: safeLeadId, latestMessageId, cacheKey });
  }
  return {
    ...execution.value,
    usage: execution.joined ? null : execution.value.usage,
    timestamp: new Date().toISOString()
  };
}

export async function detectLeadStage(leadId: string): Promise<StageDetectionResult> {
  const transcript = await buildLeadTranscript(leadId, 30);
  return detectStageFromTranscript({ leadId, transcript });
}
