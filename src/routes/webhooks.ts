import { Router } from "express";
import crypto from "node:crypto";
import { env } from "../config/env.js";
import { evaluateOrderActions } from "../services/orderProcessor.js";
import { addOrderSnapshot } from "../services/orderSnapshots.js";
import { addWebhookEvent } from "../services/webhookEvents.js";

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

webhooksRouter.post("/orders/create", (req, res) => {
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
  const orderId = req.body?.id ? String(req.body.id) : undefined;
  const totalPrice = req.body?.total_price ? String(req.body.total_price) : "unknown";

  addWebhookEvent({
    topic: "orders/create",
    orderId,
    summary: `Processed order total ${totalPrice} (VIP: ${actions.shouldMarkVip ? "yes" : "no"}, status: ${snapshot.financialStatus})`
  });

  // TODO: implement side effects here (tag customer, CRM sync, email workflow, etc).
  console.log("orders/create", {
    orderId,
    actions
  });

  return res.status(200).json({ processed: true, actions });
});
