import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  fetchLeadOutcome,
  saveLeadOutcome,
  validateLeadOutcomePayload,
  WhatsAppLeadOutcomeError
} from "./whatsappLeadOutcomesService.js";
import type { WhatsAppLeadOutcomeRecord } from "../db/whatsappLeadOutcomesRepo.js";

function createInMemoryDeps() {
  const store = new Map<string, WhatsAppLeadOutcomeRecord>();
  const now = "2026-03-08T00:00:00.000Z";

  return {
    upsert: async (input: {
      leadId: string;
      outcome: "open" | "converted" | "lost" | "stalled";
      finalStage?: string | null;
      outcomeAt: string;
      orderValue?: number | null;
      currency?: string | null;
      source?: string | null;
      notes?: string | null;
    }): Promise<WhatsAppLeadOutcomeRecord> => {
      const existing = store.get(input.leadId);
      const row: WhatsAppLeadOutcomeRecord = {
        leadId: input.leadId,
        outcome: input.outcome,
        finalStage: input.finalStage ?? null,
        outcomeAt: input.outcomeAt,
        orderValue: input.orderValue ?? null,
        currency: input.currency ?? null,
        source: input.source ?? null,
        notes: input.notes ?? null,
        createdAt: existing?.createdAt || now,
        updatedAt: now
      };
      store.set(input.leadId, row);
      return row;
    },
    get: async (leadId: string): Promise<WhatsAppLeadOutcomeRecord | null> => {
      return store.get(leadId) || null;
    }
  };
}

test("valid outcome creation", async () => {
  const deps = createInMemoryDeps();
  const result = await saveLeadOutcome(
    "11111111-1111-1111-1111-111111111111",
    {
      outcome: "converted",
      finalStage: "CONVERTED",
      outcomeAt: "2026-03-07T23:40:00Z",
      orderValue: 4800,
      currency: "EUR",
      source: "manual",
      notes: "Bank transfer confirmed after reactivation"
    },
    deps
  );

  assert.equal(result.ok, true);
  assert.equal(result.outcome.outcome, "converted");
  assert.equal(result.outcome.orderValue, 4800);
});

test("outcome update/upsert", async () => {
  const deps = createInMemoryDeps();
  const leadId = "22222222-2222-2222-2222-222222222222";

  await saveLeadOutcome(
    leadId,
    {
      outcome: "open",
      outcomeAt: "2026-03-07T10:00:00Z"
    },
    deps
  );

  const updated = await saveLeadOutcome(
    leadId,
    {
      outcome: "lost",
      finalStage: "LOST",
      outcomeAt: "2026-03-08T10:00:00Z",
      notes: "Client declined"
    },
    deps
  );

  assert.equal(updated.outcome.outcome, "lost");
  assert.equal(updated.outcome.finalStage, "LOST");
});

test("invalid outcome rejected", () => {
  assert.throws(
    () =>
      validateLeadOutcomePayload({
        outcome: "invalid",
        outcomeAt: "2026-03-07T10:00:00Z"
      }),
    (error: unknown) => error instanceof WhatsAppLeadOutcomeError && error.code === "lead_outcome_invalid_payload"
  );
});

test("invalid date rejected", () => {
  assert.throws(
    () =>
      validateLeadOutcomePayload({
        outcome: "open",
        outcomeAt: "not-a-date"
      }),
    (error: unknown) => error instanceof WhatsAppLeadOutcomeError && error.code === "lead_outcome_invalid_payload"
  );
});

test("outcome retrieval works", async () => {
  const deps = createInMemoryDeps();
  const leadId = "33333333-3333-3333-3333-333333333333";
  await saveLeadOutcome(
    leadId,
    {
      outcome: "stalled",
      outcomeAt: "2026-03-07T10:00:00Z",
      source: "manual"
    },
    deps
  );

  const result = await fetchLeadOutcome(leadId, deps);
  assert.equal(result.ok, true);
  assert.equal(result.outcome?.outcome, "stalled");
});

test("missing outcome returns null-safe response", async () => {
  const deps = createInMemoryDeps();
  const result = await fetchLeadOutcome("44444444-4444-4444-4444-444444444444", deps);
  assert.equal(result.ok, true);
  assert.equal(result.outcome, null);
});
