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
import {
  buildReplyGeneratorFromContext,
  type ReplyGeneratorPayload,
  type ReplyGeneratorResult
} from "./whatsappReplyGeneratorService.js";

const MESSAGE_MAX_LENGTH = 280;

const ReplyOptionSchema = z
  .object({
    label: z.string().min(1),
    intent: z.string().min(1),
    messages: z.array(z.string().min(1).max(MESSAGE_MAX_LENGTH)).min(2).max(4)
  })
  .strict();

const BrandGuardianReviewSchema = z
  .object({
    approved: z.boolean(),
    issues: z.array(z.string()),
    reply_options: z.array(ReplyOptionSchema).length(3)
  })
  .strict();

export type BrandGuardianReview = z.infer<typeof BrandGuardianReviewSchema>;

export type BrandGuardianResult = {
  review: BrandGuardianReview;
  replyOptions: ReplyGeneratorPayload;
  strategy: StrategicAdvisorStrategy;
  stageAnalysis: StageDetectionAnalysis;
  transcriptLength: number;
  messageCount: number;
  provider: "openai";
  model: string;
  timestamp: string;
};

export class BrandGuardianError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function parseBrandGuardianJson(raw: string): unknown {
  const source = String(raw || "").trim();
  if (!source) {
    throw new BrandGuardianError("brand_guardian_empty_ai_output", "AI output is empty");
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

  throw new BrandGuardianError("brand_guardian_invalid_json", "AI output is not valid JSON");
}

export function validateBrandGuardianReview(parsed: unknown): BrandGuardianReview {
  const result = BrandGuardianReviewSchema.safeParse(parsed);
  if (!result.success) {
    throw new BrandGuardianError(
      "brand_guardian_invalid_schema",
      `Brand guardian schema validation failed: ${result.error.issues.map((i) => i.path.join(".")).join(", ") || "unknown"}`
    );
  }
  return result.data;
}

function buildBrandGuardianSystemPrompt(): string {
  return [
    "You are Brand Guardian for Maison BFL WhatsApp replies.",
    "Your task is quality control only.",
    "Assess if replies are elegant, concise, refined, human, premium, non-robotic, non-pushy, non-repetitive, and aligned with quiet luxury.",
    "You may lightly rewrite weak options while preserving strategic intent.",
    "Do not fully rewrite strong options.",
    "Return strict JSON only with the required shape.",
    "No markdown, no extra prose."
  ].join("\n");
}

function buildBrandGuardianUserPrompt(input: {
  transcript: string;
  stageAnalysis: StageDetectionAnalysis;
  strategy: StrategicAdvisorStrategy;
  replyOptions: ReplyGeneratorPayload;
}): string {
  return [
    "Review and refine the reply options if needed. Keep edits light and preserve intent.",
    "Return only valid JSON using this exact shape:",
    "{",
    '  "approved": true,',
    '  "issues": [],',
    '  "reply_options": [',
    '    {"label":"Option 1","intent":"short description","messages":["short bubble 1","short bubble 2"]},',
    '    {"label":"Option 2","intent":"short description","messages":["short bubble 1","short bubble 2","short bubble 3"]},',
    '    {"label":"Option 3","intent":"short description","messages":["short bubble 1","short bubble 2"]}',
    "  ]",
    "}",
    "Hard constraints:",
    "- reply_options must contain exactly 3 options.",
    "- each option must contain 2 to 4 messages.",
    "- each message must be concise and <= 280 chars.",
    "- no emojis, no robotic phrasing, no pushy language.",
    "- keep tone quiet luxury.",
    "Stage analysis JSON:",
    JSON.stringify(input.stageAnalysis),
    "Strategy JSON:",
    JSON.stringify(input.strategy),
    "Current reply options JSON:",
    JSON.stringify(input.replyOptions),
    "Transcript:",
    input.transcript
  ].join("\n");
}

export async function callBrandGuardianModel(input: {
  systemPrompt: string;
  userPrompt: string;
}): Promise<{ provider: "openai"; model: string; rawOutput: string }> {
  const apiKey = String(env.OPENAI_API_KEY || "").trim();
  const model = String(env.OPENAI_MODEL || "gpt-4.1-mini").trim() || "gpt-4.1-mini";
  if (!apiKey) {
    throw new BrandGuardianError("brand_guardian_provider_not_configured", "OPENAI_API_KEY missing");
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
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
    throw new BrandGuardianError(
      "brand_guardian_provider_error",
      `OpenAI request failed (${response.status}): ${rawResponseText.slice(0, 500)}`
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawResponseText);
  } catch {
    throw new BrandGuardianError("brand_guardian_provider_non_json", "Provider response is not valid JSON");
  }

  const root = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const first = choices[0] && typeof choices[0] === "object" ? (choices[0] as Record<string, unknown>) : {};
  const message = first.message && typeof first.message === "object" ? (first.message as Record<string, unknown>) : {};
  const content = String(message.content || "").trim();
  if (!content) {
    throw new BrandGuardianError("brand_guardian_empty_ai_output", "Provider content is empty");
  }

  return {
    provider: "openai",
    model,
    rawOutput: content
  };
}

export async function buildBrandGuardianFromContext(input: {
  leadId: string;
  transcript: LeadTranscriptResult;
  stageAnalysis: StageDetectionAnalysis;
  strategy: StrategicAdvisorStrategy;
  replyOptions: ReplyGeneratorPayload;
  callModel?: typeof callBrandGuardianModel;
}): Promise<BrandGuardianResult> {
  const safeLeadId = String(input.leadId || "").trim();
  if (!safeLeadId) {
    throw new BrandGuardianError("invalid_lead_id", "Lead ID is required");
  }

  const messageCount = Number(input.transcript.messageCount || 0);
  const transcriptLength = Number(input.transcript.transcriptLength || 0);
  const transcriptText = String(input.transcript.transcript || "").trim();
  if (messageCount <= 0 || !transcriptText) {
    throw new BrandGuardianError("brand_guardian_empty_transcript", "Transcript is empty");
  }
  if (transcriptLength < 30 || messageCount < 2) {
    throw new BrandGuardianError("brand_guardian_transcript_too_short", "Transcript is too short for brand review");
  }

  console.info("[brand-guardian] request", {
    leadId: safeLeadId,
    stage: input.stageAnalysis.stage,
    strategyAction: input.strategy.recommended_action,
    tone: input.strategy.tone,
    messageCount,
    transcriptLength,
    transcriptPreview: sanitizeForPrompt(transcriptText, 500)
  });

  const systemPrompt = buildBrandGuardianSystemPrompt();
  const userPrompt = buildBrandGuardianUserPrompt({
    transcript: transcriptText,
    stageAnalysis: input.stageAnalysis,
    strategy: input.strategy,
    replyOptions: input.replyOptions
  });

  const modelCaller = input.callModel || callBrandGuardianModel;
  const modelResult = await modelCaller({ systemPrompt, userPrompt });

  console.info("[brand-guardian] raw-output", {
    leadId: safeLeadId,
    provider: modelResult.provider,
    model: modelResult.model,
    rawOutput: modelResult.rawOutput
  });

  const parsed = parseBrandGuardianJson(modelResult.rawOutput);
  const review = validateBrandGuardianReview(parsed);

  return {
    review,
    replyOptions: input.replyOptions,
    strategy: input.strategy,
    stageAnalysis: input.stageAnalysis,
    transcriptLength,
    messageCount,
    provider: modelResult.provider,
    model: modelResult.model,
    timestamp: new Date().toISOString()
  };
}

export async function getLeadBrandGuardian(leadId: string): Promise<BrandGuardianResult> {
  const transcript = await buildLeadTranscript(leadId, 30);
  const stageDetection: StageDetectionResult = await detectStageFromTranscript({ leadId, transcript });
  const strategicAdvisor: StrategicAdvisorResult = await buildStrategicAdvisorFromContext({
    leadId,
    transcript,
    stageAnalysis: stageDetection.analysis
  });
  const replyGenerator: ReplyGeneratorResult = await buildReplyGeneratorFromContext({
    leadId,
    transcript,
    stageAnalysis: stageDetection.analysis,
    strategy: strategicAdvisor.strategy
  });

  return buildBrandGuardianFromContext({
    leadId,
    transcript,
    stageAnalysis: stageDetection.analysis,
    strategy: strategicAdvisor.strategy,
    replyOptions: replyGenerator.replyOptions
  });
}
