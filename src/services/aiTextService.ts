import { env } from "../config/env.js";

const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|above|prior)\s+instructions?/gi,
  /disregard\s+(all\s+)?(previous|above|prior|your)\s+/gi,
  /forget\s+(all\s+|your\s+)?(previous|above|prior|all)\s+/gi,
  /you\s+are\s+now\b/gi,
  /new\s+instruction[s:]?/gi,
  /override\s+(previous|all|your)\s+/gi,
  /\[INST]|\[\/INST]/gi,
  /<\|im_start\|>|<\|im_end\|>|<\|system\|>/gi,
  /^system\s*:/gim,
  /^assistant\s*:/gim
];

export function sanitizeForPrompt(value: unknown, maxLength = 400): string {
  let text = String(value ?? "");
  // Strip null bytes and non-printable control characters (keep \n \t \r)
  text = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  for (const pattern of INJECTION_PATTERNS) {
    text = text.replace(pattern, "[removed]");
  }
  if (text.length > maxLength) {
    text = text.slice(0, maxLength) + "…";
  }
  return text.trim();
}

export type AiTextRequest = {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxOutputTokens?: number;
  fallbackText: string;
};

export type AiTextResult = {
  text: string;
  provider: "openai" | "fallback";
  model: string;
};

function parseOpenAIOutput(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const data = payload as Record<string, unknown>;

  const choices = Array.isArray(data.choices) ? data.choices : [];
  if (choices.length > 0) {
    const message = (choices[0] as Record<string, unknown>).message;
    if (message && typeof (message as Record<string, unknown>).content === "string") {
      return ((message as Record<string, unknown>).content as string).trim();
    }
  }

  return "";
}

export async function generateAiText(request: AiTextRequest): Promise<AiTextResult> {
  const model = String(env.OPENAI_MODEL || "gpt-4.1-mini").trim() || "gpt-4.1-mini";
  const apiKey = String(env.OPENAI_API_KEY || "").trim();

  if (!apiKey) {
    return {
      text: request.fallbackText,
      provider: "fallback",
      model
    };
  }

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        temperature: request.temperature ?? 0.2,
        max_tokens: request.maxOutputTokens ?? 240,
        messages: [
          { role: "system", content: request.systemPrompt },
          { role: "user", content: request.userPrompt }
        ]
      })
    });

    if (!response.ok) {
      return {
        text: request.fallbackText,
        provider: "fallback",
        model
      };
    }

    const payload = (await response.json()) as unknown;
    const text = parseOpenAIOutput(payload);
    if (!text) {
      return {
        text: request.fallbackText,
        provider: "fallback",
        model
      };
    }

    return {
      text,
      provider: "openai",
      model
    };
  } catch {
    return {
      text: request.fallbackText,
      provider: "fallback",
      model
    };
  }
}
