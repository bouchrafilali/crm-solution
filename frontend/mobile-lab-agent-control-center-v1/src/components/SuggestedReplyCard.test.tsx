import { strict as assert } from "node:assert";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SuggestedReplyCard } from "./SuggestedReplyCard.js";

const baseReply = {
  id: "r1",
  leadId: "l1",
  label: "Option 1",
  intent: "Qualify",
  tone: "refined",
  language: "FR",
  content: "Pouvez-vous confirmer la date de votre événement ?"
};

test("renders reason_short when provided", () => {
  const html = renderToStaticMarkup(
    <SuggestedReplyCard
      reply={{
        ...baseReply,
        reason_short: "More context is still needed, so this option qualifies the request before discussing price."
      }}
      selected={false}
      onSelect={() => {}}
    />
  );
  assert.match(html, />Why</);
  assert.match(html, /qualifies the request before discussing price/i);
});

test("hides reason area when reason_short is absent", () => {
  const html = renderToStaticMarkup(
    <SuggestedReplyCard reply={baseReply} selected={false} onSelect={() => {}} />
  );
  assert.equal(html.includes(">Why<"), false);
});

test("core card content still renders without regression", () => {
  const html = renderToStaticMarkup(
    <SuggestedReplyCard reply={baseReply} selected={true} onSelect={() => {}} confidence={92} />
  );
  assert.match(html, /Option 1/);
  assert.match(html, /Pouvez-vous confirmer la date de votre événement/);
  assert.match(html, /Confidence/);
});
