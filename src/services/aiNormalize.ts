import type { AiAgentRunRecord } from "../db/aiAgentRunsRepo.js";

export type NormalizedUrgencyLevel = "low" | "medium" | "high";
export type NormalizedRiskLevel = "low" | "medium" | "high";

export type NormalizedSignal = {
  key: string;
  value: string;
};

export type NormalizedRiskFlag = {
  level: NormalizedRiskLevel;
  label: string;
  detail?: string;
};

export type NormalizedSuggestion = {
  id: string;
  title: string;
  goal: string;
  messages: string[];
  reply: string;
  text: string;
  confidence: number;
  rationale?: string;
  controls?: {
    replaceRecommended?: boolean;
    sendAllowed?: boolean;
    requiresApproval?: boolean;
  };
};

export type NormalizedAdvisorRun = {
  runId: string | null;
  status: "queued" | "success" | "error";
  createdAt: string | null;
  triggerSource: string | null;
  model: string | null;
  latencyMs: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  estimatedCostUsd: number | null;
  estimatedCostLabel: string | null;
  stage: { value: string; confidence: number };
  urgency: { level: NormalizedUrgencyLevel; reason?: string };
  detectedSignals: NormalizedSignal[];
  missingInfo: string[];
  riskFlags: NormalizedRiskFlag[];
  suggestions: NormalizedSuggestion[];
  analysis: {
    stage: string;
    reasoning: string;
    missingInformation: string[];
  };
  explain: {
    stage: { value: string; confidence: number };
    urgency: { level: NormalizedUrgencyLevel; reason?: string };
    detectedSignals: NormalizedSignal[];
    missingInfo: string[];
    riskFlags: NormalizedRiskFlag[];
    reasoning?: string;
  };
  error?: {
    code: string;
    message: string;
  };
};

const CLAUDE_MODEL_ALIASES: Record<string, string> = {
  "claude-3-5-haiku-latest": "claude-haiku-4-5-20251001",
  "claude-3-5-haiku-20241022": "claude-haiku-4-5-20251001"
};
const MODEL_PRICING_PER_MILLION_USD: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5-20251001": { input: 1.0, output: 5.0 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 }
};
const EMOJI_REGEX_GLOBAL = /[\p{Extended_Pictographic}\uFE0F\u200D]/gu;
const EMOJI_REGEX_SINGLE = /[\p{Extended_Pictographic}\uFE0F\u200D]/u;

export function normalizeAdvisorModel(model: unknown): string | null {
  const raw = String(model || "").trim();
  if (!raw) return null;
  return CLAUDE_MODEL_ALIASES[raw] || raw;
}

export function estimateAdvisorCostUsd(
  model: unknown,
  tokensIn: unknown,
  tokensOut: unknown
): number | null {
  const normalizedModel = normalizeAdvisorModel(model);
  if (!normalizedModel) return null;
  const pricing = MODEL_PRICING_PER_MILLION_USD[normalizedModel];
  if (!pricing) return null;
  const inTokens = Number(tokensIn);
  const outTokens = Number(tokensOut);
  if (!Number.isFinite(inTokens) || !Number.isFinite(outTokens) || inTokens < 0 || outTokens < 0) return null;
  const inputCost = (inTokens / 1_000_000) * pricing.input;
  const outputCost = (outTokens / 1_000_000) * pricing.output;
  const total = inputCost + outputCost;
  if (!Number.isFinite(total) || total < 0) return null;
  return total;
}

export function formatEstimatedCostUsd(value: unknown): string | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n >= 1) return "$" + n.toFixed(2) + " est.";
  if (n >= 0.01) return "$" + n.toFixed(3) + " est.";
  return "$" + n.toFixed(4) + " est.";
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function safeJsonParseLoose(input: unknown): Record<string, unknown> | null {
  const raw = String(input || "").trim();
  if (!raw) return null;
  const candidates: string[] = [];
  const fenced = raw.match(/```json\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) candidates.push(String(fenced[1]).trim());
  candidates.push(raw);
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(raw.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function stripMarkdownFences(input: unknown): string {
  const raw = String(input || "").trim();
  if (!raw) return "";
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return String(fenced && fenced[1] ? fenced[1] : raw).trim();
}

function extractQuotedField(raw: string, field: string): string {
  const re = new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"])*)"`, "i");
  const m = raw.match(re);
  if (!m || !m[1]) return "";
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return m[1].replace(/\\"/g, "\"").replace(/\\n/g, "\n").trim();
  }
}

function sanitizeSuggestionReply(input: unknown): string {
  const raw = stripMarkdownFences(input);
  if (!raw) return "";
  const parsed = safeJsonParseLoose(raw);
  if (parsed) {
    const fromParsed = String(parsed.reply || "").trim();
    if (fromParsed) return fromParsed;
  }
  const quoted = extractQuotedField(raw, "reply");
  if (quoted) return quoted;
  return raw;
}

function containsEmoji(input: string): boolean {
  return EMOJI_REGEX_SINGLE.test(String(input || ""));
}

function stripEmoji(input: string): string {
  return String(input || "").replace(EMOJI_REGEX_GLOBAL, "").trim();
}

function splitReplyToBubbles(reply: string): string[] {
  const raw = stripEmoji(String(reply || ""));
  if (!raw) return [];
  const byBlocks = raw
    .split(/\n\s*\n+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const source = byBlocks.length > 1 ? byBlocks : [raw];
  const out: string[] = [];
  for (const block of source) {
    const sentences = block
      .split(/(?<=[.!?])\s+(?=[A-ZÀ-ÿ])/)
      .map((x) => x.trim())
      .filter(Boolean);
    const chunks = sentences.length ? sentences : [block];
    for (const chunk of chunks) {
      if (chunk.length <= 120) {
        out.push(chunk);
        continue;
      }
      const words = chunk.split(/\s+/).filter(Boolean);
      let cursor = "";
      for (const w of words) {
        const next = cursor ? `${cursor} ${w}` : w;
        if (next.length > 120 && cursor) {
          out.push(cursor);
          cursor = w;
        } else {
          cursor = next;
        }
      }
      if (cursor) out.push(cursor);
    }
  }
  const cleaned = out.map((x) => x.trim()).filter(Boolean);
  if (cleaned.length >= 2) return cleaned.slice(0, 4);
  if (cleaned.length === 1) {
    const single = cleaned[0];
    if (single.length > 90) {
      const words = single.split(/\s+/).filter(Boolean);
      const half = Math.ceil(words.length / 2);
      const a = words.slice(0, half).join(" ").trim();
      const b = words.slice(half).join(" ").trim();
      const rebuilt = [a, b].filter(Boolean);
      if (rebuilt.length >= 2) return rebuilt.slice(0, 4);
    }
  }
  return cleaned.slice(0, 4);
}

function normalizeSuggestionMessages(item: Record<string, unknown>): string[] {
  const raw = Array.isArray(item.messages) ? item.messages : [];
  const list = raw
    .map((entry) => String(entry || "").trim())
    .filter(Boolean)
    .map((line) => stripEmoji(line))
    .filter(Boolean)
    .map((line) => (line.length > 220 ? line.slice(0, 220).trim() : line))
    .filter((line) => !containsEmoji(line));
  if (list.length >= 2 && list.length <= 4) return list.slice(0, 4);
  const reply = sanitizeSuggestionReply(item.reply || item.text || item.message || item.suggestion || "");
  const fallback = splitReplyToBubbles(reply).filter((line) => !containsEmoji(line));
  return fallback.slice(0, 4);
}

function normalizeConfidence(value: unknown, fallback = 0.5): number {
  const raw = Number(value);
  const base = Number.isFinite(raw) ? (raw > 1 ? raw / 100 : raw) : fallback;
  if (base < 0) return 0;
  if (base > 1) return 1;
  return base;
}

function normalizeUrgencyLevel(value: unknown): NormalizedUrgencyLevel {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "high") return "high";
  if (raw === "medium" || raw === "med") return "medium";
  return "low";
}

function normalizeRiskLevel(value: unknown): NormalizedRiskLevel {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "high" || raw === "critical") return "high";
  if (raw === "medium" || raw === "med") return "medium";
  return "low";
}

function normalizeGoal(rawGoal: unknown): string {
  const raw = String(rawGoal || "").trim().toUpperCase();
  if (!raw) return "FOLLOW_UP";
  if (raw.includes("QUAL")) return "QUALIFICATION";
  if (raw.includes("PRICE")) return "PRICE";
  if (raw.includes("DEPOSIT")) return "DEPOSIT";
  if (raw.includes("FOLLOW")) return "FOLLOW_UP";
  if (raw.includes("VIDEO")) return "VIDEO";
  if (raw.includes("CLOSE") || raw.includes("CONFIRM")) return "CLOSE";
  return raw;
}

function defaultTitleForGoal(goal: string): string {
  if (goal === "QUALIFICATION") return "Qualification";
  if (goal === "PRICE") return "Price Reveal";
  if (goal === "DEPOSIT") return "Deposit";
  if (goal === "VIDEO") return "Video Call";
  if (goal === "CLOSE") return "Close";
  return "Follow-up";
}

function normalizeSuggestions(response: Record<string, unknown>): NormalizedSuggestion[] {
  const rawList: unknown[] = [...(Array.isArray(response.suggestions) ? response.suggestions : [])];
  const items = rawList
    .map((entry, index): NormalizedSuggestion | null => {
      const item = toRecord(entry);
      const messages = normalizeSuggestionMessages(item);
      if (!messages.length) return null;
      const reply = messages.join("\n\n");
      const goal = normalizeGoal(item.goal || item.type || item.intent);
      const controlsRaw = toRecord(item.controls);
      const requiresApproval =
        controlsRaw.requiresApproval ??
        controlsRaw.requires_approval ??
        (goal === "PRICE" ? true : undefined);
      const suggestion: NormalizedSuggestion = {
        id: String(item.id || `s${index + 1}`),
        title: String(item.title || defaultTitleForGoal(goal)),
        goal,
        messages,
        reply,
        text: reply,
        confidence: normalizeConfidence(item.confidence, 0.5),
        rationale: stripEmoji(String(item.rationale || item.reasoning || item.reason || "").trim()) || undefined,
        controls: {
          replaceRecommended: Boolean(controlsRaw.replaceRecommended ?? controlsRaw.replace_recommended ?? false),
          sendAllowed: controlsRaw.sendAllowed == null ? undefined : Boolean(controlsRaw.sendAllowed),
          requiresApproval: requiresApproval == null ? undefined : Boolean(requiresApproval)
        }
      };
      return suggestion;
    })
    .filter((item): item is NormalizedSuggestion => item !== null);
  return items.slice(0, 3);
}

function normalizeMissingInfo(response: Record<string, unknown>): string[] {
  const analysis = toRecord(response.analysis);
  const raw = Array.isArray(analysis.missing_information)
    ? analysis.missing_information
    : Array.isArray(response.missingInfo)
    ? response.missingInfo
    : Array.isArray(response.missing_info)
      ? response.missing_info
      : Array.isArray(response.missing)
        ? response.missing
        : [];
  return raw.map((x) => String(x || "").trim()).filter(Boolean);
}

function normalizeSignals(response: Record<string, unknown>): NormalizedSignal[] {
  const direct = Array.isArray(response.detectedSignals)
    ? response.detectedSignals
    : Array.isArray(response.detected_signals)
      ? response.detected_signals
      : [];
  const list = direct
    .map((entry) => {
      const obj = toRecord(entry);
      const key = String(obj.key || obj.name || "").trim();
      const value = String(obj.value || obj.label || "").trim();
      if (!key || !value) return null;
      return { key, value } satisfies NormalizedSignal;
    })
    .filter((x): x is NormalizedSignal => Boolean(x));
  if (list.length) return list;

  const detectedSignalsObj = toRecord(response.detected_signals || response.signals);
  return Object.entries(detectedSignalsObj)
    .filter(([, value]) => value != null && value !== "")
    .slice(0, 8)
    .map(([key, value]) => ({ key: String(key), value: String(value) }));
}

function normalizeRiskFlags(response: Record<string, unknown>): NormalizedRiskFlag[] {
  const raw = Array.isArray(response.riskFlags)
    ? response.riskFlags
    : Array.isArray(response.risk_flags)
      ? response.risk_flags
      : Array.isArray(response.risks)
        ? response.risks
        : [];
  return raw
    .map((entry) => {
      if (typeof entry === "string") {
        const label = entry.trim();
        if (!label) return null;
        return { level: "medium", label } satisfies NormalizedRiskFlag;
      }
      const obj = toRecord(entry);
      const label = String(obj.label || obj.reason || obj.key || "").trim();
      if (!label) return null;
      return {
        level: normalizeRiskLevel(obj.level || obj.severity),
        label,
        detail: String(obj.detail || obj.evidence || "").trim() || undefined
      } satisfies NormalizedRiskFlag;
    })
    .filter((x): x is NormalizedRiskFlag => Boolean(x));
}

export function normalizeAdvisorRun(run: AiAgentRunRecord | null): NormalizedAdvisorRun {
  if (!run) {
    const emptyStage = { value: "UNKNOWN", confidence: 0.5 };
    const emptyUrgency = { level: "low" as const };
    return {
      runId: null,
      status: "error",
      createdAt: null,
      triggerSource: null,
      model: null,
      latencyMs: null,
      tokensIn: null,
      tokensOut: null,
      estimatedCostUsd: null,
      estimatedCostLabel: null,
      stage: emptyStage,
      urgency: emptyUrgency,
      detectedSignals: [],
      missingInfo: [],
      riskFlags: [],
      suggestions: [],
      analysis: {
        stage: "UNKNOWN",
        reasoning: "",
        missingInformation: []
      },
      explain: {
        stage: emptyStage,
        urgency: emptyUrgency,
        detectedSignals: [],
        missingInfo: [],
        riskFlags: [],
        reasoning: ""
      },
      error: { code: "no_run", message: "No advisor run found" }
    };
  }

  if (run.status !== "success" || !run.responseJson) {
    const emptyStage = { value: "UNKNOWN", confidence: 0.5 };
    const emptyUrgency = { level: "low" as const };
    return {
      runId: run.id,
      status: run.status,
      createdAt: run.createdAt,
      triggerSource: run.triggerSource,
      model: normalizeAdvisorModel(run.model),
      latencyMs: run.latencyMs,
      tokensIn: run.tokensIn,
      tokensOut: run.tokensOut,
      estimatedCostUsd: estimateAdvisorCostUsd(run.model, run.tokensIn, run.tokensOut),
      estimatedCostLabel: formatEstimatedCostUsd(estimateAdvisorCostUsd(run.model, run.tokensIn, run.tokensOut)),
      stage: emptyStage,
      urgency: emptyUrgency,
      detectedSignals: [],
      missingInfo: [],
      riskFlags: [],
      suggestions: [],
      analysis: {
        stage: "UNKNOWN",
        reasoning: "",
        missingInformation: []
      },
      explain: {
        stage: emptyStage,
        urgency: emptyUrgency,
        detectedSignals: [],
        missingInfo: [],
        riskFlags: [],
        reasoning: ""
      },
      error: {
        code: run.status === "error" ? "run_error" : "run_not_ready",
        message: String(run.errorText || "Advisor run is not available")
      }
    };
  }

  const runResponse = toRecord(run.responseJson);
  const recovered = safeJsonParseLoose(runResponse.raw_response);
  const response =
    recovered ||
    (Object.keys(runResponse).length === 1 && String(runResponse.raw_response || "").trim()
      ? {
          ...runResponse
        }
      : runResponse);
  const analysisObj = toRecord(response.analysis);
  const stageObj = toRecord(response.stage);
  const stageValue = String(
    analysisObj.stage ||
    stageObj.value ||
    response.stage_recommendation ||
    response.stageRecommendation ||
      "UNKNOWN"
  ).trim().toUpperCase();
  const stage = {
    value: stageValue || "UNKNOWN",
    confidence: normalizeConfidence(stageObj.confidence ?? response.confidence, 0.5)
  };

  const urgencyObj = toRecord(response.urgency);
  const urgency = {
    level: normalizeUrgencyLevel(urgencyObj.level || response.urgency_level || response.urgency),
    reason: String(urgencyObj.reason || response.urgency_reason || "").trim() || undefined
  };

  const missingInfo = normalizeMissingInfo(response);
  const detectedSignals = normalizeSignals(response);
  const riskFlags = normalizeRiskFlags(response);
  const suggestions = normalizeSuggestions(response);
  const analysisReasoning = String(analysisObj.reasoning || "").trim();
  const analysis = {
    stage: stage.value,
    reasoning: stripEmoji(analysisReasoning),
    missingInformation: missingInfo
  };

  return {
    runId: run.id,
    status: run.status,
    createdAt: run.createdAt,
    triggerSource: run.triggerSource,
    model: normalizeAdvisorModel(run.model),
    latencyMs: run.latencyMs,
    tokensIn: run.tokensIn,
    tokensOut: run.tokensOut,
    estimatedCostUsd: estimateAdvisorCostUsd(run.model, run.tokensIn, run.tokensOut),
    estimatedCostLabel: formatEstimatedCostUsd(estimateAdvisorCostUsd(run.model, run.tokensIn, run.tokensOut)),
    stage,
    urgency,
    detectedSignals,
    missingInfo,
    riskFlags,
    suggestions,
    analysis,
    explain: {
      stage,
      urgency,
      detectedSignals,
      missingInfo,
      riskFlags,
      reasoning: stripEmoji(analysisReasoning)
    }
  };
}
