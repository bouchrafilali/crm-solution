import { env } from "../config/env.js";

export type AiUsageMetrics = {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
};

export type AiUnitPricing = {
  inputPerMillion: number;
  outputPerMillion: number;
};

const DEFAULT_PRICING: Record<string, AiUnitPricing> = {
  "claude:claude-haiku-4-5-20251001": { inputPerMillion: 1.0, outputPerMillion: 5.0 },
  "openai:gpt-4.1-mini": { inputPerMillion: 0.4, outputPerMillion: 1.6 }
};

function parseNumber(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function parsePricingConfig(raw: string): Record<string, AiUnitPricing> {
  try {
    const parsed = JSON.parse(String(raw || "").trim());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, AiUnitPricing> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!key || !value || typeof value !== "object" || Array.isArray(value)) continue;
      const row = value as Record<string, unknown>;
      const inputPerMillion = parseNumber(row.inputPerMillion ?? row.input ?? row.in);
      const outputPerMillion = parseNumber(row.outputPerMillion ?? row.output ?? row.out);
      if (inputPerMillion == null || outputPerMillion == null) continue;
      out[String(key).trim().toLowerCase()] = { inputPerMillion, outputPerMillion };
    }
    return out;
  } catch {
    return {};
  }
}

function normalizeModel(model: string): string {
  const raw = String(model || "").trim();
  if (!raw) return "";
  if (raw === "claude-3-5-haiku-latest" || raw === "claude-3-5-haiku-20241022") {
    return "claude-haiku-4-5-20251001";
  }
  return raw;
}

export function resolveAiUnitPricing(provider: string, model: string): AiUnitPricing | null {
  const providerKey = String(provider || "").trim().toLowerCase();
  const modelKey = normalizeModel(model).toLowerCase();
  if (!providerKey || !modelKey) return null;
  const configured = parsePricingConfig(String(env.AI_MODEL_PRICING_JSON || ""));
  const key = `${providerKey}:${modelKey}`;
  return configured[key] || DEFAULT_PRICING[key] || null;
}

export function estimateAiCostUsd(input: {
  provider: string;
  model: string;
  usage: AiUsageMetrics | null | undefined;
}): {
  unitInputPricePerMillion: number | null;
  unitOutputPricePerMillion: number | null;
  estimatedCostUsd: number | null;
} {
  const pricing = resolveAiUnitPricing(input.provider, input.model);
  if (!pricing || !input.usage) {
    return {
      unitInputPricePerMillion: pricing ? pricing.inputPerMillion : null,
      unitOutputPricePerMillion: pricing ? pricing.outputPerMillion : null,
      estimatedCostUsd: null
    };
  }
  const inTokens = Number(input.usage.inputTokens);
  const outTokens = Number(input.usage.outputTokens);
  if (!Number.isFinite(inTokens) || !Number.isFinite(outTokens) || inTokens < 0 || outTokens < 0) {
    return {
      unitInputPricePerMillion: pricing.inputPerMillion,
      unitOutputPricePerMillion: pricing.outputPerMillion,
      estimatedCostUsd: null
    };
  }
  const inputCost = (inTokens / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (outTokens / 1_000_000) * pricing.outputPerMillion;
  return {
    unitInputPricePerMillion: pricing.inputPerMillion,
    unitOutputPricePerMillion: pricing.outputPerMillion,
    estimatedCostUsd: Number((inputCost + outputCost).toFixed(8))
  };
}
