import { z } from "zod";
import {
  getWhatsAppLeadOutcome,
  upsertWhatsAppLeadOutcome,
  type WhatsAppLeadOutcome,
  type WhatsAppLeadOutcomeRecord
} from "../db/whatsappLeadOutcomesRepo.js";

const leadOutcomeSchema = z.enum(["open", "converted", "lost", "stalled"]);

export const leadOutcomePayloadSchema = z
  .object({
    outcome: leadOutcomeSchema,
    finalStage: z.string().trim().min(1).max(100).nullable().optional(),
    outcomeAt: z.string().datetime(),
    orderValue: z.number().finite().nullable().optional(),
    currency: z.string().trim().min(1).max(10).nullable().optional(),
    source: z.string().trim().min(1).max(120).nullable().optional(),
    notes: z.string().trim().min(1).max(2000).nullable().optional()
  })
  .strict();

export type LeadOutcomePayload = z.infer<typeof leadOutcomePayloadSchema>;

export class WhatsAppLeadOutcomeError extends Error {
  code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message);
    this.code = code;
    if (options && "cause" in options) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

type LeadOutcomeDeps = {
  upsert: (input: {
    leadId: string;
    outcome: WhatsAppLeadOutcome;
    finalStage?: string | null;
    outcomeAt: string;
    orderValue?: number | null;
    currency?: string | null;
    source?: string | null;
    notes?: string | null;
  }) => Promise<WhatsAppLeadOutcomeRecord>;
  get: (leadId: string) => Promise<WhatsAppLeadOutcomeRecord | null>;
};

function defaultDeps(): LeadOutcomeDeps {
  return {
    upsert: (input) => upsertWhatsAppLeadOutcome(input),
    get: (leadId) => getWhatsAppLeadOutcome(leadId)
  };
}

export function validateLeadOutcomePayload(input: unknown): LeadOutcomePayload {
  const parsed = leadOutcomePayloadSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ");
    throw new WhatsAppLeadOutcomeError("lead_outcome_invalid_payload", issues || "Invalid lead outcome payload");
  }
  return parsed.data;
}

function normalizeOutcomeRecord(record: WhatsAppLeadOutcomeRecord) {
  return {
    leadId: record.leadId,
    outcome: record.outcome,
    finalStage: record.finalStage,
    outcomeAt: record.outcomeAt,
    orderValue: record.orderValue,
    currency: record.currency,
    source: record.source,
    notes: record.notes
  };
}

export async function saveLeadOutcome(
  leadId: string,
  payload: unknown,
  depsOverride?: Partial<LeadOutcomeDeps>
): Promise<{ ok: true; outcome: ReturnType<typeof normalizeOutcomeRecord> }> {
  const safeLeadId = String(leadId || "").trim();
  if (!safeLeadId) {
    throw new WhatsAppLeadOutcomeError("lead_outcome_invalid_lead_id", "Lead ID is required");
  }
  const deps: LeadOutcomeDeps = { ...defaultDeps(), ...(depsOverride || {}) };
  const validated = validateLeadOutcomePayload(payload);

  const normalizedOutcomeAt = new Date(validated.outcomeAt).toISOString();
  const row = await deps.upsert({
    leadId: safeLeadId,
    outcome: validated.outcome,
    finalStage: validated.finalStage ?? null,
    outcomeAt: normalizedOutcomeAt,
    orderValue: validated.orderValue ?? null,
    currency: validated.currency ?? null,
    source: validated.source ?? null,
    notes: validated.notes ?? null
  });

  return {
    ok: true,
    outcome: normalizeOutcomeRecord(row)
  };
}

export async function fetchLeadOutcome(
  leadId: string,
  depsOverride?: Partial<LeadOutcomeDeps>
): Promise<{ ok: true; outcome: ReturnType<typeof normalizeOutcomeRecord> | null }> {
  const safeLeadId = String(leadId || "").trim();
  if (!safeLeadId) {
    throw new WhatsAppLeadOutcomeError("lead_outcome_invalid_lead_id", "Lead ID is required");
  }
  const deps: LeadOutcomeDeps = { ...defaultDeps(), ...(depsOverride || {}) };
  const row = await deps.get(safeLeadId);
  return {
    ok: true,
    outcome: row ? normalizeOutcomeRecord(row) : null
  };
}
