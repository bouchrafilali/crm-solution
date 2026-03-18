import { z } from "zod";
import { env } from "../config/env.js";
import { sanitizeForPrompt } from "./aiTextService.js";
import { buildLeadTranscript, type LeadTranscriptResult } from "./whatsappTranscriptFormatter.js";
import {
  detectStageFromTranscript,
  type StageDetectionAnalysis,
  type StageDetectionResult
} from "./whatsappStageDetectionService.js";
import {
  buildStrategicAdvisorFromContext,
  type StrategicAdvisorResult,
  type StrategicAdvisorStrategy
} from "./whatsappStrategicAdvisorService.js";
import { getAiProviderForStep, type AiProvider } from "./aiProviderRouting.js";
import type { AiUsageMetrics } from "./aiPricing.js";
import { attachReasonShortToReplyOptions } from "./whatsappSuggestionReasonService.js";
import {
  buildAiStepCacheKey,
  getAiStepCache,
  resolveLatestMessageIdForLead,
  setAiStepCache
} from "./aiStepCache.js";
import {
  compactStageAnalysisForPrompt,
  compactStrategyForPrompt,
  enforceTokenBudget
} from "./aiTokenBudget.js";

const MESSAGE_MAX_LENGTH = 280;
const REPLY_PROMPT_VERSION = "v2";

const ReplyOptionSchema = z
  .object({
    label: z.string().min(1),
    intent: z.string().min(1),
    messages: z.array(z.string().min(1).max(MESSAGE_MAX_LENGTH)).min(2).max(4),
    reason_short: z.string().min(1).max(220).optional()
  })
  .strict();

const ReplyGeneratorSchema = z
  .object({
    reply_options: z.array(ReplyOptionSchema).length(3)
  })
  .strict();

export type ReplyGeneratorPayload = z.infer<typeof ReplyGeneratorSchema>;

export type ReplyGeneratorResult = {
  replyOptions: ReplyGeneratorPayload;
  strategy: StrategicAdvisorStrategy;
  stageAnalysis: StageDetectionAnalysis;
  transcriptLength: number;
  messageCount: number;
  provider: AiProvider;
  model: string;
  usage?: AiUsageMetrics | null;
  timestamp: string;
};

export class ReplyGeneratorError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function parseReplyGeneratorJson(raw: string): unknown {
  const source = String(raw || "").trim();
  if (!source) {
    throw new ReplyGeneratorError("reply_generator_empty_ai_output", "AI output is empty");
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

  throw new ReplyGeneratorError("reply_generator_invalid_json", "AI output is not valid JSON");
}

export function validateReplyGenerator(parsed: unknown): ReplyGeneratorPayload {
  const result = ReplyGeneratorSchema.safeParse(parsed);
  if (!result.success) {
    throw new ReplyGeneratorError(
      "reply_generator_invalid_schema",
      `Reply generator schema validation failed: ${result.error.issues.map((i) => i.path.join(".")).join(", ") || "unknown"}`
    );
  }
  return result.data;
}

function buildReplyGeneratorSystemPrompt(): string {
  return [
    "Generate luxury WhatsApp reply options.",
    "Return JSON only.",
    "Exactly 3 options; each has 2-4 short messages.",
    "No emoji, no markdown, no analysis."
  ].join("\n");
}

function buildReplyGeneratorUserPrompt(input: {
  transcript: string;
  stageAnalysis: StageDetectionAnalysis;
  strategy: StrategicAdvisorStrategy;
}): string {
  const compactStage = compactStageAnalysisForPrompt(input.stageAnalysis);
  const compactStrategy = compactStrategyForPrompt(input.strategy);
  return [
    'Return JSON: {"reply_options":[{"label":"...","intent":"...","messages":["..."]}]}',
    "Stage analysis JSON:",
    JSON.stringify(compactStage),
    "Strategic advisor JSON:",
    JSON.stringify(compactStrategy),
    "Transcript:",
    input.transcript
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

export async function callReplyGeneratorModel(input: {
  systemPrompt: string;
  userPrompt: string;
}): Promise<{ provider: AiProvider; model: string; rawOutput: string; usage: AiUsageMetrics | null }> {
  const provider = getAiProviderForStep("reply");

  if (provider === "claude") {
    const apiKey = String(env.CLAUDE_API_KEY || "").trim();
    const model = String(env.CLAUDE_MODEL || "claude-haiku-4-5-20251001").trim() || "claude-haiku-4-5-20251001";
    if (!apiKey) {
      throw new ReplyGeneratorError("reply_generator_provider_not_configured", "CLAUDE_API_KEY missing");
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
        temperature: 0.35,
        max_tokens: 1200,
        system: input.systemPrompt,
        messages: [{ role: "user", content: input.userPrompt }]
      })
    });

    const rawResponseText = await response.text();
    if (!response.ok) {
      throw new ReplyGeneratorError(
        "reply_generator_provider_error",
        `Claude request failed (${response.status}): ${rawResponseText.slice(0, 500)}`
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawResponseText);
    } catch {
      throw new ReplyGeneratorError("reply_generator_provider_non_json", "Provider response is not valid JSON");
    }

    const root = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
    const contentBlocks = Array.isArray(root.content) ? root.content : [];
    const textBlock =
      contentBlocks.find((block) => block && typeof block === "object" && (block as Record<string, unknown>).type === "text") || null;
    const text = textBlock && typeof textBlock === "object" ? String((textBlock as Record<string, unknown>).text || "").trim() : "";
    if (!text) {
      throw new ReplyGeneratorError("reply_generator_empty_ai_output", "Provider content is empty");
    }

    return { provider: "claude", model, rawOutput: text, usage: toUsageMetrics(root.usage) };
  }

  const apiKey = String(env.OPENAI_API_KEY || "").trim();
  const model = String(env.OPENAI_MODEL || "gpt-4.1-mini").trim() || "gpt-4.1-mini";
  if (!apiKey) {
    throw new ReplyGeneratorError("reply_generator_provider_not_configured", "OPENAI_API_KEY missing");
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.35,
      max_tokens: 1200,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: input.systemPrompt },
        { role: "user", content: input.userPrompt }
      ]
    })
  });

  const rawResponseText = await response.text();
  if (!response.ok) {
    throw new ReplyGeneratorError(
      "reply_generator_provider_error",
      `OpenAI request failed (${response.status}): ${rawResponseText.slice(0, 500)}`
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawResponseText);
  } catch {
    throw new ReplyGeneratorError("reply_generator_provider_non_json", "Provider response is not valid JSON");
  }

  const root = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const first = choices[0] && typeof choices[0] === "object" ? (choices[0] as Record<string, unknown>) : {};
  const message = first.message && typeof first.message === "object" ? (first.message as Record<string, unknown>) : {};
  const content = String(message.content || "").trim();
  if (!content) {
    throw new ReplyGeneratorError("reply_generator_empty_ai_output", "Provider content is empty");
  }

  return {
    provider: "openai",
    model,
    rawOutput: content,
    usage: toUsageMetrics(root.usage)
  };
}

export async function buildReplyGeneratorFromContext(input: {
  leadId: string;
  transcript: LeadTranscriptResult;
  stageAnalysis: StageDetectionAnalysis;
  strategy: StrategicAdvisorStrategy;
  callModel?: typeof callReplyGeneratorModel;
}): Promise<ReplyGeneratorResult> {
  const safeLeadId = String(input.leadId || "").trim();
  if (!safeLeadId) {
    throw new ReplyGeneratorError("invalid_lead_id", "Lead ID is required");
  }

  const messageCount = Number(input.transcript.messageCount || 0);
  const transcriptLength = Number(input.transcript.transcriptLength || 0);
  const transcriptText = String(input.transcript.transcript || "").trim();
  if (messageCount <= 0 || !transcriptText) {
    throw new ReplyGeneratorError("reply_generator_empty_transcript", "Transcript is empty");
  }
  if (transcriptLength < 30 || messageCount < 1) {
    throw new ReplyGeneratorError("reply_generator_transcript_too_short", "Transcript is too short for reply generation");
  }

  console.info("[reply-generator] request", {
    leadId: safeLeadId,
    stage: input.stageAnalysis.stage,
    strategyAction: input.strategy.recommended_action,
    tone: input.strategy.tone,
    messageCount,
    transcriptLength,
    transcriptPreview: sanitizeForPrompt(transcriptText, 500)
  });

  const providerForKey = getAiProviderForStep("reply");
  const modelForKey = providerForKey === "claude"
    ? (String(env.CLAUDE_MODEL || "claude-haiku-4-5-20251001").trim() || "claude-haiku-4-5-20251001")
    : (String(env.OPENAI_MODEL || "gpt-4.1-mini").trim() || "gpt-4.1-mini");
  const latestMessageId = await resolveLatestMessageIdForLead(safeLeadId);
  const cacheKey = latestMessageId
    ? buildAiStepCacheKey({
        leadId: safeLeadId,
        latestMessageId,
        step: "reply_generator",
        provider: providerForKey,
        model: modelForKey,
        promptVersion: REPLY_PROMPT_VERSION
      })
    : "";
  if (cacheKey) {
    const cached = getAiStepCache<ReplyGeneratorResult>(cacheKey);
    if (cached) {
      console.info("[reply-generator] cache_hit", { leadId: safeLeadId, latestMessageId, provider: providerForKey, model: modelForKey });
      return {
        ...cached,
        usage: null,
        timestamp: new Date().toISOString()
      };
    }
  }

  const budgeted = enforceTokenBudget({
    step: "reply_generator",
    transcript: transcriptText,
    context: {
      stage: compactStageAnalysisForPrompt(input.stageAnalysis),
      strategy: compactStrategyForPrompt(input.strategy)
    }
  });
  const systemPrompt = buildReplyGeneratorSystemPrompt();
  const userPrompt = buildReplyGeneratorUserPrompt({
    transcript: budgeted.transcript,
    stageAnalysis: input.stageAnalysis,
    strategy: input.strategy
  });
  const modelCaller = input.callModel || callReplyGeneratorModel;
  const modelResult = await modelCaller({ systemPrompt, userPrompt });

  console.info("[reply-generator] raw-output", {
    leadId: safeLeadId,
    provider: modelResult.provider,
    model: modelResult.model,
    rawOutput: modelResult.rawOutput
  });

  const parsed = parseReplyGeneratorJson(modelResult.rawOutput);
  const replyOptionsRaw = validateReplyGenerator(parsed);
  const replyOptions = {
    ...replyOptionsRaw,
    reply_options: attachReasonShortToReplyOptions(replyOptionsRaw.reply_options, {
      language: "en",
      stage: input.stageAnalysis.stage,
      recommendedAction: input.strategy.recommended_action,
      urgency: input.stageAnalysis.urgency,
      dropoffRisk: input.stageAnalysis.dropoff_risk,
      paymentIntent: input.stageAnalysis.payment_intent
    })
  };

  const output: ReplyGeneratorResult = {
    replyOptions,
    strategy: input.strategy,
    stageAnalysis: input.stageAnalysis,
    transcriptLength,
    messageCount,
    provider: modelResult.provider,
    model: modelResult.model,
    usage: modelResult.usage,
    timestamp: new Date().toISOString()
  };
  if (cacheKey) setAiStepCache(cacheKey, output);
  return output;
}

export async function getLeadReplyGenerator(leadId: string): Promise<ReplyGeneratorResult> {
  const transcript = await buildLeadTranscript(leadId, 30);
  const stageDetection: StageDetectionResult = await detectStageFromTranscript({ leadId, transcript });
  const strategicAdvisor: StrategicAdvisorResult = await buildStrategicAdvisorFromContext({
    leadId,
    transcript,
    stageAnalysis: stageDetection.analysis
  });

  return buildReplyGeneratorFromContext({
    leadId,
    transcript,
    stageAnalysis: stageDetection.analysis,
    strategy: strategicAdvisor.strategy
  });
}
