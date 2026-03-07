import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  trackWhatsAppOperatorEvent,
  validateWhatsAppOperatorEventPayload,
  WhatsAppOperatorEventError
} from "./whatsappOperatorEventsService.js";
import type { WhatsAppOperatorEventInsert } from "../db/whatsappOperatorEventsRepo.js";

test("valid event creation", async () => {
  let saved: WhatsAppOperatorEventInsert | null = null;
  const result = await trackWhatsAppOperatorEvent(
    {
      leadId: "11111111-1111-1111-1111-111111111111",
      surface: "mobile_lab",
      feedType: "active",
      actionType: "reply_card_inserted",
      stage: "DEPOSIT_PENDING",
      recommendedAction: "push_softly_to_deposit",
      cardLabel: "Option 1",
      cardIntent: "clear next step",
      mode: "active_first",
      metadata: { source: "test" }
    },
    {
      insertEvent: async (payload) => {
        saved = payload;
        return "event-1";
      }
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.eventId, "event-1");
  if (!saved) throw new Error("expected saved payload");
  const savedAny = saved as any;
  assert.equal(savedAny.surface, "mobile_lab");
  assert.equal(savedAny.actionType, "reply_card_inserted");
});

test("invalid actionType rejected", () => {
  assert.throws(
    () =>
      validateWhatsAppOperatorEventPayload({
        leadId: "11111111-1111-1111-1111-111111111111",
        surface: "mobile_lab",
        actionType: "invalid_action_type"
      }),
    (error: unknown) => error instanceof WhatsAppOperatorEventError && error.code === "operator_event_invalid_payload"
  );
});

test("invalid surface rejected", () => {
  assert.throws(
    () =>
      validateWhatsAppOperatorEventPayload({
        leadId: "11111111-1111-1111-1111-111111111111",
        surface: "invalid_surface",
        actionType: "feed_item_opened"
      }),
    (error: unknown) => error instanceof WhatsAppOperatorEventError && error.code === "operator_event_invalid_payload"
  );
});

test("optional fields allowed", async () => {
  const result = await trackWhatsAppOperatorEvent(
    {
      leadId: "22222222-2222-2222-2222-222222222222",
      surface: "chat",
      actionType: "feed_item_opened"
    },
    {
      insertEvent: async () => "event-2"
    }
  );
  assert.equal(result.ok, true);
  assert.equal(result.eventId, "event-2");
});

test("metadata persisted", async () => {
  let savedMetadata: Record<string, unknown> | null = null;
  await trackWhatsAppOperatorEvent(
    {
      leadId: "33333333-3333-3333-3333-333333333333",
      surface: "priority_desk",
      actionType: "reply_card_dismissed",
      metadata: {
        reason: "operator_override",
        nested: { key: "value" }
      }
    },
    {
      insertEvent: async (payload) => {
        savedMetadata = payload.metadata ?? null;
        return "event-3";
      }
    }
  );
  assert.deepEqual(savedMetadata, {
    reason: "operator_override",
    nested: { key: "value" }
  });
});
