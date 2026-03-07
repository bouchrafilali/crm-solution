import { env } from "../config/env.js";

export type AiProvider = "openai" | "claude";
export type AiProviderStep = "stage" | "strategy" | "reply" | "brand";

function normalizeProvider(value: unknown): AiProvider | null {
  const key = String(value || "").trim().toLowerCase();
  if (key === "openai" || key === "gpt") return "openai";
  if (key === "claude" || key === "anthropic") return "claude";
  return null;
}

const DEFAULT_PROVIDER_BY_STEP: Record<AiProviderStep, AiProvider> = {
  stage: "claude",
  strategy: "claude",
  reply: "openai",
  brand: "openai"
};

export function getAiProviderForStep(step: AiProviderStep): AiProvider {
  const configured =
    step === "stage"
      ? env.AI_STAGE_PROVIDER
      : step === "strategy"
        ? env.AI_STRATEGY_PROVIDER
        : step === "reply"
          ? env.AI_REPLY_PROVIDER
          : env.AI_BRAND_PROVIDER;

  return normalizeProvider(configured) || DEFAULT_PROVIDER_BY_STEP[step];
}
