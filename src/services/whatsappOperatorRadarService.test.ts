import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildOperatorRadar } from "./whatsappOperatorRadarService.js";

test("groups leads into operator radar categories", async () => {
  const payload = await buildOperatorRadar(
    { limit: 20 },
    {
      nowMs: () => new Date("2026-03-09T12:00:00.000Z").getTime(),
      listRows: async () => [
        {
          leadId: "11111111-1111-4111-8111-111111111111",
          clientName: "Hot",
          phoneNumber: "+212600000001",
          stage: "DEPOSIT_PENDING",
          facts: {},
          lastInboundAt: "2026-03-09T10:00:00.000Z",
          lastOutboundAt: "2026-03-09T09:00:00.000Z",
          eventDate: "2026-03-15",
          paymentIntent: true,
          awaitingReply: true,
          ticketValueEstimate: 2200,
          conversionProbability: 0.81,
          dropoffRisk: 0.22,
          priorityScore: 92,
          priorityBand: "critical",
          recommendedAttention: "reply_now",
          reasonCodes: ["awaiting_reply"],
          primaryReasonCode: "awaiting_reply",
          inputSignature: "sig-hot",
          computedAt: "2026-03-09T10:05:00.000Z",
          updatedAt: "2026-03-09T10:05:00.000Z"
        },
        {
          leadId: "22222222-2222-4222-8222-222222222222",
          clientName: "Risk",
          phoneNumber: "+212600000002",
          stage: "PRICE_SENT",
          facts: {},
          lastInboundAt: "2026-03-06T08:00:00.000Z",
          lastOutboundAt: "2026-03-06T08:10:00.000Z",
          eventDate: null,
          paymentIntent: false,
          awaitingReply: false,
          ticketValueEstimate: 800,
          conversionProbability: 0.39,
          dropoffRisk: 0.71,
          priorityScore: 74,
          priorityBand: "high",
          recommendedAttention: "reactivate_now",
          reasonCodes: ["price_sent_then_silence"],
          primaryReasonCode: "price_sent_then_silence",
          inputSignature: "sig-risk",
          computedAt: "2026-03-09T09:00:00.000Z",
          updatedAt: "2026-03-09T09:00:00.000Z"
        },
        {
          leadId: "33333333-3333-4333-8333-333333333333",
          clientName: "Closed",
          phoneNumber: "+212600000003",
          stage: "CONVERTED",
          facts: {},
          lastInboundAt: "2026-03-04T10:00:00.000Z",
          lastOutboundAt: "2026-03-04T12:00:00.000Z",
          eventDate: null,
          paymentIntent: false,
          awaitingReply: false,
          ticketValueEstimate: 3000,
          conversionProbability: 1,
          dropoffRisk: 0,
          priorityScore: 100,
          priorityBand: "critical",
          recommendedAttention: "close_out",
          reasonCodes: ["stage_closed"],
          primaryReasonCode: "stage_closed",
          inputSignature: "sig-closed",
          computedAt: "2026-03-09T08:00:00.000Z",
          updatedAt: "2026-03-09T08:00:00.000Z"
        }
      ]
    }
  );

  assert.equal(payload.hotOpportunities.length, 2);
  assert.equal(payload.atRisk.length, 1);
  assert.equal(payload.atRisk[0].leadId, "22222222-2222-4222-8222-222222222222");
  assert.equal(payload.waitingReply.length, 1);
  assert.equal(payload.waitingReply[0].leadId, "11111111-1111-4111-8111-111111111111");
  assert.equal(payload.highValue.length, 2);
  assert.equal(payload.reactivation.length, 1);
  assert.equal(payload.reactivation[0].leadId, "22222222-2222-4222-8222-222222222222");
});

test("reactivation excludes closed stages", async () => {
  const payload = await buildOperatorRadar(
    {},
    {
      nowMs: () => new Date("2026-03-09T12:00:00.000Z").getTime(),
      listRows: async () => [
        {
          leadId: "44444444-4444-4444-8444-444444444444",
          clientName: "Lost",
          phoneNumber: null,
          stage: "LOST",
          facts: {},
          lastInboundAt: "2026-03-01T00:00:00.000Z",
          lastOutboundAt: "2026-03-01T01:00:00.000Z",
          eventDate: null,
          paymentIntent: false,
          awaitingReply: false,
          ticketValueEstimate: 500,
          conversionProbability: 0,
          dropoffRisk: 0,
          priorityScore: 5,
          priorityBand: "low",
          recommendedAttention: "close_out",
          reasonCodes: [],
          primaryReasonCode: null,
          inputSignature: "sig-lost",
          computedAt: "2026-03-01T02:00:00.000Z",
          updatedAt: "2026-03-01T02:00:00.000Z"
        }
      ]
    }
  );

  assert.equal(payload.reactivation.length, 0);
});
