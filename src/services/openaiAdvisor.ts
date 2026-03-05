import { env } from "../config/env.js";
import {
  createAiAgentRun,
  updateAiAgentRun,
  type AiAgentRunRecord
} from "../db/aiAgentRunsRepo.js";
import { getWhatsAppLeadById, listRecentWhatsAppLeadMessages } from "../db/whatsappLeadsRepo.js";
import { buildAdvisorPrompt, safeJsonParse, validateAdvisorPayload } from "./claudeAdvisor.js";

const DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";
const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_TIMEOUT_MS = 15000;
const OPENAI_MAX_TOKENS_PRIMARY = 700;
const OPENAI_MAX_TOKENS_RETRY = 1400;

function resolveOpenAiModel(rawValue: unknown): string {
  return String(rawValue || "").trim() || DEFAULT_OPENAI_MODEL;
}

function normalizeErrorText(value: string): string {
  return String(value || "").replace(/^claude_/g, "openai_");
}

function extractOpenAiText(payload: unknown): string {
  const root = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const first = choices[0] && typeof choices[0] === "object" ? (choices[0] as Record<string, unknown>) : {};
  const message = first.message && typeof first.message === "object" ? (first.message as Record<string, unknown>) : {};
  return String(message.content || "");
}

function extractUsageTokens(payload: unknown): { input: number | null; output: number | null } {
  const root = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const usage = root.usage && typeof root.usage === "object" ? (root.usage as Record<string, unknown>) : {};
  const input = Number(usage.prompt_tokens);
  const output = Number(usage.completion_tokens);
  return {
    input: Number.isFinite(input) ? Math.max(0, Math.round(input)) : null,
    output: Number.isFinite(output) ? Math.max(0, Math.round(output)) : null
  };
}

function extractFinishReason(payload: unknown): string {
  const root = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const first = choices[0] && typeof choices[0] === "object" ? (choices[0] as Record<string, unknown>) : {};
  return String(first.finish_reason || "").trim().toLowerCase();
}

async function callOpenAiApi(promptText: string, model: string, maxTokens = OPENAI_MAX_TOKENS_PRIMARY): Promise<Record<string, unknown>> {
  const apiKey = String(env.OPENAI_API_KEY || "").trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY missing");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  try {
    const response = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        max_tokens: Math.max(256, Math.round(Number(maxTokens || OPENAI_MAX_TOKENS_PRIMARY))),
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "Return STRICT JSON only." },
          { role: "user", content: promptText }
        ]
      }),
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`openai_http_${response.status}: ${text.slice(0, 500)}`);
    }
    const parsed = safeJsonParse(text);
    if (!parsed) {
      throw new Error("openai_non_json_response");
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

export async function runOpenAiAdvisor(input: {
  leadId: string;
  messageId: string;
  triggerSource?: string;
  messageLimit?: number;
}): Promise<AiAgentRunRecord> {
  const leadId = String(input.leadId || "").trim();
  const messageId = String(input.messageId || "").trim();
  if (!leadId || !messageId) throw new Error("invalid_input");

  const lead = await getWhatsAppLeadById(leadId);
  if (!lead) throw new Error("lead_not_found");
  const messageLimit = Math.max(1, Math.min(200, Math.round(Number(input.messageLimit || 20))));
  const messages = await listRecentWhatsAppLeadMessages(leadId, messageLimit);
  const promptText = buildAdvisorPrompt(lead, messages).replace(
    "You are Claude acting as a WhatsApp sales advisor.",
    "You are an AI acting as a WhatsApp sales advisor."
  );
  const model = resolveOpenAiModel(env.OPENAI_MODEL);
  const triggerSource = String(input.triggerSource || "message_persisted").trim().slice(0, 80) || "message_persisted";

  const run = await createAiAgentRun({
    leadId,
    messageId,
    status: "queued",
    triggerSource,
    model,
    promptText
  });
  console.info("[openai-advisor] queued", { runId: run.id, leadId, messageId, model, triggerSource });

  const startedAt = Date.now();
  try {
    let raw = await callOpenAiApi(promptText, model, OPENAI_MAX_TOKENS_PRIMARY);
    let responseText = extractOpenAiText(raw);
    let parsedJson = safeJsonParse(responseText);
    const finishReason = extractFinishReason(raw);
    if (!parsedJson && finishReason === "length") {
      raw = await callOpenAiApi(promptText, model, OPENAI_MAX_TOKENS_RETRY);
      responseText = extractOpenAiText(raw);
      parsedJson = safeJsonParse(responseText);
    }
    if (!parsedJson) throw new Error("openai_validation_failed:non_json_response");
    const validatedPayload = validateAdvisorPayload(parsedJson);
    const tokens = extractUsageTokens(raw);
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
    console.info("[openai-advisor] success", {
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
    const rawError = error instanceof Error ? error.message : String(error);
    const errorText = normalizeErrorText(rawError);
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
    console.error("[openai-advisor] error", { runId: run.id, leadId, messageId, latencyMs, error: errorText });
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
