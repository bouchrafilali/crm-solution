import { z } from "zod";
import { env } from "../config/env.js";
import { sanitizeForPrompt } from "./aiTextService.js";
import { buildLeadTranscript, type LeadTranscriptResult } from "./whatsappTranscriptFormatter.js";
import { buildAiCardsViewModel, type AiCardsViewModel } from "./whatsappAiCardsService.js";
import { buildLeadReactivationCheck, type ReactivationDecision } from "./whatsappReactivationEngineService.js";
import { attachReasonShortToReplyOptions } from "./whatsappSuggestionReasonService.js";

const MESSAGE_MAX_LENGTH = 280;

const ReactivationReplyOptionSchema = z
  .object({
    label: z.string().min(1),
    intent: z.string().min(1),
    messages: z.array(z.string().min(1).max(MESSAGE_MAX_LENGTH)).min(2).max(3),
    reason_short: z.string().min(1).max(220).optional()
  })
  .strict();

const ReactivationReplyPayloadSchema = z
  .object({
    shouldGenerate: z.boolean(),
    replyOptions: z.array(ReactivationReplyOptionSchema)
  })
  .strict();

export type ReactivationReplyPayload = z.infer<typeof ReactivationReplyPayloadSchema>;

export type ReactivationReplyResult = {
  shouldGenerate: boolean;
  reactivationDecision: ReactivationDecision;
  replyOptions: ReactivationReplyPayload["replyOptions"];
  provider: string;
  model: string;
  timestamp: string;
};

export class ReactivationReplyError extends Error {
  code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message);
    this.code = code;
    if (options && "cause" in options) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export function parseReactivationReplyJson(raw: string): unknown {
  const source = String(raw || "").trim();
  if (!source) {
    throw new ReactivationReplyError("reactivation_replies_empty_ai_output", "AI output is empty");
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

  throw new ReactivationReplyError("reactivation_replies_invalid_json", "AI output is not valid JSON");
}

export function validateReactivationReplyPayload(parsed: unknown): ReactivationReplyPayload {
  const result = ReactivationReplyPayloadSchema.safeParse(parsed);
  if (!result.success) {
    throw new ReactivationReplyError(
      "reactivation_replies_invalid_schema",
      `Reactivation replies schema validation failed: ${result.error.issues.map((i) => i.path.join(".")).join(", ") || "unknown"}`
    );
  }

  const payload = result.data;
  if (payload.shouldGenerate !== true) {
    throw new ReactivationReplyError(
      "reactivation_replies_invalid_schema",
      "AI response must set shouldGenerate=true for generated reactivation replies"
    );
  }
  if (payload.replyOptions.length !== 3) {
    throw new ReactivationReplyError(
      "reactivation_replies_invalid_schema",
      "AI response must contain exactly 3 reply options"
    );
  }

  return payload;
}

function buildReactivationReplySystemPrompt(): string {
  return [
    "You write WhatsApp reactivation replies for a luxury couture maison.",
    "Generate refined, warm, elegant follow-up options.",
    "Keep tone non-pushy and human.",
    "No emojis. No robotic phrasing. No generic filler.",
    "Return JSON only with exact required shape.",
    "Each option must have 2 to 3 short bubbles."
  ].join("\n");
}

function buildReactivationReplyUserPrompt(input: {
  transcript: string;
  aiCards: AiCardsViewModel;
  decision: ReactivationDecision;
}): string {
  return [
    "Generate reactivation replies only for this stalled lead context.",
    "Return strict JSON in this exact shape:",
    "{",
    '  "shouldGenerate": true,',
    '  "replyOptions": [',
    '    {"label":"Option 1","intent":"short description","messages":["short bubble 1","short bubble 2"]},',
    '    {"label":"Option 2","intent":"short description","messages":["short bubble 1","short bubble 2"]},',
    '    {"label":"Option 3","intent":"short description","messages":["short bubble 1","short bubble 2","short bubble 3"]}',
    "  ]",
    "}",
    "Hard rules:",
    "- Exactly 3 options.",
    "- Each option 2 to 3 short bubbles.",
    "- Each bubble <= 280 chars.",
    "- No emojis, no markdown, no analysis text.",
    "- Adapt to stalled stage context.",
    "Reactivation decision JSON:",
    JSON.stringify(input.decision),
    "AI cards summary JSON:",
    JSON.stringify({
      summary: input.aiCards.summary,
      strategy: input.aiCards.strategy,
      facts: input.aiCards.facts
    }),
    "Transcript:",
    input.transcript
  ].join("\n");
}

export async function callReactivationReplyModel(input: {
  systemPrompt: string;
  userPrompt: string;
}): Promise<{ provider: "openai"; model: string; rawOutput: string }> {
  const apiKey = String(env.OPENAI_API_KEY || "").trim();
  const model = String(env.OPENAI_MODEL || "gpt-4.1-mini").trim() || "gpt-4.1-mini";
  if (!apiKey) {
    throw new ReactivationReplyError("reactivation_replies_provider_not_configured", "OPENAI_API_KEY missing");
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
      max_tokens: 1000,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: input.systemPrompt },
        { role: "user", content: input.userPrompt }
      ]
    })
  });

  const rawResponseText = await response.text();
  if (!response.ok) {
    throw new ReactivationReplyError(
      "reactivation_replies_provider_error",
      `OpenAI request failed (${response.status}): ${rawResponseText.slice(0, 500)}`
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawResponseText);
  } catch {
    throw new ReactivationReplyError("reactivation_replies_provider_non_json", "Provider response is not valid JSON");
  }

  const root = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const first = choices[0] && typeof choices[0] === "object" ? (choices[0] as Record<string, unknown>) : {};
  const message = first.message && typeof first.message === "object" ? (first.message as Record<string, unknown>) : {};
  const content = String(message.content || "").trim();
  if (!content) {
    throw new ReactivationReplyError("reactivation_replies_empty_ai_output", "Provider content is empty");
  }

  return {
    provider: "openai",
    model,
    rawOutput: content
  };
}

export async function buildReactivationRepliesFromContext(input: {
  leadId: string;
  reactivationDecision: ReactivationDecision;
  transcript: LeadTranscriptResult;
  aiCards: AiCardsViewModel;
  callModel?: typeof callReactivationReplyModel;
}): Promise<ReactivationReplyResult> {
  const leadId = String(input.leadId || "").trim();
  if (!leadId) {
    throw new ReactivationReplyError("reactivation_replies_invalid_lead_id", "Lead ID is required");
  }

  if (!input.reactivationDecision.shouldReactivate) {
    return {
      shouldGenerate: false,
      reactivationDecision: input.reactivationDecision,
      replyOptions: [],
      provider: "none",
      model: "none",
      timestamp: new Date().toISOString()
    };
  }

  const transcriptText = String(input.transcript.transcript || "").trim();
  const messageCount = Number(input.transcript.messageCount || 0);
  const transcriptLength = Number(input.transcript.transcriptLength || 0);

  if (!transcriptText || messageCount <= 0 || transcriptLength < 30) {
    throw new ReactivationReplyError(
      "reactivation_replies_transcript_too_short",
      "Transcript is too short for reactivation reply generation"
    );
  }

  console.info("[reactivation-replies] request", {
    leadId,
    stalledStage: input.reactivationDecision.stalledStage,
    priority: input.reactivationDecision.reactivationPriority,
    timing: input.reactivationDecision.timing,
    transcriptPreview: sanitizeForPrompt(transcriptText, 500)
  });

  const systemPrompt = buildReactivationReplySystemPrompt();
  const userPrompt = buildReactivationReplyUserPrompt({
    transcript: transcriptText,
    aiCards: input.aiCards,
    decision: input.reactivationDecision
  });

  const modelCaller = input.callModel || callReactivationReplyModel;
  const modelResult = await modelCaller({ systemPrompt, userPrompt });

  console.info("[reactivation-replies] raw-output", {
    leadId,
    provider: modelResult.provider,
    model: modelResult.model,
    rawOutput: modelResult.rawOutput
  });

  const parsed = parseReactivationReplyJson(modelResult.rawOutput);
  const validated = validateReactivationReplyPayload(parsed);

  return {
    shouldGenerate: true,
    reactivationDecision: input.reactivationDecision,
    replyOptions: attachReasonShortToReplyOptions(validated.replyOptions, {
      language: "en",
      stage: input.reactivationDecision.stalledStage,
      urgency: input.reactivationDecision.reactivationPriority,
      dropoffRisk: "high",
      reactivation: true
    }),
    provider: modelResult.provider,
    model: modelResult.model,
    timestamp: new Date().toISOString()
  };
}

export async function buildLeadReactivationReplies(leadId: string): Promise<ReactivationReplyResult> {
  const safeLeadId = String(leadId || "").trim();
  if (!safeLeadId) {
    throw new ReactivationReplyError("reactivation_replies_invalid_lead_id", "Lead ID is required");
  }

  const [reactivationDecision, transcript, aiCards] = await Promise.all([
    buildLeadReactivationCheck(safeLeadId),
    buildLeadTranscript(safeLeadId, 30),
    buildAiCardsViewModel(safeLeadId)
  ]);

  return buildReactivationRepliesFromContext({
    leadId: safeLeadId,
    reactivationDecision,
    transcript,
    aiCards
  });
}
