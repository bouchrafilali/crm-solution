import {
  listWhatsAppOperatorEventsByRange,
  type WhatsAppOperatorActionType,
  type WhatsAppOperatorEventRow
} from "../db/whatsappOperatorEventsRepo.js";
import {
  listWhatsAppLeadOutcomesByRange,
  type WhatsAppLeadOutcomeRecord
} from "../db/whatsappLeadOutcomesRepo.js";

type EffectivenessInput = {
  from: string;
  to: string;
};

export type WhatsAppOperatorEffectivenessPayload = {
  conversionMetrics: {
    totalLeads: number;
    converted: number;
    lost: number;
    stalled: number;
    conversionRate: number;
  };
  cardPerformance: Array<{
    cardIntent: string;
    inserted: number;
    sent: number;
    conversionsAfterSend: number;
  }>;
  reactivationPerformance: {
    reactivationAttempts: number;
    recoveredLeads: number;
    recoveryRate: number;
  };
  stageConversion: Record<string, number>;
  meta: {
    from: string;
    to: string;
    generatedAt: string;
  };
};

export class WhatsAppOperatorEffectivenessError extends Error {
  code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message);
    this.code = code;
    if (options && "cause" in options) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

type EffectivenessDeps = {
  listEvents: (input: { from: string; to: string }) => Promise<WhatsAppOperatorEventRow[]>;
  listOutcomes: (input: { from: string; to: string }) => Promise<WhatsAppLeadOutcomeRecord[]>;
  nowIso: () => string;
};

function defaultDeps(): EffectivenessDeps {
  return {
    listEvents: (input) => listWhatsAppOperatorEventsByRange(input),
    listOutcomes: (input) => listWhatsAppLeadOutcomesByRange(input),
    nowIso: () => new Date().toISOString()
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseIsoDate(value: string, field: "from" | "to"): string {
  const normalized = String(value || "").trim();
  const ms = new Date(normalized).getTime();
  if (!normalized || !Number.isFinite(ms)) {
    throw new WhatsAppOperatorEffectivenessError("effectiveness_invalid_date", `${field} must be a valid ISO date`);
  }
  return new Date(ms).toISOString();
}

export function validateEffectivenessRange(input: Partial<EffectivenessInput>): { from: string; to: string } {
  const fromRaw = String(input.from || "").trim();
  const toRaw = String(input.to || "").trim();
  if (!fromRaw || !toRaw) {
    throw new WhatsAppOperatorEffectivenessError("effectiveness_missing_range", "from and to are required");
  }
  const from = parseIsoDate(fromRaw, "from");
  const to = parseIsoDate(toRaw, "to");
  if (new Date(from).getTime() > new Date(to).getTime()) {
    throw new WhatsAppOperatorEffectivenessError("effectiveness_invalid_range", "from must be before or equal to to");
  }
  return { from, to };
}

function isInsertedAction(actionType: WhatsAppOperatorActionType): boolean {
  return actionType === "reply_card_inserted" || actionType === "reactivation_card_inserted";
}

function isSentAction(actionType: WhatsAppOperatorActionType): boolean {
  return actionType === "reply_card_sent" || actionType === "reactivation_card_sent";
}

export async function buildWhatsAppOperatorEffectiveness(
  input: Partial<EffectivenessInput>,
  depsOverride?: Partial<EffectivenessDeps>
): Promise<WhatsAppOperatorEffectivenessPayload> {
  const deps: EffectivenessDeps = { ...defaultDeps(), ...(depsOverride || {}) };
  const range = validateEffectivenessRange(input);

  const [events, outcomes] = await Promise.all([
    deps.listEvents({ from: range.from, to: range.to }),
    deps.listOutcomes({ from: range.from, to: range.to })
  ]);

  const convertedOutcomesByLead = new Map<string, WhatsAppLeadOutcomeRecord>();
  for (const outcome of outcomes) {
    if (outcome.outcome !== "converted") continue;
    const current = convertedOutcomesByLead.get(outcome.leadId);
    if (!current || new Date(outcome.outcomeAt).getTime() > new Date(current.outcomeAt).getTime()) {
      convertedOutcomesByLead.set(outcome.leadId, outcome);
    }
  }

  const byIntent = new Map<string, { cardIntent: string; inserted: number; sent: number; convertedLeadIds: Set<string> }>();
  for (const event of events) {
    const intent = String(event.cardIntent || "").trim();
    if (!intent) continue;
    if (!isInsertedAction(event.actionType) && !isSentAction(event.actionType)) continue;

    const entry = byIntent.get(intent) || { cardIntent: intent, inserted: 0, sent: 0, convertedLeadIds: new Set<string>() };
    if (isInsertedAction(event.actionType)) entry.inserted += 1;
    if (isSentAction(event.actionType)) {
      entry.sent += 1;
      const converted = convertedOutcomesByLead.get(event.leadId);
      if (converted && new Date(converted.outcomeAt).getTime() > new Date(event.createdAt).getTime()) {
        entry.convertedLeadIds.add(event.leadId);
      }
    }
    byIntent.set(intent, entry);
  }

  const cardPerformance = Array.from(byIntent.values())
    .map((item) => ({
      cardIntent: item.cardIntent,
      inserted: item.inserted,
      sent: item.sent,
      conversionsAfterSend: item.convertedLeadIds.size
    }))
    .sort((a, b) => b.sent - a.sent || b.inserted - a.inserted || a.cardIntent.localeCompare(b.cardIntent));

  const reactivationSentEvents = events.filter((evt) => evt.actionType === "reactivation_card_sent");
  const recoveredLeadIds = new Set<string>();
  for (const event of reactivationSentEvents) {
    const converted = convertedOutcomesByLead.get(event.leadId);
    if (converted && new Date(converted.outcomeAt).getTime() > new Date(event.createdAt).getTime()) {
      recoveredLeadIds.add(event.leadId);
    }
  }

  const stageConversion: Record<string, number> = {};
  for (const outcome of outcomes) {
    const stage = String(outcome.finalStage || "").trim();
    if (!stage) continue;
    stageConversion[stage] = (stageConversion[stage] || 0) + 1;
  }

  const totalLeads = outcomes.length;
  const converted = outcomes.filter((item) => item.outcome === "converted").length;
  const lost = outcomes.filter((item) => item.outcome === "lost").length;
  const stalled = outcomes.filter((item) => item.outcome === "stalled").length;
  const conversionRate = totalLeads > 0 ? round2((converted / totalLeads) * 100) : 0;

  const reactivationAttempts = reactivationSentEvents.length;
  const recoveredLeads = recoveredLeadIds.size;
  const recoveryRate = reactivationAttempts > 0 ? round2((recoveredLeads / reactivationAttempts) * 100) : 0;

  return {
    conversionMetrics: {
      totalLeads,
      converted,
      lost,
      stalled,
      conversionRate
    },
    cardPerformance,
    reactivationPerformance: {
      reactivationAttempts,
      recoveredLeads,
      recoveryRate
    },
    stageConversion,
    meta: {
      from: range.from,
      to: range.to,
      generatedAt: deps.nowIso()
    }
  };
}
