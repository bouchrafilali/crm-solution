import { Router } from "express";
import { createHmac } from "node:crypto";
import { env } from "../config/env.js";
import { getDbPool } from "../db/client.js";
import {
  createWhatsAppLead,
  getWhatsAppLeadById,
  getWhatsAppLeadByPhone,
  listRecentInboundMessagesForLead,
  listRecentWhatsAppLeadMessages,
  touchWhatsAppLeadFromInbound,
  updateWhatsAppLeadFlags,
  updateWhatsAppLeadSignalFlags,
  updateWhatsAppLeadStage
} from "../db/whatsappLeadsRepo.js";
import { createWhatsAppLeadMessageWithTracking } from "../services/mlMessageTracking.js";
import { inferIsoCountryFromPhone, normalizePhoneE164 } from "../services/phoneCountry.js";
import { inferProductReference } from "../services/productReference.js";
import { applyInboundSignalExtraction } from "../services/whatsappLeadSignals.js";
import { applyStageProgression, detectConversationEvents, detectSignalsFromMessages } from "../services/conversationStageProgression.js";
import {
  applyTeamPriceOverrideFromMessage,
  applyTeamDecision,
  createQuoteRequestsFromInbound,
  parseTeamDecisionWebhookPayload
} from "../services/quoteRequestService.js";
import { triggerWhatsAppAgentOrchestratorForInbound } from "../services/whatsappAgentOrchestratorService.js";

export const zokoWebhookRouter = Router();
const ANALYSIS_TRIGGER_TTL_MS = 5 * 60 * 1000;
const analysisTriggerByExternalId = new Map<string, number>();

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function firstString(values: unknown[]): string {
  for (const value of values) {
    const s = String(value ?? "").trim();
    if (s) return s;
  }
  return "";
}

function parseTimestamp(input: unknown): string {
  if (!input) return new Date().toISOString();
  if (typeof input === "number") {
    const asMs = input > 10_000_000_000 ? input : input * 1000;
    const d = new Date(asMs);
    return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }
  const d = new Date(String(input));
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function normalizePhone(raw: string): string {
  return normalizePhoneE164(raw);
}

function parseDirectionValue(input: unknown): "IN" | "OUT" {
  const raw = String(input || "").trim().toUpperCase();
  if (!raw) return "IN";
  if (["OUT", "OUTBOUND", "OUTGOING", "SENT", "AGENT", "BUSINESS"].includes(raw)) return "OUT";
  if (["IN", "INBOUND", "RECEIVED", "CUSTOMER"].includes(raw)) return "IN";
  if (raw.includes("OUT") || raw.includes("SENT") || raw.includes("AGENT") || raw.includes("BUSINESS")) return "OUT";
  if (raw.includes("IN") || raw.includes("RECEIVED") || raw.includes("CUSTOMER")) return "IN";
  return "IN";
}

function parseDirectionFromPayload(parts: {
  body: Record<string, unknown>;
  message: Record<string, unknown>;
  data: Record<string, unknown>;
  payload: Record<string, unknown>;
  event: Record<string, unknown>;
}): "IN" | "OUT" {
  const raw = firstString([
    parts.body.direction,
    parts.message.direction,
    parts.data.direction,
    parts.payload.direction,
    parts.body.chatType,
    parts.message.chatType,
    parts.data.chatType,
    parts.payload.chatType,
    parts.body.type,
    parts.message.type,
    parts.body.event,
    parts.data.event,
    parts.payload.event,
    parts.event.type,
    parts.event.name,
    parts.body.deliveryStatus
  ]);
  const booleansOut = [
    parts.body.from_me,
    parts.body.is_from_me,
    parts.body.sent_by_me,
    parts.message.from_me,
    parts.message.is_from_me,
    parts.data.from_me,
    parts.payload.from_me
  ];
  if (booleansOut.some((v) => v === true || String(v).toLowerCase() === "true")) return "OUT";
  return parseDirectionValue(raw);
}

function normalizeNameCompare(raw: unknown): string {
  return String(raw || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeProxySourceUrl(raw: unknown): string | null {
  const value = String(raw || "").trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    const host = parsed.hostname.toLowerCase();
    const allowed =
      host === "cdn.shopify.com" ||
      host.endsWith(".cdn.shopify.com") ||
      host.endsWith(".myshopify.com");
    if (!allowed) return null;
    const encodedPath = encodeURI(parsed.pathname || "/");
    return `${parsed.protocol}//${parsed.host}${encodedPath}`;
  } catch {
    return null;
  }
}

function expectedProxySignature(url: string): string {
  const secret = String(env.ZOKO_AUTH_TOKEN || "quote_proxy_secret");
  return createHmac("sha256", secret).update(url).digest("hex");
}

function inferDirectionByStatusAndNames(input: {
  deliveryStatus: unknown;
  eventName: unknown;
  senderName: unknown;
  customerName: unknown;
}): "IN" | "OUT" | null {
  const status = String(input.deliveryStatus || "").trim().toUpperCase();
  if (status) {
    if (["SENT", "DELIVERED", "READ", "FAILED", "QUEUED", "SUBMITTED"].includes(status)) return "OUT";
    if (["RECEIVED", "INCOMING"].includes(status)) return "IN";
  }
  const eventName = String(input.eventName || "").trim().toUpperCase();
  if (eventName.includes("OUT")) return "OUT";
  if (eventName.includes("IN")) return "IN";
  const sender = normalizeNameCompare(input.senderName);
  const customer = normalizeNameCompare(input.customerName);
  if (sender && customer && sender !== customer) return "OUT";
  return null;
}

function tokenMatches(req: any, body: Record<string, unknown>): boolean {
  const expected = String(env.ZOKO_WEBHOOK_TOKEN || "").trim();
  if (!expected) return true;

  const headerCandidates = [
    req.get?.("x-zoko-token"),
    req.get?.("x-webhook-token"),
    req.get?.("x-challenge-token"),
    req.get?.("challenge-token"),
    req.get?.("x-zoko-challenge-token"),
    req.get?.("x-zoko-signature"),
    req.get?.("authorization")
  ];

  const bodyCandidates = [
    body.challenge_token,
    body.challengeToken,
    body.token,
    body.verify_token
  ];

  const query = req?.query && typeof req.query === "object" ? (req.query as Record<string, unknown>) : {};
  const queryCandidates = [
    query.token,
    query.challenge_token,
    query.challengeToken,
    query.verify_token
  ];

  const candidates = [...headerCandidates, ...bodyCandidates, ...queryCandidates]
    .map((v) => String(v || "").trim())
    .filter(Boolean);
  const ok = candidates.some((candidate) => candidate === expected || candidate === `Bearer ${expected}`);
  if (!ok) {
    if (String(env.NODE_ENV || "").toLowerCase() !== "production") {
      console.warn("[zoko] token mismatch bypassed in development");
      return true;
    }
    console.warn("[zoko] token mismatch", {
      expectedLength: expected.length,
      headers: {
        xZokoToken: String(req.get?.("x-zoko-token") || ""),
        xWebhookToken: String(req.get?.("x-webhook-token") || ""),
        challengeToken: String(req.get?.("challenge-token") || ""),
        xChallengeToken: String(req.get?.("x-challenge-token") || ""),
        auth: String(req.get?.("authorization") || "")
      },
      query: {
        token: String(query.token || ""),
        challenge_token: String(query.challenge_token || ""),
        verify_token: String(query.verify_token || "")
      },
      bodyKeys: Object.keys(body)
    });
  }
  return ok;
}

function extractReplyContext(parts: {
  body: Record<string, unknown>;
  message: Record<string, unknown>;
  messageContent: Record<string, unknown>;
  data: Record<string, unknown>;
  payload: Record<string, unknown>;
  event: Record<string, unknown>;
}): { replyToExternalId: string | null; replyToText: string | null } {
  const contexts = [
    asRecord(parts.body.context),
    asRecord(parts.message.context),
    asRecord(parts.messageContent.context),
    asRecord(parts.data.context),
    asRecord(parts.payload.context),
    asRecord(parts.event.context),
    asRecord(parts.body.reply),
    asRecord(parts.message.reply),
    asRecord(parts.data.reply),
    asRecord(parts.payload.reply)
  ];

  const replyToExternalId =
    firstString([
      parts.body.reply_to_message_id,
      parts.body.reply_message_id,
      parts.body.parent_message_id,
      parts.message.reply_to_message_id,
      parts.message.reply_message_id,
      parts.message.parent_message_id,
      parts.data.reply_to_message_id,
      parts.data.reply_message_id,
      parts.payload.reply_to_message_id,
      parts.payload.reply_message_id
    ].concat(
      contexts.flatMap((ctx) => [
        ctx.message_id,
        ctx.messageId,
        ctx.id,
        ctx.stanza_id,
        ctx.stanzaId,
        ctx.quoted_message_id,
        ctx.quotedMessageId,
        ctx.reply_to_message_id,
        ctx.replyToMessageId,
        ctx.reply_message_id,
        ctx.replyMessageId,
        ctx.parent_id,
        ctx.parentId,
        ctx.parent_message_id,
        ctx.parentMessageId
      ])
    )) || null;

  const replyToText =
    firstString([
      parts.body.reply_to_text,
      parts.body.reply_text,
      parts.body.quoted_text,
      parts.message.reply_to_text,
      parts.message.reply_text,
      parts.message.quoted_text,
      parts.data.reply_to_text,
      parts.data.reply_text,
      parts.payload.reply_to_text,
      parts.payload.reply_text
    ].concat(
      contexts.flatMap((ctx) => {
        const msg = asRecord(ctx.message);
        const quoted = asRecord(ctx.quoted_message);
        return [
          ctx.text,
          ctx.body,
          ctx.message_text,
          ctx.reply_text,
          ctx.reply_to_text,
          ctx.quoted_text,
          msg.text,
          msg.body,
          quoted.text,
          quoted.body
        ];
      })
    )) || null;

  return { replyToExternalId, replyToText };
}

function parseInboundPayload(body: Record<string, unknown>): {
  externalMessageId: string | null;
  phoneNumber: string;
  clientName: string;
  profileImageUrl: string | null;
  country: string | null;
  productReference: string | null;
  inquirySource: string;
  text: string;
  messageType: "text" | "template" | "image" | "document";
  mediaUrl: string;
  direction: "IN" | "OUT";
  createdAt: string;
  deliveryStatus: string;
  eventName: string;
  replyToExternalId: string | null;
  replyToText: string | null;
} {
  const message = asRecord(body.message);
  const messageContent = asRecord(message.content);
  const contact = asRecord(body.contact);
  const customer = asRecord(body.customer);
  const data = asRecord(body.data);
  const payload = asRecord(body.payload);
  const event = asRecord(body.event);
  const sender = asRecord(body.sender);
  const contactDetails = asRecord(body.contact_details);
  const attachment = Array.isArray(body.attachments) && body.attachments[0] && typeof body.attachments[0] === "object"
    ? (body.attachments[0] as Record<string, unknown>)
    : {};
  const mediaObj = asRecord(body.media);
  const dataMedia = asRecord(data.media);
  const payloadMedia = asRecord(payload.media);
  const eventMedia = asRecord(event.media);
  const imageObj = asRecord(body.image);
  const documentObj = asRecord(body.document);
  const messageImage = asRecord(message.image);
  const messageDocument = asRecord(message.document);
  const externalMessageId = firstString([
    body.id,
    body.message_id,
    message.id,
    message.message_id,
    data.id,
    data.message_id,
    payload.id,
    payload.message_id,
    event.id
  ]) || null;

  const direction = parseDirectionFromPayload({ body, message, data, payload, event });

  const senderPhoneRaw = firstString([
    body.phone,
    body.phone_number,
    body.from,
    body.platformSenderId,
    body.platform_sender_id,
    message.phone,
    message.phone_number,
    message.from,
    message.wa_id,
    contact.phone,
    contact.phone_number,
    contact.wa_id,
    customer.phone,
    customer.phone_number,
    customer.wa_id,
    customer.id,
    customer.customerPhone,
    customer.customer_phone,
    sender.phone,
    sender.phone_number,
    sender.wa_id,
    sender.id,
    contactDetails.phone,
    contactDetails.phone_number,
    data.phone,
    data.from,
    payload.phone,
    payload.from,
    event.phone,
    event.from
  ]);
  const recipientPhoneRaw = firstString([
    body.to,
    body.recipient,
    body.recipient_phone,
    body.customerPhone,
    body.customer_phone,
    message.to,
    message.recipient,
    data.to,
    payload.to,
    event.to,
    customer.phone,
    customer.phone_number,
    customer.customerPhone,
    customer.customer_phone,
    customer.wa_id,
    contact.phone,
    contact.phone_number,
    contact.wa_id
  ]);
  const customerPhoneRaw = firstString([
    customer.phone,
    customer.phone_number,
    customer.customerPhone,
    customer.customer_phone,
    customer.wa_id,
    contact.phone,
    contact.phone_number,
    contact.wa_id
  ]);
  const senderPhone = normalizePhone(senderPhoneRaw);
  const recipientPhone = normalizePhone(recipientPhoneRaw);
  const customerPhone = normalizePhone(customerPhoneRaw);
  let resolvedDirection = direction;
  const inferredByStatus = inferDirectionByStatusAndNames({
    deliveryStatus: firstString([body.deliveryStatus, data.deliveryStatus, payload.deliveryStatus]),
    eventName: firstString([body.event, data.event, payload.event, event.type, event.name]),
    senderName: firstString([body.senderName, sender.name, message.name]),
    customerName: firstString([body.customerName, customer.name, contact.name])
  });
  if (inferredByStatus) {
    resolvedDirection = inferredByStatus;
  }
  if (customerPhone) {
    if (recipientPhone && customerPhone === recipientPhone && senderPhone && senderPhone !== customerPhone) {
      resolvedDirection = "OUT";
    } else if (senderPhone && customerPhone === senderPhone && recipientPhone && recipientPhone !== customerPhone) {
      resolvedDirection = "IN";
    }
  }
  const phoneNumber = normalizePhone(resolvedDirection === "OUT" ? (recipientPhoneRaw || senderPhoneRaw) : (senderPhoneRaw || recipientPhoneRaw));

  if (resolvedDirection === "IN") {
    console.debug("[zoko] direction-resolve", {
      direction_raw: firstString([body.direction, message.direction, data.direction, payload.direction]),
      event: firstString([body.event, data.event, payload.event, event.type, event.name]),
      deliveryStatus: firstString([body.deliveryStatus, data.deliveryStatus, payload.deliveryStatus]),
      chatType: firstString([body.chatType, message.chatType, data.chatType, payload.chatType]),
      senderName: firstString([body.senderName, sender.name]),
      customerName: firstString([body.customerName, customer.name, contact.name]),
      senderPhone,
      recipientPhone,
      customerPhone
    });
  }

  const clientName = firstString([
    body.client_name,
    body.name,
    message.name,
    contact.name,
    customer.name,
    data.name
  ]) || "WhatsApp Lead";
  const profileImageUrlRaw = firstString([
    body.profile_image_url,
    body.profile_picture_url,
    body.profile_pic_url,
    body.avatar,
    body.avatar_url,
    message.profile_image_url,
    message.profile_picture_url,
    contact.profile_image_url,
    contact.profile_picture_url,
    contact.profile_pic_url,
    customer.profile_image_url,
    customer.profile_picture_url,
    customer.profile_pic_url,
    data.profile_image_url,
    data.profile_picture_url,
    payload.profile_image_url,
    payload.profile_picture_url
  ]);
  const profileImageUrl = /^https?:\/\//i.test(profileImageUrlRaw) ? profileImageUrlRaw : null;

  const rawText = firstString([
    body.text,
    body.message_text,
    body.body,
    message.text,
    message.body,
    message.message,
    messageContent.text,
    messageContent.body,
    data.text,
    data.body,
    payload.text,
    payload.body
  ]);

  const rawMessageType = firstString([
    body.type,
    body.message_type,
    message.type,
    message.message_type,
    data.type,
    data.message_type,
    payload.type,
    payload.message_type
  ]).toLowerCase();
  const messageType: "text" | "template" | "image" | "document" =
    rawMessageType.includes("image") || rawMessageType.includes("photo")
      ? "image"
      : rawMessageType.includes("document") || rawMessageType.includes("file")
        ? "document"
        : rawMessageType.includes("template")
          ? "template"
          : "text";
  const mediaUrl = firstString([
    body.fileUrl,
    body.file_url,
    body.image_url,
    body.media_url,
    body.url,
    body.link,
    mediaObj.url,
    mediaObj.link,
    dataMedia.url,
    dataMedia.link,
    payloadMedia.url,
    payloadMedia.link,
    eventMedia.url,
    eventMedia.link,
    imageObj.url,
    imageObj.link,
    documentObj.url,
    documentObj.link,
    attachment.url,
    attachment.link,
    message.url,
    message.link,
    messageImage.url,
    messageImage.link,
    messageDocument.url,
    messageDocument.link,
    messageContent.url
  ]);
  const mediaCaption = firstString([
    body.caption,
    imageObj.caption,
    documentObj.caption,
    messageImage.caption,
    messageDocument.caption,
    messageContent.caption
  ]);
  const text = rawText || (
    messageType === "image"
      ? `[Image]${mediaCaption ? " " + mediaCaption : ""}${mediaUrl ? " " + mediaUrl : ""}`.trim()
      : messageType === "document"
        ? `[Document]${mediaCaption ? " " + mediaCaption : ""}${mediaUrl ? " " + mediaUrl : ""}`.trim()
        : mediaUrl
          ? `[Link] ${mediaUrl}`.trim()
          : ""
  );

  const inquirySource = firstString([
    body.inquiry_source,
    body.source,
    data.source,
    payload.source
  ]) || "Zoko";

  const explicitProductReference = firstString([
    body.product_reference,
    data.product_reference,
    payload.product_reference,
    message.product_reference
  ]) || null;
  const productReference = inferProductReference({
    explicit: explicitProductReference,
    text
  });

  const countryRaw = firstString([
    body.country,
    contact.country,
    customer.country,
    data.country
  ]);
  const country = (countryRaw || inferIsoCountryFromPhone(phoneNumber) || null);

  const createdAt = parseTimestamp(
    body.created_at ?? body.timestamp ?? body.time ?? message.created_at ?? data.created_at ?? payload.created_at
  );
  const deliveryStatus = firstString([body.deliveryStatus, data.deliveryStatus, payload.deliveryStatus]);
  const eventName = firstString([body.event, data.event, payload.event, event.type, event.name]);
  const replyContext = extractReplyContext({ body, message, messageContent, data, payload, event });

  return {
    externalMessageId,
    phoneNumber,
    clientName,
    profileImageUrl,
    country,
    productReference,
    inquirySource,
    text,
    messageType,
    mediaUrl,
    direction: resolvedDirection,
    createdAt,
    deliveryStatus,
    eventName,
    replyToExternalId: replyContext.replyToExternalId,
    replyToText: replyContext.replyToText
  };
}

function normalizeComparableText(raw: string): string {
  return String(raw || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function withinMinutes(a: string, b: string, minutes: number): boolean {
  const ta = new Date(String(a || "")).getTime();
  const tb = new Date(String(b || "")).getTime();
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return false;
  return Math.abs(ta - tb) <= minutes * 60 * 1000;
}

async function findExistingZokoMessageByExternalId(externalId: string): Promise<{ id: string; leadId: string } | null> {
  const safeExternalId = String(externalId || "").trim();
  if (!safeExternalId) return null;
  const db = getDbPool();
  if (!db) return null;
  const q = await db.query<{ id: string; lead_id: string }>(
    `
      select id, lead_id
      from whatsapp_lead_messages
      where provider = 'zoko'
        and external_id = $1::text
      order by created_at desc
      limit 1
    `,
    [safeExternalId]
  );
  const row = q.rows[0];
  if (!row) return null;
  return {
    id: String(row.id || "").trim(),
    leadId: String(row.lead_id || "").trim()
  };
}

function shouldTriggerInboundAnalysisForExternalId(externalId: string | null | undefined): boolean {
  const safeExternalId = String(externalId || "").trim();
  if (!safeExternalId) return true;
  const now = Date.now();
  const existing = analysisTriggerByExternalId.get(safeExternalId);
  if (existing && now - existing <= ANALYSIS_TRIGGER_TTL_MS) {
    return false;
  }
  analysisTriggerByExternalId.set(safeExternalId, now);
  for (const [key, ts] of analysisTriggerByExternalId.entries()) {
    if (now - ts > ANALYSIS_TRIGGER_TTL_MS) {
      analysisTriggerByExternalId.delete(key);
    }
  }
  return true;
}

zokoWebhookRouter.get("/webhooks/zoko/messages", (req, res) => {
  const challenge = String(req.query.challenge || req.query["hub.challenge"] || "").trim();
  const expected = String(env.ZOKO_WEBHOOK_TOKEN || "").trim();
  if (challenge && expected && challenge === expected) {
    return res.status(200).json({ ok: true, challenge });
  }
  return res.status(200).json({ ok: true, status: "ready" });
});

zokoWebhookRouter.get("/api/quote-approval/image-proxy", async (req, res) => {
  const sourceRaw = String(req.query.u || "").trim();
  const signature = String(req.query.s || "").trim();
  const sourceUrl = normalizeProxySourceUrl(sourceRaw);
  if (!sourceUrl || !signature) {
    return res.status(400).json({ error: "invalid_proxy_params" });
  }
  if (expectedProxySignature(sourceUrl) !== signature) {
    return res.status(403).json({ error: "invalid_proxy_signature" });
  }
  try {
    const upstream = await fetch(sourceUrl, { redirect: "follow" });
    if (!upstream.ok) {
      return res.status(502).json({ error: "image_fetch_failed" });
    }
    const contentType = String(upstream.headers.get("content-type") || "image/jpeg");
    const cacheControl = String(upstream.headers.get("cache-control") || "public, max-age=600");
    const body = Buffer.from(await upstream.arrayBuffer());
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", cacheControl);
    return res.status(200).send(body);
  } catch (error) {
    console.warn("[quote-approval] image proxy failed", { error });
    return res.status(502).json({ error: "image_proxy_failed" });
  }
});

zokoWebhookRouter.post([
  "/webhooks/zoko/messages",
  "/webhooks/zoko/message",
  "/webhooks/zoko",
  "/zoko/webhook",
  "/webhooks/zoko/messages/"
], async (req, res) => {
  const body = asRecord(req.body);
  if (!tokenMatches(req, body)) {
    return res.status(401).json({ error: "invalid_webhook_token" });
  }

  try {
    const teamDecisionPayload = parseTeamDecisionWebhookPayload(body);
    if (teamDecisionPayload.malformed) {
      console.warn("[zoko] malformed team quote payload", {
        actor: teamDecisionPayload.actor || null,
        error: teamDecisionPayload.error || "unknown",
        keys: Object.keys(body || {})
      });
      // Do not short-circuit webhook processing.
      // If this is not a valid team QA decision payload, continue as a normal inbound/outbound message.
    }
    if (teamDecisionPayload.parsed) {
      const decisionResult = await applyTeamDecision(teamDecisionPayload.parsed);
      if (!decisionResult.ok) {
        console.warn("[zoko] team quote decision ignored", {
          quoteRequestId: teamDecisionPayload.parsed.quoteRequestId,
          decision: teamDecisionPayload.parsed.decision,
          reason: decisionResult.reason || "unknown"
        });
      }
      return res.status(200).json({ ok: true, decision: decisionResult.status || null });
    }

    // Manager numeric override (after EDIT): accept plain numeric text from team.
    const maybeManagerText = firstString([
      body.text,
      asRecord(body.message).text,
      asRecord(body.data).text,
      asRecord(body.payload).text
    ]);
    const maybeManagerActor = normalizePhone(
      firstString([
        body.from,
        body.phone,
        body.phone_number,
        asRecord(body.message).from,
        asRecord(body.data).from,
        asRecord(body.payload).from,
        asRecord(body.event).from,
        asRecord(asRecord(body).sender).phone
      ])
    );
    if (maybeManagerText && maybeManagerActor) {
      const managerOverride = await applyTeamPriceOverrideFromMessage({
        actor: maybeManagerActor,
        text: maybeManagerText
      });
      if (managerOverride.applied) {
        return res.status(200).json({ ok: true, decision: "PRICE_OVERRIDE" });
      }
    }

    const payload = parseInboundPayload(body);
    if (!payload.phoneNumber) {
      console.warn("[zoko] ignored webhook: missing_phone_number", {
        topLevelKeys: Object.keys(body),
        hasMessage: Boolean(body.message),
        hasData: Boolean(body.data),
        hasPayload: Boolean(body.payload)
      });
      return res.status(200).json({ ok: true, ignored: "missing_phone_number" });
    }

    const interactive = asRecord(body.interactiveButton);
    const interactiveReply = asRecord(body.interactive_reply);
    const messageRecord = asRecord(body.message);
    const messageContent = asRecord(messageRecord.content);
    const fallbackText = firstString([
      body.button_text,
      body.buttonTitle,
      body.button_title,
      body.interactive_title,
      body.interactive_payload,
      body.cta_payload,
      interactive.title,
      interactive.body,
      interactive.id,
      interactive.payload,
      interactiveReply.title,
      interactiveReply.body,
      interactiveReply.id,
      interactiveReply.payload,
      messageRecord.button_text,
      messageRecord.button_title,
      messageRecord.message,
      messageContent.button_text,
      messageContent.button_title,
      messageContent.message,
      asRecord(body.data).button_text,
      asRecord(body.data).button_title,
      asRecord(body.data).message,
      asRecord(body.payload).button_text,
      asRecord(body.payload).button_title,
      asRecord(body.payload).message
    ]);
    const normalizedText = String(payload.text || "").trim() || String(fallbackText || "").trim();
    if (!normalizedText) {
      console.warn("[zoko] ignored webhook: missing_text", {
        topLevelKeys: Object.keys(body),
        phoneNumber: payload.phoneNumber,
        messageType: payload.messageType,
        eventName: payload.eventName || null
      });
      return res.status(200).json({ ok: true, ignored: "missing_text" });
    }
    if ((payload.messageType === "image" || payload.messageType === "document") && !payload.mediaUrl) {
      const message = asRecord(body.message);
      const data = asRecord(body.data);
      const payloadObj = asRecord(body.payload);
      const event = asRecord(body.event);
      console.warn("[zoko] media message without url", {
        externalMessageId: payload.externalMessageId,
        messageType: payload.messageType,
        topLevelKeys: Object.keys(body),
        messageKeys: Object.keys(message),
        dataKeys: Object.keys(data),
        payloadKeys: Object.keys(payloadObj),
        eventKeys: Object.keys(event)
      });
    }

    if (payload.externalMessageId) {
      const alreadyPersisted = await findExistingZokoMessageByExternalId(payload.externalMessageId);
      if (alreadyPersisted && alreadyPersisted.id) {
        console.info("[zoko] duplicate_blocked", {
          dedupeMode: "message_id_db_exact",
          providerMessageId: payload.externalMessageId,
          messageId: alreadyPersisted.id,
          leadId: alreadyPersisted.leadId
        });
        return res.status(200).json({
          ok: true,
          deduped: true,
          dedupe_mode: "message_id_db_exact",
          lead_id: alreadyPersisted.leadId,
          message_id: alreadyPersisted.id
        });
      }
    }

    let lead = await getWhatsAppLeadByPhone(payload.phoneNumber);
    if (!lead) {
      lead = await createWhatsAppLead({
        clientName: payload.clientName,
        phoneNumber: payload.phoneNumber,
        profileImageUrl: payload.profileImageUrl,
        country: payload.country,
        inquirySource: payload.inquirySource,
        productReference: payload.productReference,
        stage: "NEW"
      });
      if (!lead) return res.status(503).json({ error: "lead_create_failed" });
    } else {
      await touchWhatsAppLeadFromInbound({
        id: lead.id,
        clientName: payload.clientName,
        profileImageUrl: payload.profileImageUrl,
        country: payload.country,
        productReference: payload.productReference,
        inquirySource: payload.inquirySource,
        lastActivityAt: payload.createdAt
      });
    }

    const recent = await listRecentWhatsAppLeadMessages(lead.id, 12);
    const normalizedIncoming = normalizeComparableText(normalizedText);
    let resolvedDirection: "IN" | "OUT" = payload.direction;
    const providerMessageId = String(payload.externalMessageId || "").trim();

    // If Zoko webhook is ambiguous and we just sent identical OUT text, force OUT.
    if (resolvedDirection === "IN") {
      const recentOutgoingSameText = recent.find(
        (msg) =>
          String(msg.provider || "").toLowerCase() === "zoko" &&
          msg.direction === "OUT" &&
          normalizeComparableText(msg.text) === normalizedIncoming &&
          withinMinutes(msg.createdAt, payload.createdAt, 3)
      );
      if (recentOutgoingSameText) {
        resolvedDirection = "OUT";
      }
    }

    // Prefer provider message-id anchored dedupe to block duplicate deliveries safely.
    if (providerMessageId) {
      const duplicateByMessageId = recent.find(
        (msg) =>
          String(msg.provider || "").toLowerCase() === "zoko" &&
          String(msg.externalId || "").trim() === providerMessageId
      );
      if (duplicateByMessageId) {
        console.info("[zoko] duplicate_blocked", {
          dedupeMode: "message_id",
          leadId: lead.id,
          providerMessageId
        });
        return res.status(200).json({
          ok: true,
          deduped: true,
          dedupe_mode: "message_id",
          lead_id: lead.id,
          message_id: duplicateByMessageId.id
        });
      }
    } else {
      // Fallback dedupe only when provider id is unavailable.
      const duplicateByContent = recent.find(
        (msg) =>
          String(msg.provider || "").toLowerCase() === "zoko" &&
          msg.direction === resolvedDirection &&
          normalizeComparableText(msg.text) === normalizedIncoming &&
          withinMinutes(msg.createdAt, payload.createdAt, 3)
      );
      if (duplicateByContent) {
        console.info("[zoko] duplicate_blocked", {
          dedupeMode: "content_window",
          leadId: lead.id,
          direction: resolvedDirection
        });
        return res.status(200).json({
          ok: true,
          deduped: true,
          dedupe_mode: "content_window",
          lead_id: lead.id,
          message_id: duplicateByContent.id
        });
      }
    }

    console.info("[zoko] duplicate_not_blocked", {
      leadId: lead.id,
      dedupeMode: providerMessageId ? "message_id_available_no_match" : "content_window_no_match",
      providerMessageId: providerMessageId || null,
      direction: resolvedDirection
    });

    const message = await createWhatsAppLeadMessageWithTracking({
      leadId: lead.id,
      direction: resolvedDirection,
      text: normalizedText,
      provider: "zoko",
      messageType: payload.messageType,
      createdAt: payload.createdAt,
      externalId: payload.externalMessageId,
      metadata: {
        delivery_status: payload.deliveryStatus || null,
        zoko_event: payload.eventName || null,
        reply_to_external_id: payload.replyToExternalId || null,
        reply_to_text: payload.replyToText || null
      }
    }, {
      source: resolvedDirection === "IN" ? "INBOUND" : "OUTBOUND_MANUAL",
      ui_source: "zoko_webhook"
    });
    if (!message) return res.status(503).json({ error: "message_store_failed" });
    if (resolvedDirection === "IN") {
      if (shouldTriggerInboundAnalysisForExternalId(payload.externalMessageId)) {
        triggerWhatsAppAgentOrchestratorForInbound({
          leadId: lead.id,
          messageId: message.id,
          trigger: "zoko_inbound_webhook"
        });
      } else {
        console.info("[zoko] analysis_trigger_blocked_duplicate_external_id", {
          leadId: lead.id,
          messageId: message.id,
          providerMessageId: payload.externalMessageId || null
        });
      }
    }

    if (resolvedDirection === "OUT" && /\bprix\b|\bprice\b|€|\$|\bmad\b|\bdhs?\b/i.test(String(payload.text || ""))) {
      await updateWhatsAppLeadFlags({ id: lead.id, priceSent: true });
    }

    if (resolvedDirection === "IN") {
      const latestLead = await getWhatsAppLeadById(lead.id);
      if (latestLead) {
        const inbound = await listRecentInboundMessagesForLead(lead.id, 20);
        const recentConversation = await listRecentWhatsAppLeadMessages(lead.id, 30);
        await applyInboundSignalExtraction(
          latestLead,
          inbound,
          recentConversation.map((m) => ({
            id: m.id,
            text: m.text,
            createdAt: m.createdAt,
            direction: m.direction
          }))
        );
      }
      void createQuoteRequestsFromInbound(lead.id, {
        id: message.id,
        text: message.text,
        createdAt: message.createdAt,
        metadata: message.metadata || null
      }).catch((error) => {
        console.warn("[zoko] quote request auto-create failed", {
          leadId: lead.id,
          messageId: message.id,
          error
        });
      });
    }

    const latestLeadAfter = await getWhatsAppLeadById(lead.id);
    if (latestLeadAfter) {
      const recentConversation = await listRecentWhatsAppLeadMessages(lead.id, 30);
      const signalDetection = detectSignalsFromMessages(
        recentConversation.map((m) => ({
          id: m.id,
          direction: m.direction,
          text: m.text,
          createdAt: m.createdAt
        })),
        latestLeadAfter
      );
      await updateWhatsAppLeadSignalFlags({
        id: lead.id,
        hasProductInterest: signalDetection.hasProductInterest,
        hasPriceSent: signalDetection.hasPriceSent,
        hasVideoProposed: signalDetection.hasVideoProposed,
        hasPaymentQuestion: signalDetection.hasPaymentQuestion,
        hasDepositLinkSent: signalDetection.hasDepositLinkSent,
        chatConfirmed: signalDetection.chatConfirmed,
        priceIntent: signalDetection.priceIntent,
        videoIntent: signalDetection.videoIntent,
        paymentIntent: signalDetection.paymentIntent,
        depositIntent: signalDetection.depositIntent,
        confirmationIntent: signalDetection.confirmationIntent,
        productInterestSourceMessageId: signalDetection.productInterestSourceMessageId,
        priceSentSourceMessageId: signalDetection.priceSentSourceMessageId,
        videoProposedSourceMessageId: signalDetection.videoProposedSourceMessageId,
        paymentQuestionSourceMessageId: signalDetection.paymentQuestionSourceMessageId,
        depositLinkSourceMessageId: signalDetection.depositLinkSourceMessageId,
        chatConfirmedSourceMessageId: signalDetection.chatConfirmedSourceMessageId
      });
      const leadForProgression = {
        ...latestLeadAfter,
        hasProductInterest: latestLeadAfter.hasProductInterest || signalDetection.hasProductInterest,
        hasPriceSent: latestLeadAfter.hasPriceSent || signalDetection.hasPriceSent,
        hasVideoProposed: latestLeadAfter.hasVideoProposed || signalDetection.hasVideoProposed,
        hasPaymentQuestion: latestLeadAfter.hasPaymentQuestion || signalDetection.hasPaymentQuestion,
        hasDepositLinkSent: latestLeadAfter.hasDepositLinkSent || signalDetection.hasDepositLinkSent,
        chatConfirmed: latestLeadAfter.chatConfirmed || signalDetection.chatConfirmed,
        priceIntent: latestLeadAfter.priceIntent || signalDetection.priceIntent,
        videoIntent: latestLeadAfter.videoIntent || signalDetection.videoIntent,
        paymentIntent: latestLeadAfter.paymentIntent || signalDetection.paymentIntent,
        depositIntent: latestLeadAfter.depositIntent || signalDetection.depositIntent,
        confirmationIntent: latestLeadAfter.confirmationIntent || signalDetection.confirmationIntent
      };
      const progression = applyStageProgression(
        leadForProgression,
        detectConversationEvents(
          recentConversation.map((m) => ({
            id: m.id,
            direction: m.direction,
            text: m.text,
            createdAt: m.createdAt
          })),
          leadForProgression
        ),
        {
          paymentReceived: leadForProgression.paymentReceived,
          depositPaid: leadForProgression.depositPaid,
          hasPaidShopifyOrder: leadForProgression.stage === "CONVERTED",
          shopifyFinancialStatus: leadForProgression.shopifyFinancialStatus
        }
      );
      if (progression.changed && String(latestLeadAfter.channelType || "API").toUpperCase() !== "SHARED") {
        await updateWhatsAppLeadStage({
          id: lead.id,
          stage: progression.nextStage,
          stageAuto: true,
          stageConfidence: progression.confidence == null ? null : progression.confidence / 100,
          stageAutoReason: progression.reason || "conversation_progression",
          stageAutoSourceMessageId: progression.sourceMessageId,
          stageAutoConfidence: progression.confidence,
          source: "conversation_events_auto"
        });
      }
    }

    return res.status(200).json({
      ok: true,
      lead_id: lead.id,
      message_id: message.id
    });
  } catch (error) {
    console.error("[zoko] webhook processing failed", error);
    return res.status(200).json({ ok: true, ignored: "processing_error" });
  }
});
