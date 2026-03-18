type TokenBudgetStep = "stage_detection" | "strategic_advisor" | "reply_generator" | "brand_guardian";

const STEP_INPUT_TOKEN_BUDGET: Record<TokenBudgetStep, number> = {
  stage_detection: 2200,
  strategic_advisor: 1800,
  reply_generator: 2000,
  brand_guardian: 1800
};

const APPROX_CHARS_PER_TOKEN = 4;

function charsBudget(step: TokenBudgetStep): number {
  return STEP_INPUT_TOKEN_BUDGET[step] * APPROX_CHARS_PER_TOKEN;
}

function trimTranscriptLines(transcript: string, maxLines: number): string {
  const lines = String(transcript || "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);
  if (lines.length <= maxLines) return lines.join("\n");
  return lines.slice(-maxLines).join("\n");
}

function roughSummarizeTranscript(transcript: string): string {
  const lines = String(transcript || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-6);
  return lines.join("\n");
}

export function compactStageAnalysisForPrompt(value: unknown): Record<string, unknown> {
  const row = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const facts = row.facts && typeof row.facts === "object" && !Array.isArray(row.facts) ? (row.facts as Record<string, unknown>) : {};
  const signals = Array.isArray(row.signals) ? row.signals : [];
  return {
    stage: String(row.stage || ""),
    stage_confidence: Number(row.stage_confidence ?? 0),
    urgency: String(row.urgency || "low"),
    payment_intent: Boolean(row.payment_intent),
    dropoff_risk: String(row.dropoff_risk || "low"),
    recommended_next_action: String(row.recommended_next_action || ""),
    signals: signals
      .slice(0, 6)
      .map((entry) => (entry && typeof entry === "object" ? entry : null))
      .filter(Boolean)
      .map((entry) => {
        const s = entry as Record<string, unknown>;
        return { type: String(s.type || ""), evidence: String(s.evidence || "") };
      }),
    facts: {
      products_of_interest: Array.isArray(facts.products_of_interest) ? facts.products_of_interest.slice(0, 4) : [],
      event_date: facts.event_date ?? null,
      destination_country: facts.destination_country ?? null,
      budget: facts.budget ?? null
    }
  };
}

export function compactStrategyForPrompt(value: unknown): Record<string, unknown> {
  const row = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return {
    recommended_action: String(row.recommended_action || ""),
    action_confidence: Number(row.action_confidence ?? 0),
    commercial_priority: String(row.commercial_priority || "medium"),
    tone: String(row.tone || ""),
    pressure_level: String(row.pressure_level || "none"),
    primary_goal: String(row.primary_goal || ""),
    secondary_goal: String(row.secondary_goal || "")
  };
}

export function compactReplyOptionsForPrompt(value: unknown): Record<string, unknown> {
  const row = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const options = Array.isArray(row.reply_options) ? row.reply_options : [];
  return {
    reply_options: options.slice(0, 3).map((option) => {
      const entry = option && typeof option === "object" ? (option as Record<string, unknown>) : {};
      const messages = Array.isArray(entry.messages) ? entry.messages.slice(0, 3).map((m) => String(m || "").slice(0, 180)) : [];
      return {
        label: String(entry.label || ""),
        intent: String(entry.intent || ""),
        messages
      };
    })
  };
}

export function enforceTokenBudget(input: {
  step: TokenBudgetStep;
  transcript: string;
  context: Record<string, unknown>;
}): { transcript: string; context: Record<string, unknown> } {
  const step = input.step;
  const originalTranscript = String(input.transcript || "").trim();
  const context = input.context || {};
  const originalPayload = JSON.stringify({
    transcript: originalTranscript,
    context
  });
  const limit = charsBudget(step);
  let transcript = originalTranscript;
  let nextContext = context;
  let payload = originalPayload;

  if (payload.length > limit) {
    transcript = trimTranscriptLines(transcript, 16);
    payload = JSON.stringify({ transcript, context: nextContext });
  }

  if (payload.length > limit) {
    transcript = trimTranscriptLines(transcript, 10);
    payload = JSON.stringify({ transcript, context: nextContext });
  }

  if (payload.length > limit) {
    transcript = roughSummarizeTranscript(transcript);
    payload = JSON.stringify({ transcript, context: nextContext });
  }

  if (payload.length > limit) {
    nextContext = { summary_only: true };
    payload = JSON.stringify({ transcript, context: nextContext });
  }

  console.info("[ai-token-budget] applied", {
    step,
    originalChars: originalPayload.length,
    finalChars: payload.length,
    charsBudget: limit
  });

  return {
    transcript,
    context: nextContext
  };
}

