import { Router } from "express";
import crypto from "node:crypto";
import { LATEST_API_VERSION } from "@shopify/shopify-api";
import { env } from "../config/env.js";
import { clearDeletedShopifyOrderLink } from "../db/appointmentsRepo.js";
import { deleteOrderById } from "../db/ordersRepo.js";
import { evaluateOrderActions } from "../services/orderProcessor.js";
import { addOrderSnapshot, removeOrderSnapshot } from "../services/orderSnapshots.js";
import { getShopifyAdminToken } from "../services/shopifyAdminAuth.js";
import { addWebhookEvent } from "../services/webhookEvents.js";
import { persistOrderPayload } from "../db/ordersRepo.js";
import {
  convertWhatsAppLeadFromShopifyOrder,
  matchWhatsAppLeadForConversion,
  updateWhatsAppLeadShopifySignals
} from "../db/whatsappLeadsRepo.js";

export const webhooksRouter = Router();

function isValidShopifyWebhook(rawBody: string, hmacHeader?: string): boolean {
  if (!hmacHeader) return false;
  const digest = crypto
    .createHmac("sha256", env.SHOPIFY_API_SECRET)
    .update(rawBody, "utf8")
    .digest("base64");

  if (digest.length !== hmacHeader.length) {
    return false;
  }

  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
}

function extractWebhookOrderId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const candidate = (body as { id?: unknown }).id;
  if (candidate === undefined || candidate === null) return null;
  const normalized = String(candidate).trim();
  return normalized || null;
}

function normalizePhone(raw: unknown): string {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  const digits = value.replace(/[^\d]/g, "");
  return digits ? `+${digits}` : value;
}

function readOrderPhone(body: any): string {
  const shippingPhone = normalizePhone(body?.shipping_address?.phone);
  if (shippingPhone) return shippingPhone;
  const billingPhone = normalizePhone(body?.billing_address?.phone);
  if (billingPhone) return billingPhone;
  const customerPhone = normalizePhone(body?.customer?.phone);
  if (customerPhone) return customerPhone;
  return normalizePhone(body?.phone);
}

function readOrderClientName(body: any): string {
  const shippingName = String(body?.shipping_address?.name || "").trim();
  if (shippingName) return shippingName;
  const billingName = String(body?.billing_address?.name || "").trim();
  if (billingName) return billingName;
  const first = String(body?.customer?.first_name || "").trim();
  const last = String(body?.customer?.last_name || "").trim();
  return `${first} ${last}`.trim();
}

function readOrderCountry(body: any): string {
  const shippingCountry = String(body?.shipping_address?.country_code || body?.shipping_address?.country || "").trim();
  if (shippingCountry) return shippingCountry.toUpperCase();
  const billingCountry = String(body?.billing_address?.country_code || body?.billing_address?.country || "").trim();
  if (billingCountry) return billingCountry.toUpperCase();
  return String(body?.customer?.default_address?.country_code || body?.customer?.default_address?.country || "").trim().toUpperCase();
}

function readOrderTotal(body: any): number | null {
  const raw = body?.total_price;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function isPaidFinancialStatus(body: any): boolean {
  const status = String(body?.financial_status || "").trim().toLowerCase();
  return status === "paid" || status === "partially_paid";
}

export async function registerOrdersDeleteWebhook(): Promise<void> {
  const shop = String(env.SHOPIFY_SHOP || "").trim();
  if (!shop) {
    console.warn("[webhooks] SHOPIFY_SHOP not set, skipping orders/delete webhook registration.");
    return;
  }

  const address = `${String(env.SHOPIFY_APP_URL).replace(/\/+$/, "")}/webhooks/orders/delete`;
  const apiVersion = String(LATEST_API_VERSION);
  const token = await getShopifyAdminToken(shop);
  const headers = {
    "Content-Type": "application/json",
    "X-Shopify-Access-Token": token
  };

  const listRes = await fetch(
    `https://${shop}/admin/api/${apiVersion}/webhooks.json?topic=orders/delete`,
    { headers }
  );
  const listRaw = await listRes.text();
  let existing:
    | { webhooks?: Array<{ id?: number; address?: string; topic?: string }> }
    | null = null;
  try {
    existing = JSON.parse(listRaw) as { webhooks?: Array<{ id?: number; address?: string; topic?: string }> };
  } catch {
    existing = null;
  }
  if (!listRes.ok) {
    throw new Error(`[webhooks] list failed (${listRes.status}): ${listRaw.slice(0, 300)}`);
  }

  const alreadyExists = Array.isArray(existing?.webhooks)
    && existing!.webhooks!.some((hook) => String(hook?.address || "").trim() === address && String(hook?.topic || "").trim() === "orders/delete");
  if (alreadyExists) {
    console.log(`[webhooks] orders/delete already registered at ${address}`);
    return;
  }

  const createRes = await fetch(`https://${shop}/admin/api/${apiVersion}/webhooks.json`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      webhook: {
        topic: "orders/delete",
        address,
        format: "json"
      }
    })
  });
  const createRaw = await createRes.text();
  if (!createRes.ok) {
    throw new Error(`[webhooks] create orders/delete failed (${createRes.status}): ${createRaw.slice(0, 300)}`);
  }
  console.log(`[webhooks] orders/delete registered -> ${address}`);
}

webhooksRouter.post("/orders/create", async (req, res) => {
  const rawBody = JSON.stringify(req.body);
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256");

  if (!isValidShopifyWebhook(rawBody, hmacHeader)) {
    addWebhookEvent({
      topic: "orders/create",
      orderId: req.body?.id ? String(req.body.id) : undefined,
      summary: "Rejected: invalid webhook signature"
    });
    return res.status(401).json({ error: "Invalid webhook signature" });
  }

  const actions = evaluateOrderActions(req.body);
  const snapshot = addOrderSnapshot(req.body);
  try {
    await persistOrderPayload(req.body);
  } catch (error) {
    console.error("Failed to persist webhook order", error);
  }
  const orderId = req.body?.id ? String(req.body.id) : undefined;
  const totalPrice = req.body?.total_price ? String(req.body.total_price) : "unknown";

  addWebhookEvent({
    topic: "orders/create",
    orderId,
    summary: `Processed order total ${totalPrice} (VIP: ${actions.shouldMarkVip ? "yes" : "no"}, status: ${snapshot.financialStatus})`
  });

  try {
    const phoneNumber = readOrderPhone(req.body);
    const clientName = readOrderClientName(req.body);
    const country = readOrderCountry(req.body);
    const match = await matchWhatsAppLeadForConversion({
      phoneNumber,
      clientName,
      country
    });

    const paid = isPaidFinancialStatus(req.body);
    if (!match) {
      addWebhookEvent({
        topic: "orders/create",
        orderId,
        summary: "WhatsApp conversion skipped: no matching lead found"
      });
    } else {
      const conversionStatus = paid
        ? await convertWhatsAppLeadFromShopifyOrder({
            leadId: match.id,
            orderId: orderId || null,
            orderName: req.body?.name ? String(req.body.name) : null,
            orderTotal: readOrderTotal(req.body),
            shop: String(req.get("X-Shopify-Shop-Domain") || "").trim() || null,
            payload: {
              id: req.body?.id ?? null,
              name: req.body?.name ?? null,
              total_price: req.body?.total_price ?? null,
              phone: phoneNumber || null,
              client_name: clientName || null,
              country: country || null
            }
          })
        : "not_found";
      if (!paid) {
        await updateWhatsAppLeadShopifySignals({
          leadId: match.id,
          orderId: orderId || null,
          financialStatus: String(req.body?.financial_status || ""),
          orderTotal: readOrderTotal(req.body)
        });
      }
      addWebhookEvent({
        topic: "orders/create",
        orderId,
        summary:
          conversionStatus === "converted"
            ? `WhatsApp lead converted from Shopify webhook (${match.id})`
            : conversionStatus === "already_converted"
              ? `WhatsApp lead already converted (${match.id})`
              : paid
                ? `WhatsApp conversion skipped (lead not found on update)`
                : `WhatsApp lead linked to Shopify order (${match.id}) awaiting payment`
      });
    }
  } catch (error) {
    console.error("[webhooks] orders/create whatsapp conversion failed", error);
    addWebhookEvent({
      topic: "orders/create",
      orderId,
      summary: "WhatsApp conversion error during webhook processing"
    });
  }

  // TODO: implement side effects here (tag customer, CRM sync, email workflow, etc).
  console.log("orders/create", {
    orderId,
    actions
  });

  return res.status(200).json({ processed: true, actions });
});

webhooksRouter.post("/orders/updated", async (req, res) => {
  const rawBody = JSON.stringify(req.body);
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
  if (!isValidShopifyWebhook(rawBody, hmacHeader)) {
    return res.status(401).json({ error: "Invalid webhook signature" });
  }
  try {
    const phoneNumber = readOrderPhone(req.body);
    const clientName = readOrderClientName(req.body);
    const country = readOrderCountry(req.body);
    const match = await matchWhatsAppLeadForConversion({ phoneNumber, clientName, country });
    if (!match) return res.status(200).json({ processed: true, linked: false });
    await updateWhatsAppLeadShopifySignals({
      leadId: match.id,
      orderId: req.body?.id ? String(req.body.id) : null,
      financialStatus: String(req.body?.financial_status || ""),
      paymentReceived: isPaidFinancialStatus(req.body),
      depositPaid: isPaidFinancialStatus(req.body),
      orderTotal: readOrderTotal(req.body)
    });
    return res.status(200).json({ processed: true, linked: true });
  } catch (error) {
    console.error("[webhooks] orders/updated whatsapp linkage failed", error);
    return res.status(503).json({ error: "orders_updated_processing_failed" });
  }
});

webhooksRouter.post("/orders/delete", (req, res) => {
  const rawBody = JSON.stringify(req.body);
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
  const shop = String(req.get("X-Shopify-Shop-Domain") || "").trim() || undefined;
  const orderId = extractWebhookOrderId(req.body);

  if (!isValidShopifyWebhook(rawBody, hmacHeader)) {
    addWebhookEvent({
      topic: "orders/delete",
      orderId: orderId || undefined,
      summary: `Rejected: invalid webhook signature${shop ? ` (shop: ${shop})` : ""}`
    });
    return res.status(401).json({ error: "Invalid webhook signature" });
  }

  // Ack quickly to satisfy Shopify delivery constraints.
  res.status(200).json({ processed: true });

  void (async () => {
    try {
      if (!orderId) {
        addWebhookEvent({
          topic: "orders/delete",
          summary: `Ignored: missing order id in payload${shop ? ` (shop: ${shop})` : ""}`
        });
        console.warn("[webhooks] orders/delete ignored (missing order id).");
        return;
      }

      const deletedInDb = await deleteOrderById(orderId);
      const removedFromSnapshot = removeOrderSnapshot(orderId);
      const updatedAppointments = await clearDeletedShopifyOrderLink(orderId);
      addWebhookEvent({
        topic: "orders/delete",
        orderId,
        summary:
          `Processed deletion. DB removed=${deletedInDb}, memory removed=${removedFromSnapshot ? 1 : 0}, updated appointments=${updatedAppointments}.` +
          `${shop ? ` Shop: ${shop}.` : ""}`
      });
      console.log("[webhooks] orders/delete", {
        shop,
        orderId,
        deletedInDb,
        removedFromSnapshot,
        updatedAppointments
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      addWebhookEvent({
        topic: "orders/delete",
        orderId: orderId || undefined,
        summary: `Processing error: ${message}${shop ? ` (shop: ${shop})` : ""}`
      });
      console.error("[webhooks] orders/delete processing failed", { shop, orderId, error });
    }
  })();
});
