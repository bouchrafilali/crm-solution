import test from "node:test";
import assert from "node:assert/strict";
import {
  buildManualTransactionPayload,
  createManualOrderTransaction,
  manualGatewayCandidates,
  parseShopifyErrorMessage
} from "./shopifyOrderPayments.js";

test("manualGatewayCandidates prioritizes cash/manual gateways", () => {
  const gateways = manualGatewayCandidates("cash", "Espèces");
  assert.equal(gateways[0], "Cash");
  assert.ok(gateways.includes("manual"));
});

test("buildManualTransactionPayload matches REST transaction payload shape", () => {
  const payload = buildManualTransactionPayload(500, "manual", "MAD");
  assert.equal(payload.kind, "sale");
  assert.equal(payload.status, "success");
  assert.equal(payload.amount, "500.00");
  assert.equal(payload.gateway, "manual");
  assert.equal(payload.source_name, "external");
  assert.equal(payload.currency, "MAD");
});

test("parseShopifyErrorMessage flattens nested errors", () => {
  const message = parseShopifyErrorMessage(JSON.stringify({ errors: { kind: ["sale is not valid transaction"] } }));
  assert.match(message, /kind: sale is not valid transaction/);
});

test("createManualOrderTransaction posts exact REST payload and succeeds", async () => {
  let capturedUrl = "";
  let capturedBody: unknown = null;
  const mockFetch: typeof fetch = (async (url: string | URL | globalThis.Request, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedBody = init && init.body ? JSON.parse(String(init.body)) : null;
    return new Response(JSON.stringify({ transaction: { id: 42 } }), { status: 201 });
  }) as typeof fetch;

  const result = await createManualOrderTransaction({
    shop: "example.myshopify.com",
    token: "shpat_xxx",
    orderId: "123",
    amount: 500,
    currency: "MAD",
    methodCode: "cheque",
    methodLabel: "Chèque",
    fetchImpl: mockFetch,
    apiVersion: "2024-10"
  });

  assert.equal(result.ok, true);
  assert.match(capturedUrl, /\/admin\/api\/2024-10\/orders\/123\/transactions\.json$/);
  const tx = (capturedBody as { transaction?: Record<string, unknown> })?.transaction || {};
  assert.equal(tx.kind, "sale");
  assert.equal(tx.status, "success");
  assert.equal(tx.amount, "500.00");
  assert.equal(tx.gateway, "manual");
  assert.equal(tx.source_name, "external");
});

test("scenario total=1000 deposit=500 builds payment amount 500.00", () => {
  const payload = buildManualTransactionPayload(500, "manual", "MAD");
  assert.equal(payload.amount, "500.00");
  const total = 1000;
  const deposit = 500;
  const remaining = total - deposit;
  assert.equal(remaining, 500);
});

test("createManualOrderTransaction accepts GraphQL gid and uses REST numeric order id", async () => {
  let capturedUrl = "";
  const mockFetch: typeof fetch = (async (url: string | URL | globalThis.Request) => {
    capturedUrl = String(url);
    return new Response(JSON.stringify({ transaction: { id: 77, status: "success" } }), { status: 201 });
  }) as typeof fetch;

  const result = await createManualOrderTransaction({
    shop: "example.myshopify.com",
    token: "shpat_xxx",
    orderId: "gid://shopify/Order/987654321",
    amount: 500,
    currency: "MAD",
    methodCode: "cash",
    methodLabel: "Espèces",
    fetchImpl: mockFetch,
    apiVersion: "2024-10"
  });

  assert.equal(result.ok, true);
  assert.match(capturedUrl, /\/orders\/987654321\/transactions\.json$/);
});

test("when sale is invalid, fallback capture from authorization succeeds", async () => {
  let postCalls = 0;
  const mockFetch: typeof fetch = (async (url: string | URL | globalThis.Request, init?: RequestInit) => {
    const method = String(init?.method || "GET").toUpperCase();
    if (method === "GET") {
      return new Response(
        JSON.stringify({ transactions: [{ id: 321, kind: "authorization", status: "success" }] }),
        { status: 200 }
      );
    }
    postCalls += 1;
    const payload = init?.body ? JSON.parse(String(init.body)) : {};
    const kind = String(payload?.transaction?.kind || "");
    if (kind === "sale") {
      return new Response(JSON.stringify({ errors: { kind: ["sale is not valid transaction"] } }), { status: 422 });
    }
    if (kind === "capture") {
      return new Response(JSON.stringify({ transaction: { id: 654, status: "success" } }), { status: 201 });
    }
    return new Response(JSON.stringify({ errors: { base: ["unexpected"] } }), { status: 422 });
  }) as typeof fetch;

  const result = await createManualOrderTransaction({
    shop: "example.myshopify.com",
    token: "shpat_xxx",
    orderId: "555",
    amount: 500,
    currency: "MAD",
    methodCode: "cash",
    fetchImpl: mockFetch,
    apiVersion: "2024-10"
  });

  assert.equal(result.ok, true);
  assert.ok(postCalls >= 2);
});

test("when sale is invalid and no existing authorization, authorize then capture succeeds", async () => {
  const postedKinds: string[] = [];
  const mockFetch: typeof fetch = (async (_url: string | URL | globalThis.Request, init?: RequestInit) => {
    const method = String(init?.method || "GET").toUpperCase();
    if (method === "GET") {
      return new Response(JSON.stringify({ transactions: [] }), { status: 200 });
    }
    const payload = init?.body ? JSON.parse(String(init.body)) : {};
    const kind = String(payload?.transaction?.kind || "");
    postedKinds.push(kind);
    if (kind === "sale") {
      return new Response(JSON.stringify({ errors: { kind: ["sale is not a valid transaction"] } }), { status: 422 });
    }
    if (kind === "authorization") {
      return new Response(JSON.stringify({ transaction: { id: 444 } }), { status: 201 });
    }
    if (kind === "capture") {
      return new Response(JSON.stringify({ transaction: { id: 445, status: "success" } }), { status: 201 });
    }
    return new Response(JSON.stringify({ errors: { base: ["unexpected"] } }), { status: 422 });
  }) as typeof fetch;

  const result = await createManualOrderTransaction({
    shop: "example.myshopify.com",
    token: "shpat_xxx",
    orderId: "999",
    amount: 5,
    currency: "MAD",
    methodCode: "cash",
    methodLabel: "Espèces",
    fetchImpl: mockFetch,
    apiVersion: "2024-10"
  });

  assert.equal(result.ok, true);
  assert.ok(postedKinds.includes("authorization"));
  assert.ok(postedKinds.includes("capture"));
});
