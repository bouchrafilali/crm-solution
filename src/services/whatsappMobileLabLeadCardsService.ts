import { buildAiCardsViewModel, type AiCardsViewModel } from "./whatsappAiCardsService.js";
import { buildLeadReactivationReplies } from "./whatsappReactivationReplyService.js";

type Card = {
  label: string;
  intent: string;
  messages: string[];
};

export type MobileLabLeadCardsResult = {
  leadId: string;
  replyCards: Card[];
  topReplyCard: Card | null;
  stageAnalysis: AiCardsViewModel["summary"] | null;
  summary: AiCardsViewModel["summary"] | null;
  strategy: AiCardsViewModel["strategy"] | null;
  enrichmentStatus: "enriched" | "timeout" | "error" | "no_generation_needed";
  enrichmentSource: "active_ai_cards" | "reactivation_replies";
  enrichmentError: string | null;
  status: "enriched" | "timeout" | "error" | "no_generation_needed";
  source: "active_ai_cards" | "reactivation_replies";
  error: string | null;
  provider: string | null;
  model: string | null;
  timestamp: string;
};

type MobileLabLeadCardsDeps = {
  getAiCards: (leadId: string) => Promise<AiCardsViewModel>;
  getReactivationReplies: (leadId: string) => ReturnType<typeof buildLeadReactivationReplies>;
  timeoutMs: () => number;
};

function parsePositiveInt(value: unknown): number | null {
  const num = Number(value);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num <= 0) return null;
  return num;
}

function resolveTimeoutMs(): number {
  const configured = parsePositiveInt(process.env.WHATSAPP_MOBILE_LAB_SELECTED_CARDS_TIMEOUT_MS);
  const fallback = 10000;
  const raw = configured == null ? fallback : configured;
  return Math.max(200, Math.min(30000, raw));
}

function defaultDeps(): MobileLabLeadCardsDeps {
  return {
    getAiCards: (leadId: string) => buildAiCardsViewModel(leadId),
    getReactivationReplies: (leadId: string) => buildLeadReactivationReplies(leadId),
    timeoutMs: () => resolveTimeoutMs()
  };
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    });
    return await Promise.race([work, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function toSafeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error || "cards_failed");
  return text.slice(0, 180);
}

export async function buildMobileLabLeadCards(
  leadId: string,
  input?: { feedType?: "active" | "reactivation" | null },
  depsOverride?: Partial<MobileLabLeadCardsDeps>
): Promise<MobileLabLeadCardsResult> {
  const safeLeadId = String(leadId || "").trim();
  const deps: MobileLabLeadCardsDeps = { ...defaultDeps(), ...(depsOverride || {}) };
  const timeoutMs = deps.timeoutMs();
  const feedType = input?.feedType === "reactivation" ? "reactivation" : "active";

  try {
    if (feedType === "reactivation") {
      const reactivation = await withTimeout(deps.getReactivationReplies(safeLeadId), timeoutMs);
      const replyCards = Array.isArray(reactivation.replyOptions)
        ? reactivation.replyOptions.map((option) => ({
            label: String(option.label || "").trim(),
            intent: String(option.intent || "").trim(),
            messages: Array.isArray(option.messages) ? option.messages.map((m) => String(m || "")).filter(Boolean) : []
          }))
        : [];
      const status = reactivation.shouldGenerate && replyCards.length ? "enriched" : "no_generation_needed";
      const source = "reactivation_replies" as const;
      return {
        leadId: safeLeadId,
        replyCards,
        topReplyCard: replyCards.length ? replyCards[0] : null,
        stageAnalysis: null,
        summary: null,
        strategy: null,
        enrichmentStatus: status,
        enrichmentSource: source,
        enrichmentError: null,
        status,
        source,
        error: null,
        provider: reactivation.provider || null,
        model: reactivation.model || null,
        timestamp: new Date().toISOString()
      };
    }

    const vm = await withTimeout(deps.getAiCards(safeLeadId), timeoutMs);
    const replyCards = Array.isArray(vm.replyCards) ? vm.replyCards : [];
    const status = replyCards.length ? "enriched" : "no_generation_needed";
    const source = "active_ai_cards" as const;
    return {
      leadId: safeLeadId,
      replyCards,
      topReplyCard: replyCards.length ? replyCards[0] : null,
      stageAnalysis: vm.summary || null,
      summary: vm.summary || null,
      strategy: vm.strategy || null,
      enrichmentStatus: status,
      enrichmentSource: source,
      enrichmentError: null,
      status,
      source,
      error: null,
      provider: vm.meta?.provider || null,
      model: vm.meta?.model || null,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    const isTimeout = error instanceof Error && error.message === "timeout";
    const status = isTimeout ? "timeout" : "error";
    const source = feedType === "reactivation" ? "reactivation_replies" : "active_ai_cards";
    const safeError = toSafeError(error);
    return {
      leadId: safeLeadId,
      replyCards: [],
      topReplyCard: null,
      stageAnalysis: null,
      summary: null,
      strategy: null,
      enrichmentStatus: status,
      enrichmentSource: source,
      enrichmentError: safeError,
      status,
      source,
      error: safeError,
      provider: null,
      model: null,
      timestamp: new Date().toISOString()
    };
  }
}
