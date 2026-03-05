import type { AiAgentRunRecord } from "../db/aiAgentRunsRepo.js";

type LatestSuggestion = {
  id: string;
  title: string;
  goal: string;
  text: string;
  confidence: number;
};

export type AiLatestPayload = {
  runId: string;
  createdAt: string;
  stageRecommendation: string | null;
  urgency: string | null;
  missingInfo: string[];
  suggestions: LatestSuggestion[];
};

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function normalizeGoal(input: unknown): string {
  const raw = String(input || "").trim().toUpperCase();
  if (!raw) return "FOLLOW_UP";
  if (raw.includes("QUAL")) return "QUALIFICATION";
  if (raw.includes("PRICE")) return "PRICE";
  if (raw.includes("DEPOSIT")) return "DEPOSIT";
  if (raw.includes("VIDEO")) return "VIDEO";
  if (raw.includes("CLOSE") || raw.includes("CONFIRM")) return "CLOSE";
  return raw;
}

function toSuggestion(item: Record<string, unknown>, index: number): LatestSuggestion | null {
  const text = String(item.text || item.message || item.suggestion || "").trim();
  if (!text) return null;
  const rawConf = Number(item.confidence);
  const confidence = rawConf > 1 ? clamp01(rawConf / 100) : clamp01(rawConf || 0.7);
  const goal = normalizeGoal(item.goal || item.type || item.intent);
  const defaultTitle =
    goal === "QUALIFICATION"
      ? "Qualification"
      : goal === "PRICE"
        ? "Price Reveal"
        : goal === "DEPOSIT"
          ? "Deposit"
          : goal === "VIDEO"
            ? "Video Call"
            : "Follow-up";
  return {
    id: String(item.id || `s${index + 1}`),
    title: String(item.title || defaultTitle),
    goal,
    text,
    confidence
  };
}

function parseSuggestions(response: Record<string, unknown>): LatestSuggestion[] {
  const candidates: unknown[] = [];
  const direct = Array.isArray(response.suggestions) ? response.suggestions : [];
  const nextActions = Array.isArray(response.next_actions) ? response.next_actions : [];
  const actions = Array.isArray(response.actions) ? response.actions : [];
  candidates.push(...direct, ...nextActions, ...actions);

  const list = candidates
    .map((item, idx) => toSuggestion(toRecord(item), idx))
    .filter((item): item is LatestSuggestion => Boolean(item));

  if (list.length) return list.slice(0, 3);

  const fallbackText = String(response.summary || "").trim();
  if (!fallbackText) return [];
  return [
    {
      id: "s1",
      title: "Suggested Reply",
      goal: "FOLLOW_UP",
      text: fallbackText,
      confidence: 0.6
    }
  ];
}

export function normalizeAiLatestRun(run: AiAgentRunRecord): AiLatestPayload {
  const response = toRecord(run.responseJson || {});
  const missingInfo = Array.isArray(response.missing_info)
    ? response.missing_info.map((x) => String(x || "").trim()).filter(Boolean)
    : Array.isArray(response.missing)
      ? response.missing.map((x) => String(x || "").trim()).filter(Boolean)
      : [];

  return {
    runId: run.id,
    createdAt: run.createdAt,
    stageRecommendation: response.stage_recommendation ? String(response.stage_recommendation) : null,
    urgency: response.urgency ? String(response.urgency) : null,
    missingInfo,
    suggestions: parseSuggestions(response)
  };
}
