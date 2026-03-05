import { env } from "../config/env.js";
import {
  createWhatsAppLead,
  getWhatsAppLeadById,
  getWhatsAppLeadByPhone,
  listRecentInboundMessagesByLeadIds,
  listRecentWhatsAppLeadMessages,
  setLeadFirstResponseMinutesFromOutbound,
  touchWhatsAppLeadFromInbound,
  updateWhatsAppLeadFlags,
  updateWhatsAppLeadSignalFlags,
  updateWhatsAppLeadStage,
  updateLeadQualification
} from "../db/whatsappLeadsRepo.js";
import { createWhatsAppLeadMessageWithTracking } from "./mlMessageTracking.js";
import { computeRuleQualification } from "./leadQualificationService.js";
import { inferIsoCountryFromPhone, normalizePhoneE164 } from "./phoneCountry.js";
import { inferProductReference } from "./productReference.js";
import { applyInboundSignalExtraction } from "./whatsappLeadSignals.js";
import { applyStageProgression, detectConversationEvents, detectSignalsFromMessages } from "./conversationStageProgression.js";

type ParsedMessage = {
  externalId: string | null;
  phoneNumber: string;
  clientName: string;
  profileImageUrl: string | null;
  country: string | null;
  productReference: string | null;
  inquirySource: "Zoko";
  text: string;
  direction: "IN" | "OUT";
  messageType: "text" | "template" | "image" | "document";
  createdAt: string;
  deliveryStatus: string;
  eventName: string;
  replyToExternalId: string | null;
  replyToText: string | null;
};

export type ZokoSyncResult = {
  pages: number;
  rows: number;
  leadsUpserted: number;
  messagesImported: number;
  nextCursor: string | null;
};

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

function normalizePhone(raw: string): string {
  return normalizePhoneE164(raw);
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

function parseDirection(input: unknown): "IN" | "OUT" {
  const raw = String(input || "").trim().toUpperCase();
  if (!raw) return "IN";
  if (raw === "OUT" || raw === "OUTBOUND" || raw === "OUTGOING" || raw === "SENT" || raw === "AGENT" || raw === "BUSINESS") return "OUT";
  if (raw === "IN" || raw === "INBOUND" || raw === "RECEIVED" || raw === "CUSTOMER") return "IN";
  if (raw.includes("OUT") || raw.includes("SENT") || raw.includes("AGENT") || raw.includes("BUSINESS")) return "OUT";
  if (raw.includes("IN") || raw.includes("RECEIVED") || raw.includes("CUSTOMER")) return "IN";
  return "IN";
}

function parseDirectionFromRow(parts: {
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
  return parseDirection(raw);
}

function normalizeNameCompare(raw: unknown): string {
  return String(raw || "").trim().toLowerCase().replace(/\s+/g, " ");
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

function parseMessageType(input: unknown): "text" | "template" | "image" | "document" {
  const raw = String(input || "").trim().toLowerCase();
  if (raw === "template") return "template";
  if (raw === "image" || raw === "photo") return "image";
  if (raw === "document" || raw === "file") return "document";
  return "text";
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

function parseMessageRow(row: unknown): ParsedMessage | null {
  const body = asRecord(row);
  const message = asRecord(body.message);
  const messageContent = asRecord(message.content);
  const contact = asRecord(body.contact);
  const sender = asRecord(body.sender);
  const contactDetails = asRecord(body.contact_details);
  const customer = asRecord(body.customer);
  const data = asRecord(body.data);
  const payload = asRecord(body.payload);
  const event = asRecord(body.event);
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

  const direction = parseDirectionFromRow({ body, message, data, payload, event });

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
    senderName: firstString([body.senderName, message.name]),
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
  if (!phoneNumber) return null;

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

  const messageType = parseMessageType(
    body.message_type ?? message.message_type ?? data.message_type ?? payload.message_type ?? body.type ?? data.type ?? payload.type
  );
  const mediaUrl = firstString([
    body.fileUrl,
    body.file_url,
    body.image_url,
    body.media_url,
    body.url,
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
        : ""
  );
  if (!text) return null;

  const clientName = firstString([
    body.client_name,
    body.name,
    data.name,
    contact.name,
    customer.name,
    message.name
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

  const externalId = firstString([
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

  const createdAt = parseTimestamp(
    body.created_at ?? body.timestamp ?? body.time ?? message.created_at ?? data.created_at ?? payload.created_at
  );
  const deliveryStatus = firstString([body.deliveryStatus, data.deliveryStatus, payload.deliveryStatus]);
  const eventName = firstString([body.event, data.event, payload.event, event.type, event.name]);
  const replyContext = extractReplyContext({ body, message, messageContent, data, payload, event });
  return {
    externalId,
    phoneNumber,
    clientName,
    profileImageUrl,
    country,
    productReference,
    inquirySource: "Zoko",
    text,
    direction: resolvedDirection,
    messageType,
    createdAt,
    deliveryStatus,
    eventName,
    replyToExternalId: replyContext.replyToExternalId,
    replyToText: replyContext.replyToText
  };
}

function extractRows(response: unknown): unknown[] {
  if (Array.isArray(response)) return response;
  const body = asRecord(response);
  const direct = [body.items, body.messages, body.results, body.events, body.data, body.payload];
  for (const candidate of direct) {
    if (Array.isArray(candidate)) return candidate;
  }
  const dataObj = asRecord(body.data);
  const payloadObj = asRecord(body.payload);
  for (const candidate of [
    dataObj.items,
    dataObj.messages,
    dataObj.results,
    dataObj.events,
    dataObj.data,
    dataObj.payload,
    payloadObj.items,
    payloadObj.messages,
    payloadObj.results,
    payloadObj.events,
    payloadObj.data
  ]) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function extractNextCursor(response: unknown): string | null {
  const body = asRecord(response);
  const data = asRecord(body.data);
  const paging = asRecord(body.paging);
  const links = asRecord(body.links);
  const cursor = firstString([
    body.next_cursor,
    body.cursor,
    body.next,
    body.nextCursor,
    data.next_cursor,
    data.cursor,
    paging.next_cursor,
    paging.cursor,
    links.next
  ]);
  return cursor || null;
}

function buildAuthHeaders(): Record<string, string> {
  const authHeader = String(env.ZOKO_AUTH_HEADER || "apikey").trim();
  const authPrefix = String(env.ZOKO_AUTH_PREFIX || "").trim();
  const token = String(env.ZOKO_AUTH_TOKEN || "").trim();
  if (!token) throw new Error("ZOKO_AUTH_TOKEN manquant");
  return {
    [authHeader]: authPrefix ? `${authPrefix} ${token}` : token
  };
}

async function processWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  const queue = Array.isArray(items) ? items.slice() : [];
  const concurrency = Math.max(1, Math.min(12, Math.round(limit || 4)));
  const runners = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const next = queue.shift();
      if (next === undefined) return;
      await worker(next);
    }
  });
  await Promise.all(runners);
}

export async function syncZokoConversationHistory(options?: {
  maxPages?: number;
  cursor?: string | null;
  onlyInbound?: boolean;
}): Promise<ZokoSyncResult> {
  const baseUrl = String(env.ZOKO_HISTORY_API_URL || "").trim();
  if (!baseUrl) throw new Error("ZOKO_HISTORY_API_URL manquant dans .env");
  try {
    // Validate once for clearer error reporting than generic "Invalid URL".
    new URL(baseUrl);
  } catch {
    throw new Error("ZOKO_HISTORY_API_URL invalide (format URL)");
  }

  const headers = {
    "Content-Type": "application/json",
    ...buildAuthHeaders()
  };

  const maxPages = Math.max(1, Math.min(100, Number(options?.maxPages || 5)));
  let page = 0;
  let cursor: string | null = options?.cursor || null;
  let totalRows = 0;
  let importedMessages = 0;
  let upsertedLeads = 0;
  const inboundLeadIds = new Set<string>();
  const touchedLeadIds = new Set<string>();
  const onlyInbound = Boolean(options?.onlyInbound);

  while (page < maxPages) {
    const pageUrl = new URL(baseUrl);
    if (cursor) pageUrl.searchParams.set("cursor", cursor);
    const response = await fetch(pageUrl.toString(), { headers });
    if (!response.ok) {
      const raw = await response.text();
      throw new Error(`Zoko sync failed (${response.status}): ${raw.slice(0, 300)}`);
    }
    const payload = (await response.json()) as unknown;
    const rows = extractRows(payload);
    if (!rows.length) break;
    totalRows += rows.length;

    for (const row of rows) {
      const parsed = parseMessageRow(row);
      if (!parsed) continue;
      if (onlyInbound && parsed.direction !== "IN") continue;

      let lead = await getWhatsAppLeadByPhone(parsed.phoneNumber);
      if (!lead) {
        lead = await createWhatsAppLead({
          clientName: parsed.clientName,
          phoneNumber: parsed.phoneNumber,
          profileImageUrl: parsed.profileImageUrl,
          country: parsed.country,
          inquirySource: parsed.inquirySource,
          productReference: parsed.productReference,
          stage: "NEW"
        });
        if (!lead) continue;
        upsertedLeads += 1;
      } else {
        await touchWhatsAppLeadFromInbound({
          id: lead.id,
          clientName: parsed.clientName,
          profileImageUrl: parsed.profileImageUrl,
          country: parsed.country,
          productReference: parsed.productReference,
          inquirySource: parsed.inquirySource,
          lastActivityAt: parsed.createdAt
        });
      }

      const message = await createWhatsAppLeadMessageWithTracking({
        leadId: lead.id,
        direction: parsed.direction,
        text: parsed.text,
        provider: "zoko",
        messageType: parsed.messageType,
        externalId: parsed.externalId,
        createdAt: parsed.createdAt,
        metadata: {
          delivery_status: parsed.deliveryStatus || null,
          zoko_event: parsed.eventName || null,
          reply_to_external_id: parsed.replyToExternalId || null,
          reply_to_text: parsed.replyToText || null
        }
      }, {
        source: parsed.direction === "IN" ? "INBOUND" : "OUTBOUND_MANUAL",
        ui_source: "zoko_history_sync"
      });
      if (!message) continue;
      importedMessages += 1;
      touchedLeadIds.add(lead.id);

      if (
        parsed.direction === "OUT" &&
        /(?:\b\d{1,3}(?:[\s,.]\d{3})*(?:[\.,]\d+)?\s?(?:dhs?|dh|mad|€|eur|usd|\$)\b|\b(le\s+prix\s+est|price\s+is|priced\s+at)\b)/i.test(String(parsed.text || ""))
      ) {
        await updateWhatsAppLeadFlags({ id: lead.id, priceSent: true });
      }

      if (parsed.direction === "IN") {
        inboundLeadIds.add(lead.id);
        const rules = computeRuleQualification(lead, parsed.text, {
          messageId: message.id,
          createdAt: message.createdAt
        });
        await updateLeadQualification({
          id: lead.id,
          qualificationTags: rules.tags,
          intentLevel: rules.intentLevel || undefined,
          stageAutoReason: rules.stageAutoReason || undefined,
          recommendedStage: rules.recommendedStage || undefined,
          recommendedStageReason: rules.recommendedStageReason || undefined,
          recommendedStageConfidence: rules.confidence || undefined,
          detectedSignals: rules.detectedSignals
        });
      } else if (lead.firstResponseTimeMinutes == null) {
        await setLeadFirstResponseMinutesFromOutbound(lead.id, message.createdAt);
      }
    }

    const next = extractNextCursor(payload);
    if (!next || next === cursor) {
      cursor = next;
      break;
    }
    cursor = next;
    page += 1;
  }

  if (inboundLeadIds.size > 0) {
    const groupedInbound = await listRecentInboundMessagesByLeadIds(Array.from(inboundLeadIds), 20);
    await processWithConcurrency(Array.from(inboundLeadIds), 4, async (leadId) => {
      const lead = await getWhatsAppLeadById(leadId);
      if (!lead) return;
      const inbound = groupedInbound.get(leadId) || [];
      const recentConversation = await listRecentWhatsAppLeadMessages(leadId, 30);
      await applyInboundSignalExtraction(
        lead,
        inbound,
        recentConversation.map((m) => ({
          id: m.id,
          text: m.text,
          createdAt: m.createdAt,
          direction: m.direction
        }))
      );
    });
  }

  if (touchedLeadIds.size > 0) {
    await processWithConcurrency(Array.from(touchedLeadIds), 4, async (leadId) => {
      const lead = await getWhatsAppLeadById(leadId);
      if (!lead) return;
      const recentConversation = await listRecentWhatsAppLeadMessages(leadId, 30);
      const signalDetection = detectSignalsFromMessages(
        recentConversation.map((m) => ({
          id: m.id,
          direction: m.direction,
          text: m.text,
          createdAt: m.createdAt
        })),
        lead
      );
      await updateWhatsAppLeadSignalFlags({
        id: leadId,
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
        ...lead,
        hasProductInterest: lead.hasProductInterest || signalDetection.hasProductInterest,
        hasPriceSent: lead.hasPriceSent || signalDetection.hasPriceSent,
        hasVideoProposed: lead.hasVideoProposed || signalDetection.hasVideoProposed,
        hasPaymentQuestion: lead.hasPaymentQuestion || signalDetection.hasPaymentQuestion,
        hasDepositLinkSent: lead.hasDepositLinkSent || signalDetection.hasDepositLinkSent,
        chatConfirmed: lead.chatConfirmed || signalDetection.chatConfirmed,
        priceIntent: lead.priceIntent || signalDetection.priceIntent,
        videoIntent: lead.videoIntent || signalDetection.videoIntent,
        paymentIntent: lead.paymentIntent || signalDetection.paymentIntent,
        depositIntent: lead.depositIntent || signalDetection.depositIntent,
        confirmationIntent: lead.confirmationIntent || signalDetection.confirmationIntent
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
      if (!progression.changed) return;
      if (String(lead.channelType || "API").toUpperCase() === "SHARED") return;
      await updateWhatsAppLeadStage({
        id: leadId,
        stage: progression.nextStage,
        stageAuto: true,
        stageConfidence: progression.confidence == null ? null : progression.confidence / 100,
        stageAutoReason: progression.reason || "conversation_progression",
        stageAutoSourceMessageId: progression.sourceMessageId,
        stageAutoConfidence: progression.confidence,
        source: "conversation_events_auto"
      });
    });
  }

  return {
    pages: page + 1,
    rows: totalRows,
    leadsUpserted: upsertedLeads,
    messagesImported: importedMessages,
    nextCursor: cursor
  };
}
