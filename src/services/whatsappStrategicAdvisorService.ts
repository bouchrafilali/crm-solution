import { z } from "zod";
import { env } from "../config/env.js";
import { sanitizeForPrompt } from "./aiTextService.js";
import { buildLeadTranscript, type LeadTranscriptResult } from "./whatsappTranscriptFormatter.js";
import {
  detectStageFromTranscript,
  type StageDetectionAnalysis,
  type StageDetectionResult
} from "./whatsappStageDetectionService.js";
import { getAiProviderForStep, type AiProvider } from "./aiProviderRouting.js";
import type { AiUsageMetrics } from "./aiPricing.js";
import {
  buildAiStepCacheKey,
  getAiStepCache,
  runAiStepSingleFlight,
  resolveLatestMessageIdForLead,
  setAiStepCache
} from "./aiStepCache.js";
import {
  compactStageAnalysisForPrompt,
  enforceTokenBudget
} from "./aiTokenBudget.js";

const ACTION_VALUES = [
  "qualify",
  "answer_precisely",
  "reassure",
  "propose_video",
  "narrow_options",
  "clarify_deadline",
  "push_softly_to_deposit",
  "reduce_friction_to_payment",
  "reactivate_gently",
  "wait",
  "close_out"
] as const;

const COMMERCIAL_PRIORITY_VALUES = ["low", "medium", "high", "critical"] as const;
const TONE_VALUES = ["soft_luxury", "reassuring", "decisive_elegant", "warm_refined", "calm_urgent"] as const;
const PRESSURE_VALUES = ["none", "low", "medium"] as const;
const STRATEGY_PROMPT_VERSION = "v2";

const StrategicAdvisorSchema = z
  .object({
    recommended_action: z.enum(ACTION_VALUES),
    action_confidence: z.number().min(0).max(1),
    commercial_priority: z.enum(COMMERCIAL_PRIORITY_VALUES),
    tone: z.enum(TONE_VALUES),
    pressure_level: z.enum(PRESSURE_VALUES),
    primary_goal: z.string().min(1),
    secondary_goal: z.string().min(1),
    missed_opportunities: z.array(z.string()),
    strategy_rationale: z.array(z.string()),
    do_now: z.array(z.string()),
    avoid: z.array(z.string()),
    needsHumanConfirmation: z.boolean().optional(),
    questions: z
      .array(
        z
          .object({
            field: z.string().min(1),
            question: z.string().min(1)
          })
          .strict()
      )
      .optional()
  })
  .strict();

export type StrategicAdvisorStrategy = z.infer<typeof StrategicAdvisorSchema>;

export type StrategicAdvisorResult = {
  strategy: StrategicAdvisorStrategy;
  stageAnalysis: StageDetectionAnalysis;
  transcriptLength: number;
  messageCount: number;
  source?: "state_delta" | "transcript_fallback";
  provider: AiProvider;
  model: string;
  usage?: AiUsageMetrics | null;
  timestamp: string;
};

export class StrategicAdvisorError extends Error {
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

export function parseStrategicAdvisorJson(raw: string): unknown {
  const source = String(raw || "").trim();
  if (!source) {
    throw new StrategicAdvisorError("strategic_advisor_empty_ai_output", "AI output is empty");
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

  throw new StrategicAdvisorError("strategic_advisor_invalid_json", "AI output is not valid JSON");
}

export function validateStrategicAdvisor(parsed: unknown): StrategicAdvisorStrategy {
  const result = StrategicAdvisorSchema.safeParse(parsed);
  if (!result.success) {
    throw new StrategicAdvisorError(
      "strategic_advisor_invalid_schema",
      `Strategic advisor schema validation failed: ${result.error.issues.map((i) => i.path.join(".")).join(", ") || "unknown"}`
    );
  }
  return result.data;
}

function buildStrategicAdvisorSystemPrompt(): string {
  return [
    "You are a luxury WhatsApp sales strategist.",
    "Decide next best action only.",
    "Return JSON only. No markdown."
  ].join("\n");
}

function buildStrategicAdvisorUserPrompt(input: { transcript: string; stageAnalysis: StageDetectionAnalysis }): string {
  const compactStage = compactStageAnalysisForPrompt(input.stageAnalysis);
  return [
    "Return JSON keys exactly:",
    "recommended_action, action_confidence, commercial_priority, tone, pressure_level, primary_goal, secondary_goal, missed_opportunities, strategy_rationale, do_now, avoid, needsHumanConfirmation, questions",
    "Stage analysis JSON:",
    JSON.stringify(compactStage),
    "Transcript:",
    input.transcript
  ].join("\n");
}

function buildStrategicAdvisorStateDeltaPrompt(input: {
  stageAnalysis: StageDetectionAnalysis;
  currentState: Record<string, unknown>;
  latestMessageDelta: Record<string, unknown>;
  recentMinimalContext: Array<Record<string, unknown>>;
}): string {
  const compactStage = compactStageAnalysisForPrompt(input.stageAnalysis);
  return [
    "Return JSON keys exactly:",
    "recommended_action, action_confidence, commercial_priority, tone, pressure_level, primary_goal, secondary_goal, missed_opportunities, strategy_rationale, do_now, avoid, needsHumanConfirmation, questions",
    "Stage analysis JSON:",
    JSON.stringify(compactStage),
    "Current structured state JSON:",
    JSON.stringify(input.currentState),
    "Latest message delta JSON:",
    JSON.stringify(input.latestMessageDelta),
    "Recent minimal context JSON:",
    JSON.stringify(input.recentMinimalContext)
  ].join("\n");
}

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

function isCrossProviderFallbackEnabled(): boolean {
  const raw = String(env.AI_CROSS_PROVIDER_FALLBACK_ENABLED || "").trim().toLowerCase();
  if (!raw) return true;
  return ["1", "true", "yes", "on"].includes(raw);
}

function classifyProviderFailure(error: unknown): { failureClass: ProviderFailureClass; fallbackAllowed: boolean } {
  const message = error instanceof Error ? String(error.message || "") : String(error || "");
  const lower = message.toLowerCase();
  if (error instanceof StrategicAdvisorError) {
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

export async function callStrategicAdvisorModel(input: {
  systemPrompt: string;
  userPrompt: string;
}): Promise<{ provider: AiProvider; model: string; rawOutput: string; usage: AiUsageMetrics | null }> {
  const provider = getAiProviderForStep("strategy");

  if (provider === "claude") {
    try {
      const apiKey = String(env.CLAUDE_API_KEY || "").trim();
      const model = String(env.CLAUDE_MODEL || "claude-haiku-4-5-20251001").trim() || "claude-haiku-4-5-20251001";
      if (!apiKey) {
        throw new StrategicAdvisorError("strategic_advisor_provider_not_configured", "CLAUDE_API_KEY missing");
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
        throw new StrategicAdvisorError(
          `strategic_advisor_provider_http_${response.status}`,
          `Claude request failed (${response.status}): ${rawResponseText.slice(0, 500)}`
        );
      }

      let payload: unknown;
      try {
        payload = JSON.parse(rawResponseText);
      } catch {
        throw new StrategicAdvisorError("strategic_advisor_provider_non_json", "Provider response is not valid JSON");
      }

      const root = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
      const contentBlocks = Array.isArray(root.content) ? root.content : [];
      const textBlock =
        contentBlocks.find((block) => block && typeof block === "object" && (block as Record<string, unknown>).type === "text") || null;
      const text = textBlock && typeof textBlock === "object" ? String((textBlock as Record<string, unknown>).text || "").trim() : "";
      if (!text) {
        throw new StrategicAdvisorError("strategic_advisor_empty_ai_output", "Provider content is empty");
      }

      return { provider: "claude", model, rawOutput: text, usage: toUsageMetrics(root.usage) };
    } catch (error) {
      const openAiConfigured = Boolean(String(env.OPENAI_API_KEY || "").trim());
      const fallbackEnabled = isCrossProviderFallbackEnabled();
      const classified = classifyProviderFailure(error);
      const fallbackAllowed = openAiConfigured && fallbackEnabled && classified.fallbackAllowed;
      console.warn("[strategic-advisor] provider_failure", {
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
    throw new StrategicAdvisorError("strategic_advisor_provider_not_configured", "OPENAI_API_KEY missing");
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
    throw new StrategicAdvisorError(
      "strategic_advisor_provider_error",
      `OpenAI request failed (${response.status}): ${rawResponseText.slice(0, 500)}`
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawResponseText);
  } catch {
    throw new StrategicAdvisorError(
      "strategic_advisor_provider_non_json",
      "Provider response is not valid JSON"
    );
  }

  const root = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const first = choices[0] && typeof choices[0] === "object" ? (choices[0] as Record<string, unknown>) : {};
  const message = first.message && typeof first.message === "object" ? (first.message as Record<string, unknown>) : {};
  const content = String(message.content || "").trim();
  if (!content) {
    throw new StrategicAdvisorError("strategic_advisor_empty_ai_output", "Provider content is empty");
  }

  return {
    provider: "openai",
    model,
    rawOutput: content,
    usage: toUsageMetrics(root.usage)
  };
}

export async function buildStrategicAdvisorFromContext(input: {
  leadId: string;
  transcript: LeadTranscriptResult;
  stageAnalysis: StageDetectionAnalysis;
  callModel?: typeof callStrategicAdvisorModel;
}): Promise<StrategicAdvisorResult> {
  const safeLeadId = String(input.leadId || "").trim();
  if (!safeLeadId) {
    throw new StrategicAdvisorError("invalid_lead_id", "Lead ID is required");
  }

  const messageCount = Number(input.transcript.messageCount || 0);
  const transcriptLength = Number(input.transcript.transcriptLength || 0);
  const transcriptText = String(input.transcript.transcript || "").trim();
  if (messageCount <= 0 || !transcriptText) {
    throw new StrategicAdvisorError("strategic_advisor_empty_transcript", "Transcript is empty");
  }
  if (transcriptLength < 30 || messageCount < 1) {
    throw new StrategicAdvisorError(
      "strategic_advisor_transcript_too_short",
      "Transcript is too short for strategic advice"
    );
  }

  console.info("[strategic-advisor] request", {
    leadId: safeLeadId,
    stage: input.stageAnalysis.stage,
    recommendedNextAction: input.stageAnalysis.recommended_next_action,
    messageCount,
    transcriptLength,
    transcriptPreview: sanitizeForPrompt(transcriptText, 500)
  });

  const providerForKey = getAiProviderForStep("strategy");
  const modelForKey = providerForKey === "claude"
    ? (String(env.CLAUDE_MODEL || "claude-haiku-4-5-20251001").trim() || "claude-haiku-4-5-20251001")
    : (String(env.OPENAI_MODEL || "gpt-4.1-mini").trim() || "gpt-4.1-mini");
  const latestMessageId = await resolveLatestMessageIdForLead(safeLeadId);
  const cacheKey = latestMessageId
    ? buildAiStepCacheKey({
        leadId: safeLeadId,
        latestMessageId,
        step: "strategic_advisor",
        provider: providerForKey,
        model: modelForKey,
        promptVersion: STRATEGY_PROMPT_VERSION
      })
    : "";
  if (cacheKey) {
    const cached = getAiStepCache<StrategicAdvisorResult>(cacheKey);
    if (cached) {
      console.info("[strategic-advisor] cache_hit", { leadId: safeLeadId, latestMessageId, provider: providerForKey, model: modelForKey });
      return {
        ...cached,
        usage: null,
        timestamp: new Date().toISOString()
      };
    }
  }

  const execution = await runAiStepSingleFlight(cacheKey, async () => {
    const cachedInside = cacheKey ? getAiStepCache<StrategicAdvisorResult>(cacheKey) : null;
    if (cachedInside) return cachedInside;
    const budgeted = enforceTokenBudget({
      step: "strategic_advisor",
      transcript: transcriptText,
      context: { stage: compactStageAnalysisForPrompt(input.stageAnalysis) }
    });
    const systemPrompt = buildStrategicAdvisorSystemPrompt();
    const userPrompt = buildStrategicAdvisorUserPrompt({ transcript: budgeted.transcript, stageAnalysis: input.stageAnalysis });
    const modelCaller = input.callModel || callStrategicAdvisorModel;
    const modelResult = await modelCaller({ systemPrompt, userPrompt });

    console.info("[strategic-advisor] raw-output", {
      leadId: safeLeadId,
      provider: modelResult.provider,
      model: modelResult.model,
      rawOutput: modelResult.rawOutput
    });

    const parsed = parseStrategicAdvisorJson(modelResult.rawOutput);
    const strategy = validateStrategicAdvisor(parsed);

    const output: StrategicAdvisorResult = {
      strategy,
      stageAnalysis: input.stageAnalysis,
      transcriptLength,
      messageCount,
      source: "transcript_fallback",
      provider: modelResult.provider,
      model: modelResult.model,
      usage: modelResult.usage,
      timestamp: new Date().toISOString()
    };
    if (cacheKey) setAiStepCache(cacheKey, output);
    return output;
  });
  if (execution.joined && cacheKey) {
    console.info("[strategic-advisor] singleflight_join", { leadId: safeLeadId, latestMessageId, cacheKey });
  }
  return {
    ...execution.value,
    usage: execution.joined ? null : execution.value.usage,
    timestamp: new Date().toISOString()
  };
}

export async function buildStrategicAdvisorFromStateDelta(input: {
  leadId: string;
  stageAnalysis: StageDetectionAnalysis;
  currentState: Record<string, unknown>;
  latestMessageDelta: Record<string, unknown>;
  recentMinimalContext: Array<Record<string, unknown>>;
  callModel?: typeof callStrategicAdvisorModel;
}): Promise<StrategicAdvisorResult> {
  const safeLeadId = String(input.leadId || "").trim();
  if (!safeLeadId) {
    throw new StrategicAdvisorError("invalid_lead_id", "Lead ID is required");
  }
  const providerForKey = getAiProviderForStep("strategy");
  const modelForKey = providerForKey === "claude"
    ? (String(env.CLAUDE_MODEL || "claude-haiku-4-5-20251001").trim() || "claude-haiku-4-5-20251001")
    : (String(env.OPENAI_MODEL || "gpt-4.1-mini").trim() || "gpt-4.1-mini");
  const latestMessageId = String((input.latestMessageDelta && input.latestMessageDelta.id) || "").trim() || await resolveLatestMessageIdForLead(safeLeadId);
  const cacheKey = latestMessageId
    ? buildAiStepCacheKey({
        leadId: safeLeadId,
        latestMessageId,
        step: "strategic_advisor",
        provider: providerForKey,
        model: modelForKey,
        promptVersion: STRATEGY_PROMPT_VERSION
      })
    : "";
  if (cacheKey) {
    const cached = getAiStepCache<StrategicAdvisorResult>(cacheKey);
    if (cached) {
      console.info("[strategic-advisor] cache_hit_state_delta", { leadId: safeLeadId, latestMessageId, provider: providerForKey, model: modelForKey });
      return {
        ...cached,
        usage: null,
        timestamp: new Date().toISOString()
      };
    }
  }

  const execution = await runAiStepSingleFlight(cacheKey, async () => {
    const cachedInside = cacheKey ? getAiStepCache<StrategicAdvisorResult>(cacheKey) : null;
    if (cachedInside) return cachedInside;
    const deltaText = JSON.stringify({
      stageAnalysis: input.stageAnalysis,
      currentState: input.currentState || {},
      latestMessageDelta: input.latestMessageDelta || {},
      recentMinimalContext: Array.isArray(input.recentMinimalContext) ? input.recentMinimalContext : []
    });
    const budgeted = enforceTokenBudget({
      step: "strategic_advisor",
      transcript: deltaText,
      context: {}
    });
    const safeInput = (() => {
      try {
        return JSON.parse(budgeted.transcript) as {
          stageAnalysis: StageDetectionAnalysis;
          currentState: Record<string, unknown>;
          latestMessageDelta: Record<string, unknown>;
          recentMinimalContext: Array<Record<string, unknown>>;
        };
      } catch {
        return {
          stageAnalysis: input.stageAnalysis,
          currentState: input.currentState || {},
          latestMessageDelta: input.latestMessageDelta || {},
          recentMinimalContext: Array.isArray(input.recentMinimalContext) ? input.recentMinimalContext : []
        };
      }
    })();
    const systemPrompt = buildStrategicAdvisorSystemPrompt();
    const userPrompt = buildStrategicAdvisorStateDeltaPrompt({
      stageAnalysis: safeInput.stageAnalysis,
      currentState: safeInput.currentState || {},
      latestMessageDelta: safeInput.latestMessageDelta || {},
      recentMinimalContext: Array.isArray(safeInput.recentMinimalContext) ? safeInput.recentMinimalContext : []
    });
    const modelCaller = input.callModel || callStrategicAdvisorModel;
    const modelResult = await modelCaller({ systemPrompt, userPrompt });
    const parsed = parseStrategicAdvisorJson(modelResult.rawOutput);
    const strategy = validateStrategicAdvisor(parsed);
    const output: StrategicAdvisorResult = {
      strategy,
      stageAnalysis: input.stageAnalysis,
      transcriptLength: JSON.stringify(input.recentMinimalContext || []).length,
      messageCount: Array.isArray(input.recentMinimalContext) ? input.recentMinimalContext.length : 0,
      source: "state_delta",
      provider: modelResult.provider,
      model: modelResult.model,
      usage: modelResult.usage,
      timestamp: new Date().toISOString()
    };
    if (cacheKey) setAiStepCache(cacheKey, output);
    return output;
  });
  if (execution.joined && cacheKey) {
    console.info("[strategic-advisor] singleflight_join_state_delta", { leadId: safeLeadId, latestMessageId, cacheKey });
  }
  return {
    ...execution.value,
    usage: execution.joined ? null : execution.value.usage,
    timestamp: new Date().toISOString()
  };
}

export async function getLeadStrategicAdvisor(leadId: string): Promise<StrategicAdvisorResult> {
  const transcript = await buildLeadTranscript(leadId, 30);
  const stageDetection: StageDetectionResult = await detectStageFromTranscript({ leadId, transcript });
  return buildStrategicAdvisorFromContext({
    leadId,
    transcript,
    stageAnalysis: stageDetection.analysis
  });
}
