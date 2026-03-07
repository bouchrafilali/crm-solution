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
    avoid: z.array(z.string())
  })
  .strict();

export type StrategicAdvisorStrategy = z.infer<typeof StrategicAdvisorSchema>;

export type StrategicAdvisorResult = {
  strategy: StrategicAdvisorStrategy;
  stageAnalysis: StageDetectionAnalysis;
  transcriptLength: number;
  messageCount: number;
  provider: AiProvider;
  model: string;
  timestamp: string;
};

export class StrategicAdvisorError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

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
    "You are a senior commercial strategist for luxury WhatsApp couture sales.",
    "Decide the next best business action only. Do not draft client replies.",
    "Return strict JSON only, following the exact required shape and enum values.",
    "Focus on conversion quality, timing, friction reduction, and premium positioning.",
    "Never include markdown or explanatory prose outside JSON."
  ].join("\n");
}

function buildStrategicAdvisorUserPrompt(input: { transcript: string; stageAnalysis: StageDetectionAnalysis }): string {
  return [
    "Based on the transcript and stage analysis, output only valid JSON with this exact shape:",
    "{",
    '  "recommended_action": "qualify | answer_precisely | reassure | propose_video | narrow_options | clarify_deadline | push_softly_to_deposit | reduce_friction_to_payment | reactivate_gently | wait | close_out",',
    '  "action_confidence": 0.0,',
    '  "commercial_priority": "low | medium | high | critical",',
    '  "tone": "soft_luxury | reassuring | decisive_elegant | warm_refined | calm_urgent",',
    '  "pressure_level": "none | low | medium",',
    '  "primary_goal": "one sentence goal",',
    '  "secondary_goal": "one sentence goal",',
    '  "missed_opportunities": [],',
    '  "strategy_rationale": [],',
    '  "do_now": [],',
    '  "avoid": []',
    "}",
    "Stage analysis JSON:",
    JSON.stringify(input.stageAnalysis),
    "Transcript:",
    input.transcript
  ].join("\n");
}

export async function callStrategicAdvisorModel(input: {
  systemPrompt: string;
  userPrompt: string;
}): Promise<{ provider: AiProvider; model: string; rawOutput: string }> {
  const provider = getAiProviderForStep("strategy");

  if (provider === "claude") {
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
        "strategic_advisor_provider_error",
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

    return { provider: "claude", model, rawOutput: text };
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
    rawOutput: content
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
  if (transcriptLength < 30 || messageCount < 2) {
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

  const systemPrompt = buildStrategicAdvisorSystemPrompt();
  const userPrompt = buildStrategicAdvisorUserPrompt({ transcript: transcriptText, stageAnalysis: input.stageAnalysis });
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

  return {
    strategy,
    stageAnalysis: input.stageAnalysis,
    transcriptLength,
    messageCount,
    provider: modelResult.provider,
    model: modelResult.model,
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
