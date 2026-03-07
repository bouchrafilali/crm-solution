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

const MESSAGE_MAX_LENGTH = 280;

const ReplyOptionSchema = z
  .object({
    label: z.string().min(1),
    intent: z.string().min(1),
    messages: z.array(z.string().min(1).max(MESSAGE_MAX_LENGTH)).min(2).max(4)
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
    "You write WhatsApp reply options for a luxury couture sales context.",
    "Return JSON only. No markdown.",
    "Generate exactly 3 reply options.",
    "Each option must have 2 to 4 short natural message bubbles.",
    "Tone must feel quiet luxury, human, refined, concise.",
    "No emojis.",
    "No robotic phrasing.",
    "No analysis, commentary, headings, bullet points, or markdown in messages.",
    "Avoid generic filler unless strategically necessary.",
    "Do not repeat the exact same wording across options."
  ].join("\n");
}

function buildReplyGeneratorUserPrompt(input: {
  transcript: string;
  stageAnalysis: StageDetectionAnalysis;
  strategy: StrategicAdvisorStrategy;
}): string {
  return [
    "Generate WhatsApp reply options using this exact output JSON shape:",
    "{",
    '  "reply_options": [',
    '    {"label":"Option 1","intent":"short description","messages":["short bubble 1","short bubble 2"]},',
    '    {"label":"Option 2","intent":"short description","messages":["short bubble 1","short bubble 2","short bubble 3"]},',
    '    {"label":"Option 3","intent":"short description","messages":["short bubble 1","short bubble 2"]}',
    "  ]",
    "}",
    "Rules:",
    "- Exactly 3 options.",
    "- Each option must contain 2 to 4 short messages.",
    "- Each message max 280 chars.",
    "- No emojis.",
    "- No analysis text.",
    "Stage analysis JSON:",
    JSON.stringify(input.stageAnalysis),
    "Strategic advisor JSON:",
    JSON.stringify(input.strategy),
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

  const systemPrompt = buildReplyGeneratorSystemPrompt();
  const userPrompt = buildReplyGeneratorUserPrompt({
    transcript: transcriptText,
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
  const replyOptions = validateReplyGenerator(parsed);

  return {
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
