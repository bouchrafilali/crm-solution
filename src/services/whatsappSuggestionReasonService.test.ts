import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  attachReasonShortToReplyOptions,
  buildSuggestionReasonShort
} from "./whatsappSuggestionReasonService.js";

test("payment signals produce deposit-oriented reason", () => {
  const reason = buildSuggestionReasonShort({
    language: "en",
    stage: "PRICE_SENT",
    paymentIntent: true,
    optionIntent: "Send deposit link"
  });
  assert.match(reason, /moves naturally toward reservation|toward reservation/i);
});

test("qualification-pending and price intent produce qualification reason", () => {
  const reason = buildSuggestionReasonShort({
    language: "en",
    stage: "QUALIFICATION_PENDING",
    priceIntent: true,
    optionIntent: "Share price now"
  });
  assert.match(reason, /qualifies the request before discussing price/i);
});

test("reactivation context produces momentum reason", () => {
  const reason = buildSuggestionReasonShort({
    language: "en",
    stage: "PRICE_SENT",
    reactivation: true,
    dropoffRisk: "high"
  });
  assert.match(reason, /losing momentum|restarts the exchange/i);
});

test("reason stays one sentence and concise", () => {
  const reason = buildSuggestionReasonShort({
    language: "en",
    stage: "QUALIFIED",
    optionText:
      "The client asked about timing and delivery. We should move now. This is a second sentence that should not survive."
  });
  assert.equal(reason.includes(". "), false);
  assert.ok(reason.length <= 180);
});

test("bulk attach adds reason_short for each option", () => {
  const options = attachReasonShortToReplyOptions(
    [
      { label: "Option 1", intent: "Clarify", messages: ["Can I confirm your event date?"] },
      { label: "Option 2", intent: "Deposit", messages: ["I can share the deposit link now."] }
    ],
    { stage: "PRICE_SENT", paymentIntent: true, language: "en" }
  );
  assert.equal(options.length, 2);
  assert.ok(String(options[0].reason_short || "").length > 10);
  assert.ok(String(options[1].reason_short || "").length > 10);
});
