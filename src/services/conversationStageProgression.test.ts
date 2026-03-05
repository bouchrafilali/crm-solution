import test from "node:test";
import assert from "node:assert/strict";
import {
  applyStageProgression,
  detectConversationEvents,
  detectSignalsFromMessages,
  type ConversationSignalMessage
} from "./conversationStageProgression.js";
import { extractEventDateFromMessages } from "./eventDateExtractor.js";

const leadBase: any = {
  id: "lead-1",
  clientName: "Mehdi",
  phoneNumber: "+212661143413",
  country: "MA",
  inquirySource: "Zoko",
  productReference: "Kaftan",
  priceSent: false,
  productionTimeSent: false,
  stage: "QUALIFIED",
  firstResponseTimeMinutes: null,
  lastActivityAt: new Date().toISOString(),
  internalNotes: null,
  qualificationTags: [],
  intentLevel: null,
  stageConfidence: null,
  stageAuto: false,
  stageAutoReason: null,
  stageAutoSourceMessageId: null,
  stageAutoConfidence: null,
  recommendedStage: null,
  recommendedStageReason: null,
  recommendedStageConfidence: null,
  detectedSignals: { tags: [], rules_triggered: [], evidence: [] },
  conversionValue: null,
  convertedAt: null,
  conversionSource: null,
  shopifyOrderId: null,
  paymentReceived: false,
  depositPaid: false,
  marketingOptIn: false,
  marketingOptInSource: null,
  marketingOptInAt: null,
  eventDate: null,
  eventDateText: null,
  eventDateConfidence: null,
  eventDateSourceMessageId: null,
  eventDateUpdatedAt: null,
  eventDateManual: false,
  shipCity: null,
  shipRegion: null,
  shipCountry: null,
  shipDestinationText: null,
  shipDestinationConfidence: null,
  shipDestinationSourceMessageId: null,
  shipDestinationUpdatedAt: null,
  shipDestinationManual: false,
  hasProductInterest: false,
  hasPriceSent: false,
  hasVideoProposed: false,
  hasPaymentQuestion: false,
  hasDepositLinkSent: false,
  chatConfirmed: false,
  priceIntent: false,
  videoIntent: false,
  paymentIntent: false,
  depositIntent: false,
  confirmationIntent: false,
  lastSignalAt: null,
  productInterestSourceMessageId: null,
  priceSentSourceMessageId: null,
  videoProposedSourceMessageId: null,
  paymentQuestionSourceMessageId: null,
  depositLinkSourceMessageId: null,
  chatConfirmedSourceMessageId: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};

test("detectConversationEvents detects PRODUCT_INTEREST / PRICE_SENT / VIDEO_PROPOSED / PAYMENT_QUESTION / DEPOSIT_LINK_SENT / CHAT_CONFIRMED", () => {
  const messages: ConversationSignalMessage[] = [
    { id: "m0", direction: "IN", text: "https://atelier.com/products/caftan-noir", createdAt: "2026-02-26T09:59:00Z" },
    { id: "m1", direction: "OUT", text: "Le prix est de 48 000 DHS", createdAt: "2026-02-26T10:00:00Z" },
    { id: "m2", direction: "OUT", text: "On peut faire une visio privée demain ?", createdAt: "2026-02-26T10:00:30Z" },
    { id: "m3", direction: "IN", text: "Comment je pourrais payer ?", createdAt: "2026-02-26T10:01:00Z" },
    { id: "m4", direction: "OUT", text: "Prochaine étape d'acompte: https://pay.link/x", createdAt: "2026-02-26T10:02:00Z" },
    { id: "m5", direction: "IN", text: "C'est confirmé.", createdAt: "2026-02-26T10:03:00Z" }
  ];

  const events = detectConversationEvents(messages, leadBase);
  const types = events.map((e) => e.type);
  assert.ok(types.includes("PRODUCT_INTEREST"));
  assert.ok(types.includes("PRICE_SENT"));
  assert.ok(types.includes("VIDEO_PROPOSED"));
  assert.ok(types.includes("PAYMENT_QUESTION"));
  assert.ok(types.includes("DEPOSIT_LINK_SENT"));
  assert.ok(types.includes("CHAT_CONFIRMED"));
});

test("applyStageProgression is monotonic and reaches DEPOSIT_PENDING on payment/deposit signals", () => {
  const events = detectConversationEvents(
    [
      { id: "m1", direction: "OUT", text: "Le prix est de 48 000 DHS", createdAt: "2026-02-26T10:00:00Z" },
      { id: "m2", direction: "OUT", text: "On peut faire une visio", createdAt: "2026-02-26T10:00:30Z" },
      { id: "m3", direction: "IN", text: "Comment je pourrais payer ?", createdAt: "2026-02-26T10:01:00Z" },
      { id: "m4", direction: "OUT", text: "Prochaine étape d'acompte: https://pay.link/x", createdAt: "2026-02-26T10:02:00Z" },
      { id: "m5", direction: "IN", text: "C'est confirmé.", createdAt: "2026-02-26T10:03:00Z" }
    ],
    leadBase
  );

  const fromQualified = applyStageProgression({ ...leadBase, stage: "QUALIFIED" }, events);
  assert.equal(fromQualified.nextStage, "DEPOSIT_PENDING");
  assert.equal(fromQualified.changed, true);
  assert.equal(fromQualified.signals.price_sent, true);
  assert.equal(fromQualified.signals.video_proposed, true);
  assert.equal(fromQualified.signals.deposit_pending, true);
  assert.equal(fromQualified.signals.chat_confirmed, true);

  const fromDepositPending = applyStageProgression({ ...leadBase, stage: "DEPOSIT_PENDING" }, events);
  assert.equal(fromDepositPending.nextStage, "DEPOSIT_PENDING");
  assert.equal(fromDepositPending.changed, false);
});

test("video-only progression keeps stage at QUALIFIED and only sets video flag", () => {
  const events = detectConversationEvents(
    [{ id: "m1", direction: "OUT", text: "On peut faire une visio", createdAt: "2026-02-26T10:00:00Z" }],
    leadBase
  );
  const result = applyStageProgression({ ...leadBase, stage: "QUALIFIED" }, events);
  assert.equal(result.nextStage, "QUALIFIED");
  assert.equal(result.signals.video_proposed, true);
});

test("chat-only confirmation does not promote PRICE_SENT to CONFIRMED without payment signal", () => {
  const events = detectConversationEvents(
    [{ id: "m1", direction: "IN", text: "I confirm", createdAt: "2026-02-26T10:00:00Z" }],
    leadBase
  );
  const result = applyStageProgression({ ...leadBase, stage: "PRICE_SENT" }, events);
  assert.equal(result.nextStage, "PRICE_SENT");
  assert.notEqual(result.nextStage, "CONVERTED");
});

test("hard conversion signal sets CONVERTED", () => {
  const events = detectConversationEvents([], leadBase);
  const result = applyStageProgression(
    { ...leadBase, stage: "DEPOSIT_PENDING" },
    events,
    { hasPaidShopifyOrder: true }
  );
  assert.equal(result.nextStage, "CONVERTED");
});

test("requested flow reaches PRICE_SENT and sets product/price/video chips", () => {
  const lead = {
    ...leadBase,
    stage: "NEW",
    eventDate: "2026-08-06",
    shipCity: "Paris",
    shipCountry: "FR"
  };
  const events = detectConversationEvents(
    [
      { id: "m1", direction: "IN", text: "https://atelier.com/products/caftan-royal", createdAt: "2026-02-26T10:00:00Z" },
      { id: "m2", direction: "OUT", text: "Quelle date souhaitez-vous ?", createdAt: "2026-02-26T10:01:00Z" },
      { id: "m3", direction: "IN", text: "6 août, à paris", createdAt: "2026-02-26T10:02:00Z" },
      { id: "m4", direction: "OUT", text: "Prix 40000 dhs, on peut faire une visio", createdAt: "2026-02-26T10:03:00Z" },
      { id: "m5", direction: "IN", text: "Intéressé, oui", createdAt: "2026-02-26T10:04:00Z" }
    ],
    lead
  );
  const result = applyStageProgression(lead, events);
  assert.equal(result.signals.product_interest, true);
  assert.equal(result.signals.price_sent, true);
  assert.equal(result.signals.video_proposed, true);
  assert.equal(result.nextStage, "PRICE_SENT");
});

test("product-intent text without url triggers product interest signal", () => {
  const events = detectConversationEvents(
    [{ id: "m1", direction: "IN", text: "Hi, I am interested in this article Kaftan Jade", createdAt: "2026-02-26T10:00:00Z" }],
    leadBase
  );
  const types = events.map((event) => event.type);
  assert.ok(types.includes("PRODUCT_INTEREST"));
});

test("price_intent is detected but does not move stage to PRICE_SENT", () => {
  const lead = {
    ...leadBase,
    stage: "QUALIFIED",
    eventDate: "2026-08-29"
  };
  const messages: ConversationSignalMessage[] = [
    { id: "m1", direction: "IN", text: "How much is this?", createdAt: "2026-02-26T10:00:00Z" }
  ];
  const signalDetection = detectSignalsFromMessages(messages, lead);
  const leadForProgression = {
    ...lead,
    priceIntent: signalDetection.priceIntent
  };
  const result = applyStageProgression(leadForProgression, detectConversationEvents(messages, leadForProgression));
  assert.equal(signalDetection.priceIntent, true);
  assert.equal(result.signals.price_intent, true);
  assert.equal(result.nextStage, "QUALIFIED");
});

test("payment_intent moves stage from QUALIFIED to DEPOSIT_PENDING", () => {
  const lead = {
    ...leadBase,
    stage: "QUALIFIED",
    eventDate: "2026-08-29",
    paymentIntent: true
  };
  const result = applyStageProgression(lead, []);
  assert.equal(result.nextStage, "DEPOSIT_PENDING");
});

test("partially paid shopify status promotes to CONFIRMED (not CONVERTED)", () => {
  const lead = {
    ...leadBase,
    stage: "DEPOSIT_PENDING",
    shopifyFinancialStatus: "partially_paid"
  };
  const result = applyStageProgression(lead, [], { shopifyFinancialStatus: "partially_paid" });
  assert.equal(result.nextStage, "CONFIRMED");
});

test("event in April => MONTH precision and stage QUALIFIED when destination present", () => {
  const extraction = extractEventDateFromMessages(
    [{ id: "in-1", text: "I have a big event in April", createdAt: "2026-02-26T10:00:00Z" }],
    new Date("2026-02-20T00:00:00Z"),
    "UTC"
  );
  assert.equal(extraction.eventDatePrecision, "MONTH");
  assert.equal(extraction.eventMonth, 4);

  const lead = {
    ...leadBase,
    stage: "NEW",
    eventDate: null,
    eventDateText: "April",
    shipCountry: "US"
  };
  const result = applyStageProgression(lead, []);
  assert.equal(result.nextStage, "QUALIFIED");
});

test("event on 22 April => DAY precision and stage QUALIFIED when destination present", () => {
  const extraction = extractEventDateFromMessages(
    [{ id: "in-1", text: "Event on 22 April", createdAt: "2026-02-26T10:00:00Z" }],
    new Date("2026-02-20T00:00:00Z"),
    "UTC"
  );
  assert.equal(extraction.eventDatePrecision, "DAY");
  assert.ok(String(extraction.date || "").endsWith("-04-22"));

  const lead = {
    ...leadBase,
    stage: "NEW",
    eventDate: extraction.date,
    eventDateText: extraction.raw,
    shipCountry: "US"
  };
  const result = applyStageProgression(lead, []);
  assert.equal(result.nextStage, "QUALIFIED");
});
