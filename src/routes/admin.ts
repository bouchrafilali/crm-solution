import { Router, type Request, type Response } from "express";
import { createHmac } from "node:crypto";
import { z } from "zod";
import { env } from "../config/env.js";
import { getBusinessProfile, updateBusinessProfile } from "../config/business.js";
import {
  getOrderById,
  listOrdersForQueue,
  updateOrder,
  addManyOrderSnapshots,
  type ArticleStatus,
  type ShippingStatus
} from "../services/orderSnapshots.js";
import { fetchOrdersForPeriod } from "../services/shopifyOrdersSync.js";
import { listWebhookEvents } from "../services/webhookEvents.js";
import { buildOrderInvoiceHtml, buildOrderInvoicePdf, renderHtmlToPdfBuffer } from "../services/invoicePdf.js";
import { uploadPdfToShopifyFiles } from "../services/shopifyFiles.js";
import { computeDashboardInsights, computeDashboardSeries } from "../services/insights.js";
import { isBigQueryForecastConfigured, runLocalRevenueForecast, runLocalRevenueForecastAsOf, runRevenueForecast } from "../services/bigqueryForecast.js";
import { computeExternalSignals } from "../services/externalSignals.js";
import { listOrdersForAnalytics, pruneOrdersMissingInRange, upsertManyFromShopifyPayloads } from "../db/ordersRepo.js";
import { getLatestForecastRun, saveForecastRun } from "../db/forecastRepo.js";
import { aggregateMonthly, applySimulation, type BaselineDailyPoint } from "../services/forecastSimulation.js";
import { runForecastV4FromBaseline } from "../services/forecastV4.js";
import {
  APPOINTMENT_DEFAULT_DURATIONS,
  addAppointmentMessage,
  createAppointment,
  deleteAppointment,
  findAppointmentConflict,
  getAppointmentById,
  listAppointmentsByShop,
  listAppointmentsForMetafield,
  listAppointmentMessages,
  listReminderCandidates,
  markDesignerReminderSent,
  markReminderSent,
  resolveAppointmentWindow,
  updateAppointment,
  getAppointmentRdvSnapshot,
  type AppointmentStatus,
  type AppointmentType,
  type ReminderKind
} from "../db/appointmentsRepo.js";
import { syncAppointmentsMetafield } from "../services/shopifyAppointmentsMetafield.js";
import { ensureShopifyCustomerForAppointment, suggestShopifyCustomers } from "../services/shopifyCustomers.js";
import { listShopifyPointsOfSale } from "../services/shopifyLocations.js";
import { getShopifyAdminToken } from "../services/shopifyAdminAuth.js";
import { createManualOrderTransaction, parseShopifyErrorMessage } from "../services/shopifyOrderPayments.js";
import { listWhatsAppPriorityLeads } from "../db/whatsappLeadsRepo.js";

export const adminRouter = Router();

const businessSchema = z.object({
  brandName: z.string().min(1),
  coreMarket: z.string().min(1),
  highValueOrderThreshold: z.coerce.number().min(0),
  vipCustomerTag: z.string().min(1),
  reviewRequestDelayDays: z.coerce.number().int().min(0)
});

const syncSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional()
});
const compareSchema = z.object({
  compareFrom: z.string().optional(),
  compareTo: z.string().optional()
});
const forecastSimulationSchema = z.object({
  trafficPct: z.coerce.number().min(-30).max(50).default(0),
  conversionPct: z.coerce.number().min(-20).max(30).default(0),
  aovPct: z.coerce.number().min(-20).max(25).default(0),
  showroomEnabled: z.coerce.boolean().default(false),
  showroomStartMonth: z.string().optional().nullable(),
  capacityEnabled: z.coerce.boolean().default(false),
  capacityLimitOrdersPerDay: z.coerce.number().optional().nullable()
});

const shippingStatusSchema = z.enum(["in_progress", "ready", "shipped"]);
const articleStatusSchema = z.enum(["pending", "in_progress", "prepared", "shipped"]);
const invoiceTemplateSchema = z.enum(["classic", "coin", "showroom_receipt", "international_invoice"]);

const sendInvoiceTemplateSchema = z.object({
  templateChoice: invoiceTemplateSchema.optional(),
  templateChoices: z.array(invoiceTemplateSchema).min(1).max(4).optional(),
  recipientPhone: z.string().optional()
});

function buildBaselineDailyPointsFromForecast(
  points: Array<Record<string, unknown>> | undefined | null,
  horizon: number
): BaselineDailyPoint[] {
  return (Array.isArray(points) ? points : [])
    .slice(0, horizon)
    .map((p) => {
      const revenueFromV3 = Number(
        p && typeof p.revenue === "object" && p.revenue
          ? (p.revenue as Record<string, unknown>).neutral
          : NaN
      );
      const ordersFromV3 = Number(
        p && typeof p.orders === "object" && p.orders
          ? (p.orders as Record<string, unknown>).neutral
          : NaN
      );
      const revenueFromMain = Number(p?.value);
      return {
        date: String(p?.date || ""),
        revenue_mad: Number.isFinite(revenueFromV3) ? revenueFromV3 : Number.isFinite(revenueFromMain) ? revenueFromMain : 0,
        orders: Number.isFinite(ordersFromV3) ? ordersFromV3 : 0
      };
    });
}

const appointmentStatusSchema = z.enum([
  "scheduled",
  "confirmed",
  "reminder_sent",
  "rescheduled",
  "cancelled",
  "completed",
  "no_show"
]);
const appointmentTypeSchema = z.enum(["fitting", "measurements", "pickup", "alteration", "vip_consultation"]);

const appointmentCreateSchema = z.object({
  shop: z.string().optional(),
  customerName: z.string().min(1),
  customerPhone: z.string().min(7),
  customerEmail: z.string().email().optional().nullable(),
  appointmentAt: z.string().min(8),
  endAt: z.string().optional(),
  type: appointmentTypeSchema.optional(),
  durationMinutes: z.coerce.number().int().min(15).max(360).optional(),
  status: appointmentStatusSchema.optional(),
  location: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  reminderD1Enabled: z.boolean().optional(),
  reminderH3Enabled: z.boolean().optional(),
  reminderDesignerEnabled: z.boolean().optional()
});

const appointmentUpdateSchema = z.object({
  shop: z.string().optional(),
  customerName: z.string().optional(),
  customerPhone: z.string().optional(),
  customerEmail: z.string().email().optional().nullable(),
  appointmentAt: z.string().optional(),
  endAt: z.string().optional().nullable(),
  type: appointmentTypeSchema.optional(),
  durationMinutes: z.coerce.number().int().min(15).max(360).optional(),
  status: appointmentStatusSchema.optional(),
  location: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  lastMessageAt: z.string().optional().nullable(),
  orderId: z.string().optional().nullable(),
  orderName: z.string().optional().nullable(),
  orderTotalAmount: z.coerce.number().optional().nullable(),
  orderCurrency: z.string().optional().nullable(),
  reminderD1Enabled: z.boolean().optional(),
  reminderH3Enabled: z.boolean().optional(),
  reminderDesignerEnabled: z.boolean().optional(),
  reminderD1SentAt: z.string().optional().nullable(),
  reminderH3SentAt: z.string().optional().nullable(),
  reminderDesignerSentAt: z.string().optional().nullable()
});

const appointmentTemplateActionSchema = z.enum(["confirm", "reminder", "reschedule", "cancel"]);

const appointmentSendTemplateSchema = z.object({
  shop: z.string().optional(),
  action: appointmentTemplateActionSchema
});

const appointmentOrderLineItemSchema = z
  .object({
    title: z.string().optional(),
    quantity: z.coerce.number().int().min(1).max(200).optional(),
    price: z.coerce.number().min(0).max(10_000_000).optional(),
    variantId: z.union([z.string(), z.number()]).optional()
  })
  .refine(
    (item) => {
      const hasVariant = item.variantId !== undefined && String(item.variantId).trim().length > 0;
      if (hasVariant) return true;
      return Boolean(item.title && String(item.title).trim()) && item.price !== undefined;
    },
    { message: "Chaque ligne doit avoir soit variantId, soit title + price." }
  );

const appointmentCreateOrderSchema = z.object({
  shop: z.string().optional(),
  lineItems: z.array(appointmentOrderLineItemSchema).min(1).max(50).optional(),
  paymentMethod: z.enum(["cash", "cheque", "bank_transfer", "card", "split", "installment"]).optional(),
  markUnpaid: z.coerce.boolean().optional(),
  paymentBreakdown: z.object({
    firstAmount: z.coerce.number().positive().optional(),
    firstMethod: z.enum(["cash", "cheque", "bank_transfer", "card"]).optional(),
    secondAmount: z.coerce.number().min(0).optional(),
    secondMethod: z.enum(["cash", "cheque", "bank_transfer", "card"]).optional(),
    remainingDueDate: z.string().optional().nullable()
  }).optional(),
  payment_type: z.enum(["installment"]).optional(),
  deposit_amount: z.coerce.number().positive().optional(),
  remaining_amount: z.coerce.number().min(0).optional(),
  deposit_method: z.enum(["cash", "cheque", "bank_transfer", "card"]).optional(),
  remaining_method: z.enum(["cash", "cheque", "bank_transfer", "card"]).optional().nullable(),
  remaining_due_date: z.string().optional().nullable()
});

const appointmentRetryPaymentSchema = z.object({
  shop: z.string().optional(),
  orderId: z.string().min(1).optional(),
  amount: z.coerce.number().positive(),
  currency: z.string().optional().nullable(),
  paymentMethod: z.enum(["cash", "cheque", "bank_transfer", "card", "split", "installment"]).optional(),
  paymentMethodLabel: z.string().optional().nullable()
});

const orderUpdateSchema = z.object({
  shippingStatus: shippingStatusSchema.optional(),
  shippingDate: z.string().nullable().optional(),
  orderLocation: z.string().optional(),
  bankDetails: z
    .object({
      bankName: z.string().optional(),
      swiftBic: z.string().optional(),
      routingNumber: z.string().optional(),
      beneficiaryName: z.string().optional(),
      accountNumber: z.string().optional(),
      bankAddress: z.string().optional(),
      paymentReference: z.string().optional()
    })
    .optional(),
  articles: z
    .array(
      z.object({
        id: z.string().min(1),
        status: articleStatusSchema
      })
    )
    .optional()
});

function isShopDomain(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(value);
}

function resolveShopFromRequest(req: { query?: Record<string, unknown>; body?: Record<string, unknown> }): string {
  const queryShop = typeof req.query?.shop === "string" ? req.query.shop.trim().toLowerCase() : "";
  const bodyShop = typeof req.body?.shop === "string" ? req.body.shop.trim().toLowerCase() : "";
  const fallbackShop = String(env.SHOPIFY_SHOP || "").trim().toLowerCase();
  const candidate = queryShop || bodyShop || fallbackShop;
  if (!candidate || !isShopDomain(candidate)) {
    throw new Error("Shop Shopify invalide. Fournissez `shop` (ex: store.myshopify.com).");
  }
  return candidate;
}

function parseDateRange(input: unknown): { from: Date; toExclusive: Date } | null {
  const parsed = syncSchema.safeParse(input);
  if (!parsed.success) return null;

  const today = new Date();
  const defaultTo = today.toISOString().slice(0, 10);
  const defaultFrom = new Date(today.getTime() - 89 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const fromText = parsed.data.from ?? defaultFrom;
  const toText = parsed.data.to ?? defaultTo;
  const from = new Date(`${fromText}T00:00:00.000Z`);
  const to = new Date(`${toText}T00:00:00.000Z`);

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;

  const toExclusive = new Date(to.getTime() + 24 * 60 * 60 * 1000);
  if (from.getTime() >= toExclusive.getTime()) return null;

  return { from, toExclusive };
}

function parseComparisonDateRange(input: unknown): { from: Date; toExclusive: Date } | null {
  const parsed = compareSchema.safeParse(input);
  if (!parsed.success) return null;
  const fromText = parsed.data.compareFrom;
  const toText = parsed.data.compareTo;
  if (!fromText || !toText) return null;

  const from = new Date(`${fromText}T00:00:00.000Z`);
  const to = new Date(`${toText}T00:00:00.000Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;

  const toExclusive = new Date(to.getTime() + 24 * 60 * 60 * 1000);
  if (from.getTime() >= toExclusive.getTime()) return null;
  return { from, toExclusive };
}

function normalizePhoneForApi(phone: string): string {
  const digits = String(phone || "").replace(/[^0-9]/g, "");
  if (digits.length < 8 || digits.length > 15) return "";
  return digits;
}

function extractNumericShopifyId(value: unknown): number | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const gidMatch = raw.match(/(\d+)(?:\D*)$/);
  if (gidMatch && gidMatch[1]) {
    const id = Number(gidMatch[1]);
    return Number.isFinite(id) && id > 0 ? id : null;
  }
  const id = Number(raw);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function appointmentActionToStatus(action: z.infer<typeof appointmentTemplateActionSchema>): AppointmentStatus {
  if (action === "confirm") return "confirmed";
  if (action === "reminder") return "reminder_sent";
  if (action === "reschedule") return "rescheduled";
  return "cancelled";
}

function appointmentActionTemplateName(action: z.infer<typeof appointmentTemplateActionSchema>): string {
  const fallback = String(env.ZOKO_APPOINTMENT_CONFIRM_TEMPLATE_NAME || env.ZOKO_TEMPLATE_NAME || "").trim();
  if (action === "confirm") {
    return fallback;
  }
  if (action === "reminder") {
    return String(env.ZOKO_APPOINTMENT_REMINDER_TEMPLATE_NAME || fallback).trim();
  }
  if (action === "reschedule") {
    return String(env.ZOKO_APPOINTMENT_RESCHEDULE_TEMPLATE_NAME || fallback).trim();
  }
  return String(env.ZOKO_APPOINTMENT_CANCEL_TEMPLATE_NAME || fallback).trim();
}

function formatAppointmentDateTime(iso: string): { date: string; time: string } {
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return { date: "", time: "" };
  const date = dt.toLocaleDateString("fr-FR", { year: "numeric", month: "2-digit", day: "2-digit" });
  const time = dt.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  return { date, time };
}

type SendAppointmentTemplateInput = {
  appointment: {
    id: string;
    customerName: string;
    customerPhone: string;
    customerEmail: string | null;
    appointmentAt: string;
    endAt?: string;
    type?: string;
    location: string | null;
    notes: string | null;
    status: string;
    shop: string;
  };
  action: z.infer<typeof appointmentTemplateActionSchema>;
};

async function sendAppointmentTemplate({
  appointment,
  action
}: SendAppointmentTemplateInput): Promise<{
  ok: boolean;
  status: number;
  error?: string;
  providerResponse?: unknown;
  usedTemplate?: string;
  usedLanguage?: string;
}> {
  const templateName = appointmentActionTemplateName(action);
  if (!templateName) {
    return { ok: false, status: 400, error: "Template Zoko non configuré pour cette action." };
  }

  const templateLanguage = String(env.ZOKO_APPOINTMENT_TEMPLATE_LANGUAGE || env.ZOKO_TEMPLATE_LANGUAGE || "fr").trim();
  const phone = normalizePhoneForApi(appointment.customerPhone);
  if (!phone) {
    return { ok: false, status: 400, error: "Numéro client invalide pour envoi WhatsApp." };
  }

  const when = formatAppointmentDateTime(appointment.appointmentAt);
  const endWhen = formatAppointmentDateTime(appointment.endAt || "");
  const payloadVars = {
    phone,
    channel: String(env.ZOKO_CHANNEL || "whatsapp"),
    customer_name: appointment.customerName || "",
    customer_phone: appointment.customerPhone || "",
    customer_email: appointment.customerEmail || "",
    appointment_date: when.date,
    appointment_time: when.time,
    appointment_end_time: endWhen.time || "",
    appointment_at: appointment.appointmentAt,
    appointment_type: appointment.type || "fitting",
    appointment_location: appointment.location || "Rendez-vous WhatsApp",
    appointment_notes: appointment.notes || "",
    appointment_status: appointment.status || "",
    action
  };

  let payload: unknown;
  if (env.ZOKO_APPOINTMENT_TEMPLATE_PAYLOAD_JSON) {
    try {
      const parsedPayload = JSON.parse(env.ZOKO_APPOINTMENT_TEMPLATE_PAYLOAD_JSON) as unknown;
      payload = replaceTemplatePlaceholders(parsedPayload, payloadVars);
    } catch {
      return { ok: false, status: 400, error: "ZOKO_APPOINTMENT_TEMPLATE_PAYLOAD_JSON invalide." };
    }
  } else {
    let templateArgs: unknown[] = [
      payloadVars.customer_name,
      payloadVars.appointment_date,
      payloadVars.appointment_time,
      payloadVars.appointment_location
    ];
    if (env.ZOKO_APPOINTMENT_TEMPLATE_ARGS_JSON) {
      try {
        const parsedArgs = JSON.parse(env.ZOKO_APPOINTMENT_TEMPLATE_ARGS_JSON) as unknown;
        const replaced = replaceTemplatePlaceholders(parsedArgs, payloadVars);
        if (Array.isArray(replaced) && replaced.length > 0) templateArgs = replaced;
      } catch {
        // keep defaults
      }
    }
    payload = {
      channel: payloadVars.channel,
      recipient: phone,
      type: String(env.ZOKO_APPOINTMENT_TEMPLATE_TYPE || env.ZOKO_TEMPLATE_TYPE || "buttonTemplate"),
      templateId: templateName,
      templateLanguage,
      templateArgs
    };
  }

  console.log(
    `[appointments] send-template action=${action} template=${templateName} language=${templateLanguage} appointment=${appointment.id}`
  );
  const sendResult = await sendZokoTemplate(payload, templateName, templateLanguage);
  return {
    ok: sendResult.ok,
    status: sendResult.status || 0,
    error: sendResult.error,
    providerResponse: sendResult.providerResponse || null,
    usedTemplate: sendResult.usedTemplate,
    usedLanguage: sendResult.usedLanguage
  };
}

function reminderKindDue(appointmentAtIso: string, nowMs: number): ReminderKind | null {
  const targetMs = new Date(appointmentAtIso).getTime();
  if (!Number.isFinite(targetMs)) return null;
  const diffMs = targetMs - nowMs;
  if (diffMs <= 0) return null;
  const d1Min = 23 * 60;
  const d1Max = 24 * 60;
  const h3Min = 2 * 60;
  const h3Max = 3 * 60;
  const diffMin = diffMs / 60000;
  if (diffMin >= d1Min && diffMin <= d1Max) return "d1";
  if (diffMin >= h3Min && diffMin <= h3Max) return "h3";
  return null;
}

function isDesignerReminderDueAtMorning(
  appointmentAtIso: string,
  nowDate: Date
): boolean {
  const appointment = new Date(appointmentAtIso);
  if (Number.isNaN(appointment.getTime())) return false;
  const sameDay =
    appointment.getFullYear() === nowDate.getFullYear() &&
    appointment.getMonth() === nowDate.getMonth() &&
    appointment.getDate() === nowDate.getDate();
  if (!sameDay) return false;
  const mins = nowDate.getHours() * 60 + nowDate.getMinutes();
  return mins >= 8 * 60 + 30 && mins < 8 * 60 + 36;
}

async function sendDesignerReminderTemplate(appointment: {
  id: string;
  customerName: string;
  customerPhone: string;
  appointmentAt: string;
  location?: string | null;
}): Promise<{
  ok: boolean;
  status: number;
  error?: string;
  providerResponse?: unknown;
  usedTemplate?: string;
  usedLanguage?: string;
}> {
  const templateName = String(env.ZOKO_APPOINTMENT_DESIGNER_REMINDER_TEMPLATE_NAME || "").trim();
  const designerPhone = normalizePhoneForApi(String(env.ZOKO_APPOINTMENT_DESIGNER_REMINDER_PHONE || ""));
  if (!templateName) {
    return { ok: false, status: 400, error: "Template designer non configuré." };
  }
  if (!designerPhone) {
    return { ok: false, status: 400, error: "Numéro designer non configuré." };
  }
  const when = formatAppointmentDateTime(appointment.appointmentAt);
  const payload = {
    channel: String(env.ZOKO_CHANNEL || "whatsapp"),
    recipient: designerPhone,
    type: String(env.ZOKO_APPOINTMENT_TEMPLATE_TYPE || env.ZOKO_TEMPLATE_TYPE || "buttonTemplate"),
    templateId: templateName,
    templateLanguage: String(
      env.ZOKO_APPOINTMENT_DESIGNER_REMINDER_LANGUAGE ||
      env.ZOKO_APPOINTMENT_TEMPLATE_LANGUAGE ||
      env.ZOKO_TEMPLATE_LANGUAGE ||
      "French"
    ).trim(),
    templateArgs: [
      appointment.customerName || "-",
      when.time || "-"
    ]
  };
  const language = String(
    env.ZOKO_APPOINTMENT_DESIGNER_REMINDER_LANGUAGE ||
    env.ZOKO_APPOINTMENT_TEMPLATE_LANGUAGE ||
    env.ZOKO_TEMPLATE_LANGUAGE ||
    "French"
  ).trim();
  const sent = await sendZokoTemplate(
    payload,
    templateName,
    language
  );
  return {
    ok: sent.ok,
    status: sent.status || 0,
    error: sent.error,
    providerResponse: sent.providerResponse || null,
    usedTemplate: sent.usedTemplate,
    usedLanguage: sent.usedLanguage
  };
}

export async function runAppointmentsReminderTick(): Promise<void> {
  if (!env.ZOKO_API_URL || !env.ZOKO_AUTH_TOKEN) return;
  const untilIso = new Date(Date.now() + 24 * 60 * 60 * 1000 + 10 * 60 * 1000).toISOString();
  const candidates = await listReminderCandidates(untilIso, 800);
  if (!candidates.length) return;

  const nowDate = new Date();
  const nowMs = nowDate.getTime();
  for (const row of candidates) {
    if (row.reminderDesignerEnabled && !row.reminderDesignerSentAt && isDesignerReminderDueAtMorning(row.appointmentAt, nowDate)) {
      const designerSent = await sendDesignerReminderTemplate({
        id: row.id,
        customerName: row.customerName,
        customerPhone: row.customerPhone,
        appointmentAt: row.appointmentAt,
        location: row.location
      });
      if (designerSent.ok) {
        const sentAtIso = new Date().toISOString();
        await markDesignerReminderSent(row.shop, row.id, sentAtIso);
        await addAppointmentMessage({
          appointmentId: row.id,
          shop: row.shop,
          direction: "outbound",
          channel: "whatsapp",
          messageType: "designer_reminder_830",
          templateName:
            designerSent.usedTemplate || String(env.ZOKO_APPOINTMENT_DESIGNER_REMINDER_TEMPLATE_NAME || "").trim(),
          payload: {
            recipient: normalizePhoneForApi(String(env.ZOKO_APPOINTMENT_DESIGNER_REMINDER_PHONE || "")),
            provider: designerSent.providerResponse || null
          },
          providerStatus: "sent",
          sentAt: sentAtIso
        });
      } else {
        console.warn(`[appointments] designer reminder failed for ${row.id}: ${designerSent.error || "unknown error"}`);
      }
    }

    const dueKind = reminderKindDue(row.appointmentAt, nowMs);
    if (!dueKind) continue;
    if (dueKind === "d1" && (!row.reminderD1Enabled || row.reminderD1SentAt)) continue;
    if (dueKind === "h3" && (!row.reminderH3Enabled || row.reminderH3SentAt)) continue;
    const sent = await sendAppointmentTemplate({ appointment: row, action: "reminder" });
    if (!sent.ok) {
      console.warn(`[appointments] reminder ${dueKind} failed for ${row.id}: ${sent.error || "unknown error"}`);
      continue;
    }
    const sentAtIso = new Date().toISOString();
    await markReminderSent(row.shop, row.id, dueKind, sentAtIso);
    await addAppointmentMessage({
      appointmentId: row.id,
      shop: row.shop,
      direction: "outbound",
      channel: "whatsapp",
      messageType: dueKind === "d1" ? "reminder_d1" : "reminder_h3",
      templateName: sent.usedTemplate || appointmentActionTemplateName("reminder"),
      payload: sent.providerResponse || null,
      providerStatus: "sent",
      sentAt: sentAtIso
    });
  }
}

let appointmentsReminderWorkerStarted = false;
export function startAppointmentsReminderWorker(): void {
  if (appointmentsReminderWorkerStarted) return;
  appointmentsReminderWorkerStarted = true;
  const intervalMs = 5 * 60 * 1000;
  void runAppointmentsReminderTick().catch((error) => {
    console.error("[appointments] reminder tick failed at startup", error);
  });
  setInterval(() => {
    void runAppointmentsReminderTick().catch((error) => {
      console.error("[appointments] reminder tick failed", error);
    });
  }, intervalMs);
  console.log("[appointments] reminder worker started (every 5 minutes)");
}

async function syncAppointmentsMetafieldForShop(shop: string): Promise<void> {
  try {
    const rows = await listAppointmentsForMetafield(shop, 200);
    const result = await syncAppointmentsMetafield(shop, rows);
    if (!result.ok) {
      console.error(`[appointments] Shopify metafield sync failed for ${shop}: ${result.error || "unknown error"}`);
      return;
    }
    console.log(`[appointments] Shopify metafield synced for ${shop} (${rows.length} appointments).`);
  } catch (error) {
    console.error(`[appointments] Unexpected Shopify metafield sync error for ${shop}`, error);
  }
}

function signInvoiceLink(orderId: string, exp: string, template: string): string {
  return createHmac("sha256", env.SHOPIFY_API_SECRET).update(`${orderId}:${exp}:${template}`).digest("hex");
}

function formatInvoiceMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: currency || "MAD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(Number(amount || 0));
}

function escapeInvoiceHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function paymentStatusEn(status: string, outstanding: number): string {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "paid" || Number(outstanding || 0) <= 0) return "Paid";
  if (normalized === "partially_paid") return "Partially Paid";
  return "Pending";
}

function invoiceTitleByTemplate(template: string): string {
  if (template === "coin") return "Facture - Coin de Couture";
  if (template === "showroom_receipt") return "Showroom Receipt";
  if (template === "international_invoice") return "International Couture Invoice";
  return "Facture";
}

function invoiceDocumentLabel(template: string): string {
  if (template === "showroom_receipt") return "reçu";
  if (template === "international_invoice") return "facture internationale";
  if (template === "coin") return "facture Coin de Couture";
  return "facture";
}

function buildPublicInvoiceHtml(orderId: string, template: string) {
  const order = getOrderById(orderId);
  if (!order) return null;

  const created = new Date(order.createdAt);
  const createdLabel = Number.isNaN(created.getTime())
    ? String(order.createdAt || "")
    : created.toLocaleString("fr-FR", { dateStyle: "long", timeStyle: "short" });
  const lineRows = order.articles
    .map((article) => {
      const amount = Number(article.unitPrice || 0) * Number(article.quantity || 0);
      return `<tr>
        <td>${escapeInvoiceHtml(article.quantity)}</td>
        <td>${escapeInvoiceHtml(article.title)}</td>
        <td class="r">${escapeInvoiceHtml(formatInvoiceMoney(amount, order.currency))}</td>
      </tr>`;
    })
    .join("");
  const subtotalAmount = Number(order.subtotalAmount ?? order.totalAmount ?? 0);
  const discountAmount = Math.max(0, Number(order.discountAmount ?? 0));

  const headerName = template === "coin" ? "COIN DE COUTURE" : "MAISON BOUCHRA FILALI LAHLOU";
  const footerMeta =
    template === "coin"
      ? "Siège Social 19 ET 21 ROND POINT DES SPORTS QUARTIER RACINE, Casablanca · ICE 002031076000092 · RC 401313"
      : "Casablanca, Morocco · contact@bouchrafilalilahlou.com · www.bouchrafilalilahlou.com";

  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeInvoiceHtml(invoiceTitleByTemplate(template))} ${escapeInvoiceHtml(order.name)}</title>
  <style>
    @page { size: A4; margin: 12mm; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #111; font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif; background: #fff; }
    .page { width: 100%; max-width: 820px; margin: 0 auto; }
    .brand { text-align: center; margin-bottom: 18px; }
    .brand h1 { margin: 0; font-size: 24px; letter-spacing: .06em; font-family: Georgia, "Times New Roman", serif; }
    .brand p { margin: 6px 0 0; color: #5d636b; font-size: 12px; }
    .title { text-align: center; font-size: 13px; text-transform: uppercase; letter-spacing: .08em; margin: 14px 0 18px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px; }
    .card { border: 1px solid #e7e7e7; border-radius: 10px; padding: 12px; break-inside: avoid; }
    .card h3 { margin: 0 0 8px; font-size: 12px; text-transform: uppercase; color: #666; letter-spacing: .07em; }
    .kv { display: grid; grid-template-columns: 38% 62%; gap: 4px; font-size: 12.5px; }
    .k { color: #666; }
    .v { font-weight: 600; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 13px; }
    th, td { border-bottom: 1px solid #ececec; padding: 8px 6px; text-align: left; vertical-align: top; }
    th { color: #666; text-transform: uppercase; font-size: 11px; letter-spacing: .07em; }
    .r { text-align: right; }
    .totals { max-width: 360px; margin-left: auto; margin-top: 12px; border: 1px solid #ececec; border-radius: 10px; padding: 10px; }
    .totals-row { display: flex; justify-content: space-between; gap: 10px; padding: 4px 0; font-size: 13px; }
    .totals-row strong { font-size: 16px; }
    .note { margin-top: 12px; color: #666; font-size: 12px; }
  </style>
</head>
<body>
  <div class="page">
    <div class="brand">
      <h1>${escapeInvoiceHtml(headerName)}</h1>
      <p>${escapeInvoiceHtml(footerMeta)}</p>
    </div>
    <div class="title">${escapeInvoiceHtml(invoiceTitleByTemplate(template))}</div>
    <div class="grid">
      <div class="card">
        <h3>Commande</h3>
        <div class="kv"><div class="k">N°</div><div class="v">${escapeInvoiceHtml(order.name)}</div></div>
        <div class="kv"><div class="k">Date</div><div class="v">${escapeInvoiceHtml(createdLabel)}</div></div>
        <div class="kv"><div class="k">Statut</div><div class="v">${escapeInvoiceHtml(paymentStatusEn(order.financialStatus, order.outstandingAmount || 0))}</div></div>
        <div class="kv"><div class="k">Passerelle</div><div class="v">${escapeInvoiceHtml(order.paymentGateway || "-")}</div></div>
      </div>
      <div class="card">
        <h3>Client</h3>
        <div class="kv"><div class="k">Nom</div><div class="v">${escapeInvoiceHtml(order.customerLabel || "-")}</div></div>
        <div class="kv"><div class="k">Téléphone</div><div class="v">${escapeInvoiceHtml(order.customerPhone || "-")}</div></div>
        ${order.customerEmail ? `<div class="kv"><div class="k">Email</div><div class="v">${escapeInvoiceHtml(order.customerEmail)}</div></div>` : ""}
        ${order.shippingAddress ? `<div class="kv"><div class="k">Adresse</div><div class="v">${escapeInvoiceHtml(order.shippingAddress)}</div></div>` : ""}
      </div>
    </div>
    <table>
      <thead><tr><th style="width:70px">Qté</th><th>Article</th><th class="r" style="width:190px">Montant</th></tr></thead>
      <tbody>
        ${lineRows}
      </tbody>
    </table>
    <div class="totals">
      <div class="totals-row"><span>Sous-total</span><span>${escapeInvoiceHtml(formatInvoiceMoney(subtotalAmount, order.currency))}</span></div>
      ${discountAmount > 0 ? `<div class="totals-row"><span>Remise</span><span>- ${escapeInvoiceHtml(formatInvoiceMoney(discountAmount, order.currency))}</span></div>` : ""}
      <div class="totals-row"><span>Total</span><span>${escapeInvoiceHtml(formatInvoiceMoney(order.totalAmount || 0, order.currency))}</span></div>
      <div class="totals-row"><span>Solde restant</span><span>${escapeInvoiceHtml(order.outstandingAmount > 0 ? formatInvoiceMoney(order.outstandingAmount, order.currency) : "-")}</span></div>
      <div class="totals-row"><strong>À encaisser</strong><strong>${escapeInvoiceHtml(formatInvoiceMoney(order.outstandingAmount || 0, order.currency))}</strong></div>
    </div>
    <p class="note">Document généré automatiquement par l’application.</p>
  </div>
</body>
</html>`;
}

function replaceTemplatePlaceholders(input: unknown, map: Record<string, string>): unknown {
  if (typeof input === "string") {
    return input.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, key) => map[key] ?? "");
  }
  if (Array.isArray(input)) {
    return input.map((item) => replaceTemplatePlaceholders(item, map));
  }
  if (input && typeof input === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      result[k] = replaceTemplatePlaceholders(v, map);
    }
    return result;
  }
  return input;
}

async function sendZokoTemplate(
  payload: unknown,
  configuredTemplateName: string,
  configuredTemplateLanguage: string
): Promise<{
  ok: boolean;
  status?: number;
  providerResponse?: unknown;
  usedTemplate?: string;
  usedLanguage?: string;
  usedType?: string;
  attempts?: { templates: string[]; languages: string[]; types: string[] };
  error?: string;
}> {
  const apiUrl = String(env.ZOKO_SEND_TEMPLATE_API_URL || env.ZOKO_API_URL || "").trim();
  const authHeader = String(env.ZOKO_AUTH_HEADER || "apikey").trim();
  const authPrefix = String(env.ZOKO_AUTH_PREFIX || "").trim();
  const tokenValue = authPrefix ? `${authPrefix} ${env.ZOKO_AUTH_TOKEN}` : env.ZOKO_AUTH_TOKEN;

  if (!apiUrl || !String(tokenValue || "").trim()) {
    return { ok: false, error: "Configuration API Zoko manquante." };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);
  try {
    const templateNameCandidates = Array.from(new Set([configuredTemplateName].filter(Boolean)));
    const rawLanguage = String(configuredTemplateLanguage || "").trim();
    const frVariants =
      rawLanguage.toLowerCase() === "fr" || rawLanguage.toLowerCase() === "french"
        ? ["fr", "French", "french"]
        : [];
    const languageCandidates = Array.from(new Set([rawLanguage, rawLanguage.toLowerCase(), ...frVariants].filter(Boolean)));
    const baseType =
      payload && typeof payload === "object" && !Array.isArray(payload) ? String((payload as Record<string, unknown>).type || "") : "";
    const typeCandidates = Array.from(new Set([baseType, "buttonTemplate", "richTemplate", "template"].filter(Boolean)));

    let lastStatus = 0;
    let lastProviderResponse: unknown = null;

    for (const candidateTemplate of templateNameCandidates) {
      for (const candidateLanguage of languageCandidates) {
        for (const candidateType of typeCandidates) {
          const payloadObj =
            payload && typeof payload === "object" && !Array.isArray(payload)
              ? {
                  ...(payload as Record<string, unknown>),
                  type: candidateType,
                  templateId: candidateTemplate,
                  templateLanguage: candidateLanguage
                }
              : payload;

          const apiRes = await fetch(apiUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              [authHeader]: tokenValue as string
            },
            body: JSON.stringify(payloadObj),
            signal: controller.signal
          });

          const raw = await apiRes.text();
          let json: unknown = null;
          try {
            json = JSON.parse(raw);
          } catch {
            json = { raw };
          }

          if (apiRes.ok) {
            return {
              ok: true,
              providerResponse: json,
              usedTemplate: candidateTemplate,
              usedLanguage: candidateLanguage,
              usedType: candidateType
            };
          }

          lastStatus = apiRes.status;
          lastProviderResponse = json;
        }
      }
    }

    return {
      ok: false,
      status: lastStatus,
      providerResponse: lastProviderResponse,
      attempts: {
        templates: templateNameCandidates,
        languages: languageCandidates,
        types: typeCandidates
      },
      error: "Envoi template API échoué."
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur réseau API";
    return { ok: false, error: message };
  } finally {
    clearTimeout(timeoutId);
  }
}

adminRouter.get(["/", "/orders"], (req, res) => {
  const host = typeof req.query.host === "string" ? req.query.host : String(req.query.host ?? "");
  const shop = typeof req.query.shop === "string" ? req.query.shop : String(req.query.shop ?? "");
  const embedded =
    typeof req.query.embedded === "string" ? req.query.embedded : String(req.query.embedded ?? "");
  const navParams = new URLSearchParams();
  if (host) navParams.set("host", host);
  if (shop) navParams.set("shop", shop);
  if (embedded) navParams.set("embedded", embedded);
  const navSuffix = navParams.toString() ? `?${navParams.toString()}` : "";

  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="shopify-api-key" content="${env.SHOPIFY_API_KEY}" />
  <title>Panneau Commandes Shopify</title>
  <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
  <style>
    :root {
      --bg: #f6f6f7;
      --panel: #ffffff;
      --text: #202223;
      --muted: #6d7175;
      --accent: #008060;
      --accent-strong: #006e52;
      --gold: #b98900;
      --border: #e1e3e5;
      --panel-strong: #ffffff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    .wrap {
      max-width: 1560px;
      margin: 18px auto;
      padding: 0 12px 20px;
    }
    .top-header {
      display: block;
      margin-bottom: 4px;
    }
    h1 {
      margin: 0;
      font-size: 32px;
      font-weight: 700;
    }
    .intro {
      margin: -4px 0 14px;
      color: #5c5f62;
      font-size: 14px;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 18px;
      margin-bottom: 16px;
      box-shadow: 0 1px 0 rgba(0, 0, 0, 0.04);
    }
    .kpi-row {
      margin: 12px 0 14px;
    }
    .kpi-layout {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      align-items: stretch;
      gap: 12px;
    }
    .kpi-middle {
      display: grid;
      grid-template-columns: 1fr;
      grid-template-rows: auto auto;
      gap: 12px;
      height: 100%;
      align-content: space-between;
    }
    .kpi-stack {
      display: grid;
      grid-template-columns: 1fr;
      grid-template-rows: auto auto auto;
      gap: 12px;
      height: 100%;
      align-content: space-between;
    }
    .kpi {
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 16px;
      background:
        linear-gradient(180deg, #ffffff 0%, #fbfbfb 100%);
      box-shadow: none;
    }
    .kpi.multi-currency .kpi-value.small {
      font-size: 36px;
      line-height: 1;
    }
    .kpi.multi-currency .kpi-break-item {
      font-size: 14px;
      padding: 5px 12px;
    }
    .kpi-title {
      color: #6d7175;
      font-size: 11px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      font-weight: 700;
    }
    .kpi-value {
      margin-top: 8px;
      font-size: 34px;
      font-weight: 700;
      line-height: 0.95;
      letter-spacing: -0.02em;
      color: #202223;
      font-variant-numeric: tabular-nums;
    }
    .kpi-value.small {
      font-size: 30px;
    }
    .kpi-sub {
      margin-top: 10px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
      white-space: normal;
      display: grid;
      gap: 6px;
    }
    .kpi-orders-split {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      align-items: stretch;
    }
    .kpi-orders-main {
      min-width: 0;
    }
    .kpi-orders-insights {
      min-width: 0;
      border-left: 1px solid #eceef0;
      padding-left: 12px;
    }
    .kpi-insight-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 8px;
    }
    .kpi-insight-item {
      border: 1px solid #eceef0;
      border-radius: 8px;
      background: #fff;
      padding: 9px 10px;
      min-height: 0;
    }
    .kpi-insight-title {
      color: #6d7175;
      font-size: 10px;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      font-weight: 700;
    }
    .kpi-insight-value {
      margin-top: 4px;
      font-size: 21px;
      line-height: 1.05;
      font-weight: 700;
      color: #202223;
      font-variant-numeric: tabular-nums;
    }
    .kpi-insight-sub {
      margin-top: 4px;
      color: #7a8086;
      font-size: 11px;
      line-height: 1.25;
    }
    .kpi-dual-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .kpi-dual-item {
      border: 1px solid #eceef0;
      border-radius: 8px;
      background: #fff;
      padding: 10px;
      min-width: 0;
    }
    .kpi-dual-title {
      color: #6d7175;
      font-size: 10px;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      font-weight: 700;
    }
    .kpi-dual-value {
      margin-top: 6px;
      font-size: 22px;
      line-height: 1;
      font-weight: 700;
      color: #202223;
      font-variant-numeric: tabular-nums;
    }
    .kpi-dual-sub {
      margin-top: 5px;
      color: #7a8086;
      font-size: 11px;
      line-height: 1.25;
    }
    .kpi-chart {
      margin-top: 10px;
      height: 220px;
      border-radius: 8px;
      background: transparent;
      border: 1px solid #eceef0;
      overflow: visible;
      position: relative;
    }
    .kpi-chart-toggles {
      margin-top: 10px;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0;
      width: 40%;
      border: 1px solid #e1e3e5;
      border-radius: 10px;
      overflow: hidden;
    }
    .kpi-chart-toggle {
      display: grid;
      gap: 10px;
      padding: 8px 10px;
      background: #f2f3f5;
      color: #5b6168;
      border-right: 1px solid #e1e3e5;
      user-select: none;
      cursor: pointer;
      transition: background 0.15s ease, color 0.15s ease;
    }
    .kpi-chart-toggle:last-child {
      border-right: 0;
    }
    .kpi-chart-toggle.active {
      color: #f8ffff;
    }
    .kpi-chart-toggle.revenue.active {
      background: #008060;
    }
    .kpi-chart-toggle.score.active {
      background: #f08a24;
    }
    .kpi-chart-toggle-head {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      font-weight: 600;
      line-height: 1.2;
    }
    .kpi-chart-toggle input[type="checkbox"] {
      width: auto;
      margin: 0;
      accent-color: currentColor;
      cursor: pointer;
    }
    .kpi-chart-toggle-state {
      font-size: 11px;
      opacity: 0.9;
      letter-spacing: 0.01em;
    }
    .kpi-chart svg {
      width: 100%;
      height: 100%;
      display: block;
    }
    .kpi-chart-tooltip {
      position: absolute;
      transform: translate(-50%, calc(-100% - 10px));
      pointer-events: none;
      background: #fff;
      border: 1px solid #d7d9dc;
      border-radius: 8px;
      padding: 8px 10px;
      box-shadow: 0 10px 20px rgba(0, 0, 0, 0.14);
      font-size: 13px;
      color: #202223;
      min-width: 140px;
      z-index: 2;
      display: none;
    }
    .kpi-chart-tooltip .date {
      color: #6d7175;
      margin-bottom: 2px;
    }
    .kpi-chart-tooltip .title {
      font-weight: 700;
      margin-bottom: 6px;
    }
    .kpi-chart-tooltip .meta {
      display: flex;
      align-items: center;
      gap: 6px;
      color: #6d7175;
      margin-bottom: 6px;
    }
    .kpi-chart-tooltip .dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: #008060;
      display: inline-block;
      flex: 0 0 9px;
    }
    .kpi-chart-tooltip .amount {
      background: #f1f2f3;
      border-radius: 6px;
      padding: 2px 8px;
      font-weight: 700;
      font-size: 13px;
      display: inline-block;
    }
    .kpi-chart-tooltip.flip {
      transform: translate(-50%, 10px);
    }
    .rev-score-scale {
      position: absolute;
      right: 6px;
      top: 8px;
      bottom: 8px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      pointer-events: none;
      color: #f08a24;
      font-size: 10px;
      font-weight: 700;
      line-height: 1;
      opacity: 0.9;
    }
    .kpi-break-item {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      border: 1px solid #e4e5e7;
      padding: 4px 10px;
      background: #ffffff;
      color: #4a4e52;
      width: fit-content;
      font-weight: 600;
      font-size: 12px;
    }
    .kpi-muted {
      color: #8c9196;
      font-weight: 600;
      font-size: 12px;
    }
    h2 {
      margin: 0 0 12px;
      font-size: 24px;
      font-weight: 700;
    }
    .line {
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
    }
    .status {
      color: var(--muted);
      font-size: 13px;
    }
    .sync-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
      margin: 12px 0 16px;
    }
    .sync-grid .full-span {
      grid-column: 1 / -1;
    }
    .period-horizon {
      margin-top: 10px;
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .period-horizon-label {
      font-size: 13px;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #6b7280;
    }
    .period-horizon-btn {
      border: 1px solid #d0d5dd;
      border-radius: 999px;
      background: #f9fafb;
      color: #344054;
      font-weight: 700;
      font-size: 14px;
      min-height: 42px;
      padding: 0 16px;
      box-shadow: none;
      transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
    }
    .period-horizon-btn:hover {
      background: #f2f4f7;
      border-color: #c8ced6;
    }
    .period-horizon-btn.active {
      background: #e9efff;
      border-color: #9cb3ff;
      color: #1d4ed8;
    }
    .period-horizon-btn:active {
      transform: none;
      box-shadow: none;
    }
    label {
      display: block;
      margin-bottom: 6px;
      color: var(--muted);
      font-size: 13px;
    }
    input, select {
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px;
      font-size: 14px;
      background: #fff;
    }
    button, a.button {
      border: 1px solid #5e656d;
      border-radius: 12px;
      background: linear-gradient(180deg, #3d434b 0%, #23282f 100%);
      color: #fff;
      padding: 0 18px;
      cursor: pointer;
      font-weight: 700;
      letter-spacing: 0.01em;
      font-size: 14px;
      line-height: 1;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 32px;
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.16),
        0 1px 0 rgba(0, 0, 0, 0.45);
      transition: background 0.15s ease, box-shadow 0.15s ease, transform 0.05s ease;
    }
    button:hover, a.button:hover {
      background: linear-gradient(180deg, #444b54 0%, #2a3038 100%);
    }
    button:active, a.button:active {
      background: linear-gradient(180deg, #20242a 0%, #171a1f 100%);
      box-shadow:
        inset 0 2px 4px rgba(0, 0, 0, 0.5),
        0 1px 0 rgba(255, 255, 255, 0.08);
      transform: translateY(1px);
    }
    .queue-grid {
      display: grid;
      grid-template-columns: 1.35fr 0.95fr;
      gap: 14px;
    }
    .orders-list {
      border: 1px solid var(--border);
      border-radius: 10px;
      max-height: 56vh;
      overflow: auto;
      background: #fff;
    }
    .deliveries-box {
      margin-top: 12px;
    }
    .deliveries-box h3 {
      margin: 0 0 8px;
      font-size: 15px;
    }
    .orders-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
      min-width: 960px;
    }
    .orders-table thead th {
      text-align: left;
      color: var(--muted);
      font-size: 12px;
      font-weight: 600;
      padding: 10px;
      border-bottom: 1px solid var(--border);
      background: #f6f6f7;
      position: sticky;
      top: 0;
      z-index: 1;
    }
    .orders-table td {
      padding: 10px;
      border-bottom: 1px solid var(--border);
      vertical-align: middle;
      background: #fff;
    }
    .orders-table tr {
      cursor: pointer;
    }
    .orders-table tr:hover td {
      background: #f8f9fa;
    }
    .orders-table tr.active-row td {
      background: #f1f8f5;
    }
    .customer-main {
      font-weight: 600;
    }
    .customer-sub {
      color: var(--muted);
      font-size: 12px;
      margin-top: 2px;
    }
    .pill {
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 12px;
      background: #e4e5e7;
      color: #3f4246;
      display: inline-block;
    }
    .pill.partial {
      background: #f8dca8;
      color: #6b4500;
    }
    .pill.shipped {
      background: #dff3e0;
      color: #207a3c;
    }
    .detail-box {
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 14px;
      min-height: 56vh;
      background: var(--panel-strong);
      position: sticky;
      top: 12px;
    }
    .order-shell {
      display: grid;
      grid-template-columns: 1fr;
      gap: 12px;
    }
    .order-card {
      border: 1px solid var(--border);
      border-radius: 12px;
      background: #fff;
      padding: 12px;
      margin-bottom: 10px;
    }
    .order-card h4 {
      margin: 0 0 8px;
      font-size: 18px;
    }
    .order-meta-row {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
      margin-bottom: 8px;
    }
    .tag-soft {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 4px 10px;
      background: #f6f6f7;
      border: 1px solid var(--border);
      font-size: 12px;
      font-weight: 600;
      color: #44474b;
    }
    .badge-status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      border-radius: 999px;
      padding: 6px 14px;
      border: 1px solid #dadde0;
      background: #f2f3f5;
      color: #4a4d52;
      font-size: 12px;
      font-weight: 600;
      line-height: 1;
    }
    .badge-icon {
      font-size: 13px;
      line-height: 1;
      opacity: 0.9;
    }
    .badge-status.paid {
      background: #ededee;
      border-color: #e1e3e5;
      color: #4d5156;
    }
    .badge-status.partial {
      background: #f8d79d;
      border-color: #f0c67a;
      color: #6c4a00;
    }
    .badge-status.pending {
      background: #fff3cd;
      border-color: #f7dd8f;
      color: #6d5600;
    }
    .badge-status.unfulfilled {
      background: #f7e7a3;
      border-color: #ebd270;
      color: #695300;
    }
    .badge-status.fulfilled {
      background: #dff3e0;
      border-color: #c5e8c8;
      color: #1f6b36;
    }
    .badge-status.gateway {
      background: #eef6f3;
      border-color: #cfe6dd;
      color: #1f5f4c;
      font-weight: 600;
    }
    .tag-soft.gateway {
      background: #eef6f3;
      border-color: #cfe6dd;
      color: #1f5f4c;
    }
    .order-calendar {
      margin-top: 6px;
      display: grid;
      gap: 8px;
    }
    .calendar-item {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px;
      background: #fff;
      font-size: 13px;
    }
    .calendar-time {
      color: #6b6f73;
      font-weight: 600;
      min-width: 54px;
      text-align: right;
    }
    .client-line {
      margin: 0 0 8px;
      color: #2e3033;
      font-size: 15px;
    }
    .info-list {
      display: grid;
      gap: 8px;
      margin-top: 6px;
    }
    .info-item {
      display: grid;
      gap: 2px;
      padding: 8px 10px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: #fff;
    }
    .info-label {
      color: #6b6f73;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.01em;
    }
    .info-value {
      color: #222426;
      font-size: 15px;
      font-weight: 600;
      line-height: 1.3;
      word-break: break-word;
    }
    .payment-detail-table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 4px;
      font-size: 13px;
      font-weight: 500;
    }
    .payment-detail-table td {
      border-bottom: 1px solid #eceef0;
      padding: 6px 8px;
      text-align: left;
      vertical-align: top;
    }
    .payment-detail-table td.d {
      color: #6b6f73;
      white-space: nowrap;
    }
    .payment-detail-table td.r {
      text-align: right;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .detail-title-row {
      margin-bottom: 6px;
    }
    .detail-title-row strong {
      font-size: 24px;
      font-family: "Didot", "Bodoni MT", "Times New Roman", serif;
      letter-spacing: 0.01em;
    }
    .detail-empty {
      color: var(--muted);
      font-size: 14px;
    }
    .detail-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-bottom: 10px;
    }
    .articles {
      margin-top: 10px;
      display: grid;
      gap: 8px;
    }
    .article-row {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px;
      display: grid;
      grid-template-columns: 1fr 130px;
      gap: 8px;
      align-items: center;
    }
    .article-title {
      font-size: 14px;
    }
    .save-order-btn {
      margin-top: 12px;
    }
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(23, 26, 31, 0.55);
      z-index: 1000;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
    }
    .modal-card {
      width: min(760px, 100%);
      max-height: 85vh;
      overflow: auto;
      background: #fff;
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 16px;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.25);
    }
    .modal-title {
      margin: 0 0 8px;
      font-size: 22px;
      font-weight: 700;
    }
    .modal-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-top: 10px;
    }
    .modal-help {
      margin-top: 8px;
      color: #6d7175;
      font-size: 13px;
    }
    .template-toggle-row {
      display: flex;
      gap: 8px;
      margin-top: 10px;
      flex-wrap: wrap;
    }
    .template-toggle-btn {
      border: 1px solid #c7c9cc;
      border-radius: 10px;
      background: #fff;
      color: #202223;
      min-height: 42px;
      padding: 0 16px;
      font-weight: 600;
      font-size: 15px;
      cursor: pointer;
      transition: transform 140ms ease, background 140ms ease, color 140ms ease, border-color 140ms ease, box-shadow 140ms ease;
    }
    .template-toggle-btn:hover {
      border-color: #202223;
      box-shadow: 0 1px 0 rgba(32, 34, 35, 0.08);
    }
    .template-toggle-btn:active {
      transform: translateY(1px) scale(0.99);
    }
    .template-toggle-btn.active {
      background: #202223;
      color: #fff;
      border-color: #202223;
    }
    .modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 14px;
    }
    .modal-preview-wrap {
      margin-top: 12px;
      border: 1px solid #d9dadd;
      border-radius: 12px;
      background: #f6f6f7;
      padding: 10px;
    }
    .modal-preview-head {
      font-size: 13px;
      font-weight: 600;
      color: #4a4f54;
      margin-bottom: 8px;
    }
    .modal-preview-frame {
      width: 100%;
      min-height: 70vh;
      border: 1px solid #e1e3e5;
      border-radius: 10px;
      background: #fff;
    }
    .btn-secondary {
      border: 1px solid #c7c9cc;
      border-radius: 10px;
      background: #fff;
      color: #202223;
      min-height: 42px;
      padding: 0 16px;
      font-weight: 600;
      font-size: 15px;
      box-shadow: none;
    }
    .hidden {
      display: none;
    }
    @media (max-width: 980px) {
      .sync-grid { grid-template-columns: 1fr; }
      .queue-grid { grid-template-columns: 1fr; }
      .kpi-layout { grid-template-columns: 1fr; }
      .kpi-orders-split { grid-template-columns: 1fr; gap: 10px; }
      .kpi-orders-insights { border-left: 0; border-top: 1px solid #eceef0; padding-left: 0; padding-top: 10px; }
      .kpi-chart-toggles { grid-template-columns: 1fr; width: 100%; }
      .kpi-chart-toggle { border-right: 0; border-bottom: 1px solid #e1e3e5; }
      .kpi-chart-toggle:last-child { border-bottom: 0; }
      .kpi-dual-grid { grid-template-columns: 1fr; }
      .detail-grid { grid-template-columns: 1fr; }
      .modal-grid { grid-template-columns: 1fr; }
      .article-row { grid-template-columns: 1fr; }
      .detail-box { position: static; min-height: 280px; }
      .order-shell { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top-header">
      <h1>Panneau de gestion des commandes</h1>
    </div>
    <ui-nav-menu>
      <a href="/admin${navSuffix}">Commandes</a>
      <a href="/admin/invoices${navSuffix}">Factures</a>
      <a href="/admin/insights${navSuffix}">Insights</a>
      <a href="/admin/appointments${navSuffix}">Rendez-vous</a>
      <a href="/admin/forecast${navSuffix}">Forecast</a>
      <a href="/admin/ml${navSuffix}">ML Dashboard</a>
      <a href="/admin/priority${navSuffix}">Priority</a>
      <a href="/blueprint${navSuffix}">Blueprint</a>
      <a href="/admin/spline${navSuffix}">Spline</a>
      <a href="/admin/whatsapp-intelligence${navSuffix}">WhatsApp Intelligence</a>
    </ui-nav-menu>
    <p class="intro">Maison Bouchra Filali Lahlou · suivi raffiné des commandes et livraisons</p>

    <section class="card">
      <h2>Commandes</h2>
      <div class="line">
        <span class="status">Mode direct: la synchronisation utilise vos identifiants .env.</span>
        <span id="syncStatus" class="status"></span>
      </div>
      <div class="kpi-row">
        <div class="kpi-layout">
          <div class="kpi">
            <div class="kpi-title">Total chiffre d'affaires</div>
            <div id="kpiRevenueTotal" class="kpi-value small">0</div>
            <div id="kpiRevenueBreakdown" class="kpi-sub"><span class="kpi-muted">-</span></div>
            <div class="kpi-chart-toggles">
              <label id="toggleRevenueCurveCard" class="kpi-chart-toggle revenue active">
                <span class="kpi-chart-toggle-head">
                  <input id="toggleRevenueCurve" type="checkbox" checked />
                </span>
                <span id="toggleRevenueCurveState" class="kpi-chart-toggle-state">CA</span>
              </label>
              <label id="toggleScoreCurveCard" class="kpi-chart-toggle score active">
                <span class="kpi-chart-toggle-head">
                  <input id="toggleScoreCurve" type="checkbox" checked />
                </span>
                <span id="toggleScoreCurveState" class="kpi-chart-toggle-state">Score</span>
              </label>
            </div>
            <div id="kpiRevenueChart" class="kpi-chart"></div>
          </div>
          <div class="kpi-middle">
            <div class="kpi">
              <div class="kpi-orders-split">
                <div class="kpi-orders-main">
                  <div class="kpi-title">Nombre de commandes</div>
                  <div id="kpiOrdersCount" class="kpi-value">0</div>
                  <div id="kpiArticlesSummary" class="kpi-sub"><span class="kpi-muted">-</span></div>
                </div>
                <div class="kpi-orders-insights">
                  <div class="kpi-insight-grid">
                    <div class="kpi-insight-item">
                      <div class="kpi-insight-title">Panier moyen</div>
                      <div id="kpiInsightAov" class="kpi-insight-value">0</div>
                      <div id="kpiInsightAovSub" class="kpi-insight-sub">sur période chargée</div>
                    </div>
                    <div class="kpi-insight-item">
                      <div class="kpi-insight-title">Ventes en espèces</div>
                      <div id="kpiInsightRevenue" class="kpi-insight-value">0</div>
                      <div id="kpiInsightRevenueSub" class="kpi-insight-sub">sur période chargée</div>
                    </div>
                    <div class="kpi-insight-item">
                      <div class="kpi-insight-title">Taux clients récurrents</div>
                      <div id="kpiInsightRepeatRate" class="kpi-insight-value">0%</div>
                      <div id="kpiInsightRepeatRateSub" class="kpi-insight-sub">clients avec +1 commande</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div class="kpi">
              <div class="kpi-dual-grid">
                <div class="kpi-dual-item">
                  <div class="kpi-dual-title">Ventes en virements</div>
                  <div id="kpiTransferSales" class="kpi-dual-value">0</div>
                  <div id="kpiTransferSalesSub" class="kpi-dual-sub">sur période chargée</div>
                </div>
                <div class="kpi-dual-item">
                  <div class="kpi-dual-title">Vente en chéquier</div>
                  <div id="kpiChequeSales" class="kpi-dual-value">0</div>
                  <div id="kpiChequeSalesSub" class="kpi-dual-sub">sur période chargée</div>
                </div>
              </div>
            </div>
          </div>
          <div class="kpi-stack">
            <div class="kpi">
              <div class="kpi-title">Commandes avec solde restant</div>
              <div id="kpiUnpaid" class="kpi-value">0</div>
            </div>
            <div class="kpi">
              <div class="kpi-title">Total à encaisser</div>
              <div id="kpiUnpaidTotal" class="kpi-value small">0</div>
              <div id="kpiUnpaidBreakdown" class="kpi-sub"><span class="kpi-muted">-</span></div>
            </div>
            <div class="kpi">
              <div class="kpi-dual-grid">
                <div class="kpi-dual-item">
                  <div class="kpi-dual-title">Commandes en cours</div>
                  <div id="kpiInProgress" class="kpi-dual-value">0</div>
                </div>
                <div class="kpi-dual-item">
                  <div class="kpi-dual-title">Commandes livrées</div>
                  <div id="kpiShipped" class="kpi-dual-value">0</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="sync-grid">
        <div>
          <label for="presetRange">Période</label>
          <select id="presetRange">
            <option value="year">Année en cours</option>
            <option value="currentMonth">Mois en cours</option>
            <option value="today">Aujourd'hui</option>
            <option value="yesterday">Hier</option>
            <option value="last90">90 derniers jours</option>
            <option value="last30">30 derniers jours</option>
            <option value="last7">7 derniers jours</option>
            <option value="last365">365 derniers jours</option>
            <option value="last12m">12 derniers mois</option>
            <option value="lastMonth">Le mois dernier</option>
            <option value="lastWeek">La semaine dernière</option>
            <option value="custom">Personnalisé</option>
          </select>
          <div id="periodHorizonBar" class="period-horizon">
            <span class="period-horizon-label">Horizon</span>
            <button type="button" class="period-horizon-btn" data-period-preset="year">Année en cours</button>
            <button type="button" class="period-horizon-btn" data-period-preset="lastMonth">Mois dernier</button>
            <button type="button" class="period-horizon-btn" data-period-preset="currentMonth">Mois en cours</button>
          </div>
        </div>
        <div>
          <label for="syncFrom">Du</label>
          <input id="syncFrom" type="date" />
        </div>
        <div>
          <label for="syncTo">Au</label>
          <input id="syncTo" type="date" />
        </div>
        <div class="full-span">
          <label for="orderSearch">Recherche commandes</label>
          <input id="orderSearch" type="search" placeholder="Commande, client, téléphone, article, mode de paiement..." />
        </div>
      </div>
      <div class="queue-grid">
        <div>
          <div id="ordersList" class="orders-list"></div>
          <div class="deliveries-box">
            <h3>Livraisons par tour</h3>
            <div id="deliveryQueueList" class="orders-list"></div>
          </div>
        </div>
        <div class="detail-box">
          <div id="orderDetail" class="detail-empty">Sélectionnez une commande pour voir et mettre à jour son suivi.</div>
        </div>
      </div>
    </section>
  </div>

    <div id="bankDetailsModal" class="modal-backdrop hidden">
      <div class="modal-card">
        <h3 class="modal-title">Coordonnées bancaires bénéficiaire (facture)</h3>
        <div class="status">Choisissez le modèle de document puis complétez les champs à afficher.</div>
        <div style="margin-top:10px;">
          <label>Modèle de document</label>
          <div class="template-toggle-row">
            <button id="bankTemplateInvoiceBtn" type="button" class="template-toggle-btn">Facture</button>
            <button id="bankTemplateReceiptBtn" type="button" class="template-toggle-btn">Reçu</button>
          </div>
        </div>
        <div id="bankProfileGroup" class="modal-grid">
          <div>
            <label for="bankProfileType">Format du compte</label>
            <select id="bankProfileType">
              <option value="us">Compte US (Routing + Account)</option>
              <option value="ma">RIB Maroc</option>
              <option value="eu">IBAN FR/EU</option>
              <option value="other">Autre</option>
            </select>
          </div>
          <div>
            <label for="bankBeneficiaryName">Bénéficiaire (facture)</label>
            <input id="bankBeneficiaryName" type="text" />
          </div>
        </div>
        <div id="bankFieldsGroup">
          <div class="modal-grid">
            <div>
              <label id="bankNameLabel" for="bankNameInput">Banque</label>
              <input id="bankNameInput" type="text" />
            </div>
            <div>
              <label id="swiftLabel" for="swiftInput">SWIFT / BIC</label>
              <input id="swiftInput" type="text" />
            </div>
            <div>
              <label id="routingLabel" for="routingInput">Routing / ABA</label>
              <input id="routingInput" type="text" />
            </div>
            <div>
              <label id="accountLabel" for="accountInput">N° compte / IBAN / RIB</label>
              <input id="accountInput" type="text" />
            </div>
            <div>
              <label for="bankAddressInput">Adresse banque</label>
              <input id="bankAddressInput" type="text" />
            </div>
          </div>
          <div class="modal-grid">
            <div>
              <label for="referenceInput">Référence virement</label>
              <input id="referenceInput" type="text" />
            </div>
          </div>
        </div>
        <div id="bankProfileHelp" class="modal-help"></div>
        <div id="bankModalPreviewWrap" class="modal-preview-wrap hidden">
          <div id="bankModalPreviewHead" class="modal-preview-head">Aperçu du document</div>
          <iframe id="bankModalPreviewFrame" class="modal-preview-frame"></iframe>
        </div>
        <div class="modal-actions">
          <button id="bankModalCancelBtn" type="button" class="btn-secondary">Annuler</button>
          <button id="bankModalPreviewBtn" type="button" class="btn-secondary">Aperçu</button>
          <button id="bankModalConfirmBtn" type="button">Utiliser ce document</button>
        </div>
      </div>
    </div>

  <script>
    (() => {
      const apiKey = document.querySelector('meta[name="shopify-api-key"]')?.content || "";
      const host = new URLSearchParams(window.location.search).get("host") || "";
      const appBridge = window["app-bridge"];
      if (!apiKey || !host || !appBridge?.default) return;
      try {
        appBridge.default({ apiKey, host, forceRedirect: true });
      } catch (err) {
        console.warn("App Bridge init failed", err);
      }
    })();
  </script>
  <script>
    const syncFromEl = document.getElementById("syncFrom");
    const syncToEl = document.getElementById("syncTo");
    const presetRangeEl = document.getElementById("presetRange");
    const periodHorizonBarEl = document.getElementById("periodHorizonBar");
    const orderSearchEl = document.getElementById("orderSearch");
    const syncStatusEl = document.getElementById("syncStatus");
    const ordersListEl = document.getElementById("ordersList");
    const deliveryQueueListEl = document.getElementById("deliveryQueueList");
    const orderDetailEl = document.getElementById("orderDetail");
    const kpiRevenueTotalEl = document.getElementById("kpiRevenueTotal");
    const kpiRevenueBreakdownEl = document.getElementById("kpiRevenueBreakdown");
    const kpiRevenueChartEl = document.getElementById("kpiRevenueChart");
    const toggleRevenueCurveCardEl = document.getElementById("toggleRevenueCurveCard");
    const toggleScoreCurveCardEl = document.getElementById("toggleScoreCurveCard");
    const toggleRevenueCurveStateEl = document.getElementById("toggleRevenueCurveState");
    const toggleScoreCurveStateEl = document.getElementById("toggleScoreCurveState");
    const toggleRevenueCurveEl = document.getElementById("toggleRevenueCurve");
    const toggleScoreCurveEl = document.getElementById("toggleScoreCurve");
    const kpiRevenueCardEl = kpiRevenueTotalEl ? kpiRevenueTotalEl.closest(".kpi") : null;
    const kpiUnpaidTotalEl = document.getElementById("kpiUnpaidTotal");
    const kpiUnpaidBreakdownEl = document.getElementById("kpiUnpaidBreakdown");
    const kpiUnpaidCardEl = kpiUnpaidTotalEl ? kpiUnpaidTotalEl.closest(".kpi") : null;
    const kpiOrdersCountEl = document.getElementById("kpiOrdersCount");
    const kpiArticlesSummaryEl = document.getElementById("kpiArticlesSummary");
    const kpiInsightAovEl = document.getElementById("kpiInsightAov");
    const kpiInsightAovSubEl = document.getElementById("kpiInsightAovSub");
    const kpiInsightRevenueEl = document.getElementById("kpiInsightRevenue");
    const kpiInsightRevenueSubEl = document.getElementById("kpiInsightRevenueSub");
    const kpiInsightRepeatRateEl = document.getElementById("kpiInsightRepeatRate");
    const kpiInsightRepeatRateSubEl = document.getElementById("kpiInsightRepeatRateSub");
    const kpiTransferSalesEl = document.getElementById("kpiTransferSales");
    const kpiTransferSalesSubEl = document.getElementById("kpiTransferSalesSub");
    const kpiChequeSalesEl = document.getElementById("kpiChequeSales");
    const kpiChequeSalesSubEl = document.getElementById("kpiChequeSalesSub");
    const kpiInProgressEl = document.getElementById("kpiInProgress");
    const kpiUnpaidEl = document.getElementById("kpiUnpaid");
    const kpiShippedEl = document.getElementById("kpiShipped");
    const bankModalEl = document.getElementById("bankDetailsModal");
    const bankProfileTypeEl = document.getElementById("bankProfileType");
    const bankTemplateInvoiceBtn = document.getElementById("bankTemplateInvoiceBtn");
    const bankTemplateReceiptBtn = document.getElementById("bankTemplateReceiptBtn");
    const bankBeneficiaryNameEl = document.getElementById("bankBeneficiaryName");
    const bankNameInputEl = document.getElementById("bankNameInput");
    const swiftInputEl = document.getElementById("swiftInput");
    const routingInputEl = document.getElementById("routingInput");
    const accountInputEl = document.getElementById("accountInput");
    const bankAddressInputEl = document.getElementById("bankAddressInput");
    const referenceInputEl = document.getElementById("referenceInput");
    const bankNameLabelEl = document.getElementById("bankNameLabel");
    const swiftLabelEl = document.getElementById("swiftLabel");
    const routingLabelEl = document.getElementById("routingLabel");
    const accountLabelEl = document.getElementById("accountLabel");
    const bankProfileHelpEl = document.getElementById("bankProfileHelp");
    const bankModalCancelBtn = document.getElementById("bankModalCancelBtn");
    const bankModalPreviewBtn = document.getElementById("bankModalPreviewBtn");
    const bankModalConfirmBtn = document.getElementById("bankModalConfirmBtn");
    const bankModalPreviewWrap = document.getElementById("bankModalPreviewWrap");
    const bankModalPreviewHead = document.getElementById("bankModalPreviewHead");
    const bankModalPreviewFrame = document.getElementById("bankModalPreviewFrame");
    const bankProfileGroupEl = document.getElementById("bankProfileGroup");
    const bankFieldsGroupEl = document.getElementById("bankFieldsGroup");

    let orders = [];
    let selectedOrderId = null;
    let locationOptions = [];
    let syncDebounceTimer = null;
    let syncRunId = 0;
    let syncInFlight = false;
    let syncQueued = false;
    let invoicePreviewBlobUrl = "";
    let currentBankTemplateChoice = "classic";
    let currentBankNeedsDetails = false;
    let chartRangeFrom = "";
    let chartRangeTo = "";
    let orderSearchTerm = "";
    let showRevenueCurve = true;
    let showScoreCurve = true;
    const defaultLocationOptions = [
      "Showroom Massira - Casablanca, Maroc",
      "Showroom Triangle D'or - Casablanca, Maroc"
    ];

    function todayString() {
      return new Date().toISOString().slice(0, 10);
    }

    function daysAgoString(days) {
      const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      return d.toISOString().slice(0, 10);
    }

    function startOfYear() {
      const now = new Date();
      const start = new Date(now.getFullYear(), 0, 1);
      return start.toISOString().slice(0, 10);
    }

    function lastMonths(months) {
      const now = new Date();
      const past = new Date(now.getFullYear(), now.getMonth() - months, 1);
      return past.toISOString().slice(0, 10);
    }

    function startOfMonth() {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      return start.toISOString().slice(0, 10);
    }

    function syncPeriodHorizonUi(activePreset) {
      if (!periodHorizonBarEl) return;
      const btns = Array.from(periodHorizonBarEl.querySelectorAll(".period-horizon-btn[data-period-preset]"));
      btns.forEach((btn) => {
        const preset = btn.getAttribute("data-period-preset") || "";
        btn.classList.toggle("active", preset === activePreset);
      });
    }

    function applyPreset(value) {
      const today = todayString();
      let from = today;
      let to = today;
      switch (value) {
        case "year":
          from = startOfYear();
          to = today;
          break;
        case "currentMonth":
          from = startOfMonth();
          to = today;
          break;
        case "yesterday":
          const yesterday = daysAgoString(1);
          from = yesterday;
          to = yesterday;
          break;
        case "last7":
          from = daysAgoString(6);
          break;
        case "last30":
          from = daysAgoString(29);
          break;
        case "last90":
          from = daysAgoString(89);
          break;
        case "last365":
          from = daysAgoString(364);
          break;
        case "last12m":
          from = lastMonths(12);
          break;
        case "lastMonth":
          from = lastMonths(1);
          to = daysAgoString(new Date().getDate());
          break;
        case "lastWeek":
          from = daysAgoString(6);
          break;
      }
      syncFromEl.value = from;
      syncToEl.value = to;
      chartRangeFrom = from;
      chartRangeTo = to;
      syncPeriodHorizonUi(value);
    }

    async function readJsonSafe(res) {
      const raw = await res.text();
      try {
        return { ok: true, data: JSON.parse(raw) };
      } catch (_err) {
        return { ok: false, raw };
      }
    }

    function extractApiErrorMessage(parsed, fallback) {
      if (!parsed || !parsed.ok || !parsed.data || typeof parsed.data !== "object") {
        return fallback || "Erreur API";
      }
      const data = parsed.data;
      if (typeof data.error === "string" && data.error.trim()) {
        let message = data.error.trim();
        if (data.status) {
          message += " (status " + data.status + ")";
        }
        const provider = data.providerResponse;
        if (provider) {
          if (typeof provider === "string" && provider.trim()) {
            message += " - " + provider.trim();
          } else if (provider.raw) {
            message += " - " + String(provider.raw);
          } else {
            try {
              message += " - " + JSON.stringify(provider);
            } catch (_e) {
              // ignore JSON stringify failure
            }
          }
        }
        return message;
      }
      return fallback || "Erreur API";
    }

    function statusLabel(value) {
      if (value === "in_progress") return "En cours";
      if (value === "ready") return "Prête";
      if (value === "shipped") return "Expédiée";
      return value;
    }

    function paymentLabel(order) {
      const financial = String(order.financialStatus || "").toLowerCase();
      if (financial === "paid" || Number(order.outstandingAmount || 0) <= 0) return "Payée";
      if (financial === "partially_paid") return "Partiellement payée";
      return "Paiement en attente";
    }

    function paymentBadgeClass(order) {
      const financial = String(order.financialStatus || "").toLowerCase();
      if (financial === "partially_paid") return "badge-status partial";
      if (financial === "paid" || Number(order.outstandingAmount || 0) <= 0) return "badge-status paid";
      return "badge-status pending";
    }

    function paymentBadgeIcon(order) {
      const financial = String(order.financialStatus || "").toLowerCase();
      if (financial === "partially_paid") return "⊘";
      return "●";
    }

    function paymentBadgeHtml(order) {
      return (
        "<span class='" +
        paymentBadgeClass(order) +
        "'><span class='badge-icon'>" +
        paymentBadgeIcon(order) +
        "</span>" +
        paymentLabel(order) +
        "</span>"
      );
    }

    function treatmentBadgeHtml(order) {
      const isShipped = order.shippingStatus === "shipped";
      return (
        "<span class='badge-status " +
        (isShipped ? "fulfilled" : "unfulfilled") +
        "'><span class='badge-icon'>" +
        (isShipped ? "●" : "○") +
        "</span>" +
        (isShipped ? "Traitée" : "Non traitée") +
        "</span>"
      );
    }

    function customerPhoneLabel(order) {
      const value = String(order.customerPhone || "").trim();
      return value && value.toLowerCase() !== "non renseigné" ? value : "Non renseigné";
    }

    function normalizeWhatsappPhone(phone) {
      const raw = String(phone || "").trim();
      if (!raw || raw.toLowerCase() === "non renseigné") return "";
      const digits = raw.replace(/[^0-9]/g, "");
      if (digits.length < 8 || digits.length > 15) return "";
      return digits;
    }

    function remainingAmountLabel(order) {
      if (Number(order.outstandingAmount || 0) <= 0) return "";
      return formatMoney(order.outstandingAmount || 0, order.currency);
    }

    function formatOrderDateLabel(dateInput) {
      const date = new Date(dateInput);
      if (Number.isNaN(date.getTime())) return "";

      const now = new Date();
      const dayMs = 24 * 60 * 60 * 1000;
      const nowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const dateStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
      const diffDays = Math.round((nowStart - dateStart) / dayMs);
      const timeText = date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

      if (diffDays === 0) return "Aujourd'hui à " + timeText;
      if (diffDays === 1) return "Hier à " + timeText;
      if (diffDays > 1 && diffDays <= 6) {
        return date.toLocaleDateString("fr-FR", { weekday: "long" }) + " à " + timeText;
      }

      const dayMonthText = date.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
      return "le " + dayMonthText + " à " + timeText;
    }

    function formatMoney(amount, currency) {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: currency || "USD"
      }).format(amount || 0);
    }

    function toMadApprox(amount, currency) {
      const value = Number(amount || 0);
      if (!Number.isFinite(value)) return 0;
      const code = String(currency || "MAD").toUpperCase();
      const ratesToMad = {
        MAD: 1,
        EUR: 10.9,
        USD: 10.0,
        GBP: 12.7,
        CAD: 7.4
      };
      const rate = ratesToMad[code];
      if (!rate) return value;
      return value * rate;
    }

    function orderCustomerKey(order) {
      const email = String(order.customerEmail || "").trim().toLowerCase();
      if (email) return "email:" + email;
      const phoneDigits = String(order.customerPhone || "").replace(/[^0-9]/g, "");
      if (phoneDigits) return "phone:" + phoneDigits;
      const label = String(order.customerLabel || "").trim().toLowerCase();
      return "label:" + (label || "unknown");
    }

    function isCashGateway(gateway) {
      const text = String(gateway || "").toLowerCase();
      if (!text) return false;
      return (
        text.includes("cash") ||
        text.includes("cod") ||
        text.includes("espece") ||
        text.includes("espèce") ||
        text.includes("liquide")
      );
    }

    function isTransferGateway(gateway) {
      const text = String(gateway || "").toLowerCase();
      if (!text) return false;
      return (
        text.includes("virement") ||
        text.includes("bank transfer") ||
        text.includes("wire transfer") ||
        text.includes("transfer")
      );
    }

    function isChequeGateway(gateway) {
      const text = String(gateway || "").toLowerCase();
      if (!text) return false;
      return (
        text.includes("cheque") ||
        text.includes("chèque") ||
        text.includes("chequier") ||
        text.includes("chéquier") ||
        text.includes("check") ||
        text.includes("chq")
      );
    }

    function escapeHtml(value) {
      return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function buildInvoiceHtml(order, bankDetailsOverride, templateChoice = "classic") {
      const date = new Date(order.createdAt);
      const dateLabel = date.toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric" });
      const dateTimeLabel = date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
      const linesSubtotal = (order.articles || []).reduce((sum, article) => {
        const qty = Math.max(0, Number(article.quantity || 0));
        const unit = Math.max(0, Number(article.unitPrice || 0));
        return sum + (qty * unit);
      }, 0);
      const subtotalAmount = Math.max(0, Number(order.subtotalAmount || 0) > 0 ? Number(order.subtotalAmount || 0) : linesSubtotal);
      const rawDiscountAmount = Math.max(0, Number(order.discountAmount || 0));
      const totalAmountFromOrder = Math.max(0, Number(order.totalAmount || 0));
      const discountAmount = Math.min(subtotalAmount, rawDiscountAmount > 0 ? rawDiscountAmount : Math.max(0, subtotalAmount - totalAmountFromOrder));
      const previewTotalAmount = Math.max(0, totalAmountFromOrder > 0 ? totalAmountFromOrder : (subtotalAmount - discountAmount));
      const paidFromTransactions = (Array.isArray(order.paymentTransactions) ? order.paymentTransactions : []).reduce((sum, entry) => {
        const sameCurrency = !entry.currency || String(entry.currency).toUpperCase() === String(order.currency || "MAD").toUpperCase();
        return sameCurrency ? sum + Math.max(0, Number(entry.amount || 0)) : sum;
      }, 0);
      const paidAmount = Math.min(
        previewTotalAmount,
        Math.max(
          0,
          Math.max(
            paidFromTransactions,
            previewTotalAmount - Math.max(0, Number(order.outstandingAmount || 0))
          )
        )
      );
      const previewOutstandingAmount = Math.max(0, previewTotalAmount - paidAmount);
      const isFullyPaid = previewOutstandingAmount <= 0;
      const isPartial = paidAmount > 0 && !isFullyPaid;
      const financialLabel = paymentLabel(order);
      const paymentGateway = escapeHtml(order.paymentGateway || "Non précisée");
      const shippingAddress = order.shippingAddress
        ? escapeHtml(order.shippingAddress)
        : "<span style='color:#888;'>Aucune adresse de livraison renseignée</span>";
      const billingAddress = order.billingAddress
        ? escapeHtml(order.billingAddress)
        : "<span style='color:#888;'>Aucune adresse de facturation renseignée</span>";
      const customerBlock =
        escapeHtml(order.customerLabel || "Client inconnu") +
        "<br/>" +
        escapeHtml(order.customerPhone || "") +
        (order.customerEmail ? "<br/>" + escapeHtml(order.customerEmail) : "");
      const bank = bankDetailsOverride || order.bankDetails || {};
      const bankName = escapeHtml(bank.bankName || "");
      const swiftBic = escapeHtml(bank.swiftBic || "");
      const routingNumber = escapeHtml(bank.routingNumber || "");
      const beneficiaryName = escapeHtml(bank.beneficiaryName || "");
      const accountNumber = escapeHtml(bank.accountNumber || "");
      const bankAddress = escapeHtml(bank.bankAddress || "");
      const paymentReference = escapeHtml(bank.paymentReference || "");
      const bankDetailsHtml =
        "<strong>Coordonnées Bancaires</strong>" +
        "<div style='margin-top:8px; font-size:14px; line-height:1.5;'>" +
          (bankName ? "<div><strong>Banque:</strong> " + bankName + "</div>" : "") +
          (swiftBic ? "<div><strong>SWIFT/BIC:</strong> " + swiftBic + "</div>" : "") +
          (routingNumber ? "<div><strong>Routing/ABA:</strong> " + routingNumber + "</div>" : "") +
          (beneficiaryName ? "<div><strong>Bénéficiaire:</strong> " + beneficiaryName + "</div>" : "") +
          (accountNumber ? "<div><strong>N° compte:</strong> " + accountNumber + "</div>" : "") +
          (bankAddress ? "<div><strong>Adresse banque:</strong> " + bankAddress + "</div>" : "") +
          (paymentReference ? "<div style='margin-top:8px;'><strong>Référence:</strong> " + paymentReference + "</div>" : "") +
          (!bankName && !swiftBic && !routingNumber && !beneficiaryName && !accountNumber && !bankAddress && !paymentReference
            ? "<span style='color:#888;'>Aucune coordonnée bancaire renseignée.</span>"
            : "") +
        "</div>";
      const rows = (order.articles || [])
        .map((article) => {
          const qty = Math.max(1, Number(article.quantity || 1));
          const unit = Math.max(0, Number(article.unitPrice || 0));
          return (
            "<tr>" +
            "<td style='padding:10px 12px; border-bottom:1px solid #eee;'>" + qty + "</td>" +
            "<td style='padding:10px 12px; border-bottom:1px solid #eee; font-weight:600;'>" + escapeHtml(article.title) + "</td>" +
            "<td style='padding:10px 12px; border-bottom:1px solid #eee; text-align:right; font-weight:600;'>" + formatMoney(unit * qty, order.currency) + "</td>" +
            "</tr>"
          );
        })
        .join("");

      let paymentSection = "";
      if (isFullyPaid) {
        paymentSection =
          "<div style='margin:14px 0; display:flex; gap:16px; flex-wrap:wrap;'>" +
            "<div style='flex:1; min-width:260px; background:#e9f7ef; padding:14px; border-radius:8px; border:1px solid #d7eddc;'>" +
              "<strong style='color:#138a4a;'>Paiement reçu</strong>" +
              "<div style='margin-top:8px; font-size:14px; color:#333;'>" +
                "Montant réglé : <strong>" + formatMoney(paidAmount, order.currency) + "</strong><br/>" +
                "Statut financier : <strong>" + escapeHtml(financialLabel) + "</strong><br/>" +
                "Méthode : " + paymentGateway +
              "</div>" +
            "</div>" +
            "<div style='flex:1; min-width:260px; background:#fff; padding:12px; border-radius:8px; border:1px solid #f0f0f0;'>" +
              "<strong>Récapitulatif des paiements</strong>" +
              "<table style='width:100%; margin-top:8px; font-size:14px; border-collapse:collapse;'>" +
                "<thead><tr style='color:#666; font-size:13px;'><th style='text-align:left; padding:6px 8px;'>Paiement</th><th style='text-align:right; padding:6px 8px;'>Montant</th><th style='text-align:right; padding:6px 8px;'>Statut</th></tr></thead>" +
                "<tbody><tr><td style='padding:6px 8px;'>Paiement</td><td style='padding:6px 8px; text-align:right;'>" + formatMoney(paidAmount, order.currency) + "</td><td style='padding:6px 8px; text-align:right;'>Success</td></tr></tbody>" +
              "</table>" +
            "</div>" +
          "</div>";
      } else if (isPartial) {
        paymentSection =
          "<div style='margin:14px 0; display:flex; gap:16px; flex-wrap:wrap;'>" +
            "<div style='flex:1; min-width:260px; background:#fff8e6; padding:12px; border-radius:8px; border:1px solid #f0e6c8;'>" +
              "<strong>Paiement partiel</strong>" +
              "<div style='margin-top:8px; font-size:14px; color:#333;'>" +
                "Montant payé : <strong>" + formatMoney(paidAmount, order.currency) + "</strong><br/>" +
                "Total facture : <strong>" + formatMoney(order.totalAmount || 0, order.currency) + "</strong><br/>" +
                "<div style='margin-top:6px; color:#b41c18;'>Reste à payer : <strong>" + formatMoney(order.outstandingAmount || 0, order.currency) + "</strong></div>" +
              "</div>" +
            "</div>" +
            "<div style='flex:1; min-width:260px; background:#fafafa; padding:12px; border-radius:8px; border:1px dashed #e6e6e6;'>" +
              bankDetailsHtml +
            "</div>" +
          "</div>";
      } else {
        paymentSection =
          "<div style='background:#fafafa; padding:12px; border-radius:8px; border:1px dashed #e6e6e6; margin:14px 0;'>" +
            bankDetailsHtml +
          "</div>";
      }

      const hasOutstanding = previewOutstandingAmount > 0;
      const outstandingRow = hasOutstanding
        ? "<tr><td colspan='2' style='text-align:right;padding:12px;border-top:1px solid #f0f0f0;'><strong>Montant impayé</strong></td><td style='text-align:right;padding:12px;border-top:1px solid #f0f0f0;color:#b41c18;'><strong>" + formatMoney(previewOutstandingAmount, order.currency) + "</strong></td></tr>"
        : "";
      const coinOutstandingRow = hasOutstanding ? "<tr><td colspan='2' style='text-align:right;padding:12px;border-top:1px solid #f0e6d5;'><strong>Montant impayé</strong></td><td style='text-align:right;padding:12px;border-top:1px solid #f0e6d5;color:#b41c18;'><strong>" + formatMoney(previewOutstandingAmount, order.currency) + "</strong></td></tr>" : "";
      const classicDiscountRow = discountAmount > 0
        ? "<tr><td colspan='2' style='text-align:right;padding:10px 12px;'>Remise</td><td style='text-align:right;padding:10px 12px;'>-" + formatMoney(discountAmount, order.currency) + "</td></tr>"
        : "";
      const coinDiscountRow = discountAmount > 0
        ? "<tr><td colspan='2' style='text-align:right;padding:10px 12px;'>Remise</td><td style='text-align:right;padding:10px 12px;'>-" + formatMoney(discountAmount, order.currency) + "</td></tr>"
        : "";
      const compactDiscountLine = discountAmount > 0
        ? "<div class='line'><span>Remise</span><span>-" + formatMoney(discountAmount, order.currency) + "</span></div>"
        : "";
      const classicInvoice = (
        "<!doctype html><html><head><meta charset='utf-8' /><title>Facture " + escapeHtml(order.name) + "</title>" +
        "<style>body{max-width:860px;margin:0 auto;font-family:'Helvetica Neue',Arial,sans-serif;line-height:1.55;color:#222;padding:24px;background:#fff}" +
        ".row{display:flex;justify-content:space-between;align-items:center;gap:1rem;margin-bottom:1.25em}.box{background:#fff;padding:16px;border-radius:10px;border:1px solid #f0f0f0;box-sizing:border-box}" +
        ".muted{color:#555}.title{margin:0;font-size:22px}.cards{display:flex;gap:12px;align-items:stretch;flex-wrap:wrap}.cards .box{flex:1;min-width:180px}" +
        "table{width:100%;border-collapse:collapse;margin-bottom:12px;font-size:14px}thead tr{background:#fafafa}th{font-weight:600;text-align:left;padding:10px 12px}" +
        "@media print{body{padding:0}}</style></head><body>" +
        "<div class='wrap'>" +
        "<div class='row'>" +
          "<div style='display:flex;align-items:center;gap:16px;'>" +
            "<img src='https://cdn.shopify.com/s/files/1/0551/5558/9305/files/loooogoooo.png?v=1727896750' alt='Logo' style='max-width:160px;height:auto;display:block;' />" +
            "<div style='font-size:14px;color:#555;'><strong style='font-size:16px;display:block;'>Bouchra Filali Lahlou</strong>www.bouchrafilalilahlou.com</div>" +
          "</div>" +
          "<div style='text-align:right;'><div style='background:#f6f6f8;padding:10px 12px;border-radius:8px;border:1px solid #eee;'><div style='font-size:12px;color:#777;'>Facture</div><div style='font-weight:700;font-size:16px;'>" + escapeHtml(order.name) + "</div></div></div>" +
        "</div>" +
        "<div style='display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.75em;'>" +
          "<h1 class='title'>Facture</h1>" +
          "<div style='text-align:right;color:#555;font-size:14px;'><div>Statut : " + escapeHtml(financialLabel) + "</div><div>" + dateLabel + " " + dateTimeLabel + "</div></div>" +
        "</div>" +
        "<div class='cards' style='margin-top:1.25em;margin-bottom:1em;'>" +
          "<div class='box'><strong>De</strong><br/>www.bouchrafilalilahlou.com<br/>19/21 Rond-point des Sports<br/>Casablanca, 20250</div>" +
          "<div class='box'><strong>Client</strong><br/>" + customerBlock + "</div>" +
          "<div class='box'><strong>Adresse de Facturation</strong><br/>" + billingAddress + "</div>" +
          "<div class='box'><strong>Adresse de Livraison</strong><br/>" + shippingAddress + "</div>" +
        "</div>" +
        "<hr style='margin:1.25em 0;border:none;border-top:1px solid #eee;' />" +
        "<table><thead><tr><th>Qté</th><th>Article</th><th style='text-align:right;'>Prix</th></tr></thead><tbody>" +
        rows +
        "<tr><td colspan='2' style='text-align:right;padding:10px 12px;'>Sous-total</td><td style='text-align:right;padding:10px 12px;'>" + formatMoney(subtotalAmount, order.currency) + "</td></tr>" +
        classicDiscountRow +
        "<tr><td colspan='2' style='text-align:right;padding:12px;border-top:1px solid #f0f0f0;'><strong>Total</strong></td><td style='text-align:right;padding:12px;border-top:1px solid #f0f0f0;'><strong>" + formatMoney(order.totalAmount || 0, order.currency) + "</strong></td></tr>" +
        "<tr><td colspan='2' style='text-align:right;padding:8px 12px;'>Total payé</td><td style='text-align:right;padding:8px 12px;'>" + formatMoney(paidAmount, order.currency) + "</td></tr>" +
        outstandingRow +
        "</tbody></table>" +
        paymentSection +
        "<div style='margin-top:18px;padding:14px;border-radius:8px;background:#fff;border:1px solid #f0f0f0;font-size:14px;color:#333;'>" +
          "<strong>Merci pour votre confiance.</strong>" +
          "<p style='margin:8px 0 0 0;color:#666;'>Chaque pièce est confectionnée sur mesure avec le plus grand soin. Si vous avez des questions concernant cette facture ou votre commande, n’hésitez pas à nous contacter.</p>" +
        "</div>" +
        "<p style='margin-top:14px;font-size:13px;color:#666;'>Document généré par www.bouchrafilalilahlou.com</p>" +
        "</div></body></html>"
      );
      const coinLegalNotice =
        "<div style='font-size:12px; color:#7a6a5d; margin-bottom:10px;'>Siège Social 19 ET 21 ROND POINT DES SPORTS QUARTIER RACINE, Casablanca<br/>ICE 002031076000092<br/>Copie des Inscriptions Portées au registre analytique N°:401313</div>";
      const coinInvoice = (
        "<!doctype html><html><head><meta charset='utf-8' /><title>Facture " + escapeHtml(order.name) + "</title>" +
        "<style>body{max-width:860px;margin:0 auto;font-family:'Helvetica Neue',Arial,sans-serif;line-height:1.55;color:#1b1b1b;padding:24px;background:#faf5ef}" +
        ".row{display:flex;justify-content:space-between;align-items:center;margin-bottom:1.25em}.badge{display:inline-flex;align-items:center;border-radius:8px;padding:6px 12px;background:#f2d7b4;color:#a15a00;font-weight:700}" +
        ".card{background:#fff;padding:16px;border-radius:12px;border:1px solid #f0e6d5;box-shadow:0 4px 12px rgba(0,0,0,0.06);}" +
        "table{width:100%;border-collapse:collapse;font-size:14px}thead tr{background:#fff0e6}th{font-weight:700;text-align:left;padding:10px 12px;border-bottom:1px solid #f0e6d5}" +
        "td{padding:10px 12px;border-bottom:1px solid #f5ece2} .muted{color:#6c5a49}</style></head><body>" +
        "<div class='row'><div><div style='font-size:18px;color:#a15a00;font-weight:700;'>Coin de Couture</div><div class='muted'>www.coindecouture.com<br/>+212 6 22 22 22 22</div></div><div><div class='badge'>FACTURE #</div><div style='font-size:18px;font-weight:700;'>" + escapeHtml(order.name) + "</div></div></div>" +
        "<div style='display:flex;gap:12px;margin-bottom:1.25em'><div class='card'><strong>De</strong><br/>Coin de Couture<br/>Casablanca, Maroc<br/>info@coindecouture.com</div><div class='card'><strong>Client</strong><br/>" + customerBlock + "</div><div class='card'><strong>Adresse facturation</strong><br/>" + billingAddress + "</div></div>" +
        coinLegalNotice +
        "<table><thead><tr><th>Qté</th><th>Article</th><th style='text-align:right;'>Prix</th></tr></thead><tbody>" +
        rows +
        "<tr><td colspan='2' style='text-align:right;padding:10px 12px;'>Sous-total</td><td style='text-align:right;padding:10px 12px;'>" + formatMoney(subtotalAmount, order.currency) + "</td></tr>" +
        coinDiscountRow +
        "<tr><td colspan='2' style='text-align:right;padding:12px;border-top:1px solid #f0e6d5;'><strong>Total</strong></td><td style='text-align:right;padding:12px;border-top:1px solid #f0e6d5;'><strong>" + formatMoney(order.totalAmount || 0, order.currency) + "</strong></td></tr>" +
        "<tr><td colspan='2' style='text-align:right;padding:8px 12px;'>Total payé</td><td style='text-align:right;padding:8px 12px;'>" + formatMoney(paidAmount, order.currency) + "</td></tr>" +
        coinOutstandingRow +
        "</tbody></table>" +
        paymentSection +
        "<div class='card' style='margin-top:18px;background:#fff7ef'><strong>Merci pour votre confiance.</strong><p style='margin:8px 0 0 0;color:#8b6a45;'>Chaque création fait main est unique. Contactez-nous à info@coindecouture.com pour toute question.</p></div>" +
        "<p style='margin-top:14px;font-size:13px;color:#7a6a5d;'>Document généré par Coin de Couture</p>" +
        "</body></html>"
      );
      const showroomInvoice = (
        "<!doctype html><html><head><meta charset='utf-8' /><title>Reçu de maison " + escapeHtml(order.name) + "</title>" +
        "<style>@page{size:A4;margin:18mm}html,body{margin:0;padding:0;background:#fcfaf6;color:#121212;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif}" +
        "*{box-sizing:border-box}.page{padding:18mm 20mm 16mm;min-height:100vh}.overline{text-align:center;font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:#756e66}" +
        ".brand{text-align:center;font-family:Georgia,'Times New Roman',serif;font-size:34px;letter-spacing:.05em;line-height:1.1;margin-top:14px}" +
        ".meta{text-align:center;color:#756e66;font-size:13px;margin-top:10px}.rule{height:1px;background:#ebe5dc;margin:24px 0 28px}" +
        ".hero{display:grid;grid-template-columns:1.45fr .85fr;gap:44px;align-items:start}.doc-title{font-family:Georgia,'Times New Roman',serif;font-size:33px;line-height:1.08;font-weight:500}" +
        ".doc-sub{margin-top:10px;color:#756e66;font-size:14px}.meta-stack{padding-top:2px}.meta-label{font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:#756e66;margin-top:14px}" +
        ".meta-label:first-child{margin-top:0}.meta-value{margin-top:5px;font-size:16px;line-height:1.35}.meta-value.strong{font-weight:700}" +
        ".identity{display:grid;grid-template-columns:1fr 1fr;gap:54px;margin-top:34px}.identity-label{font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:#756e66}" +
        ".identity-value{margin-top:7px;font-size:17px;font-weight:700}.identity-copy{margin-top:7px;font-size:14px;line-height:1.6;color:#2b2724}" +
        ".table{margin-top:42px}.table-head,.table-row{display:grid;grid-template-columns:52px 1fr 210px;gap:16px;align-items:start}.table-head{font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:#756e66;padding-bottom:12px}" +
        ".table-rule{height:1px;background:#ded6cb}.table-row{padding:16px 0 18px;border-bottom:1px solid #ebe5dc}.qty{font-size:13px;color:#756e66}.piece{font-size:18px;line-height:1.35;font-weight:600}" +
        ".amount{text-align:right;font-size:16px;line-height:1.35;color:#2b2724}.financials{margin-top:34px;display:grid;grid-template-columns:1fr 270px;gap:40px;align-items:end}" +
        ".financial-copy{font-size:14px;line-height:1.7;color:#756e66;padding-bottom:6px}.totals{padding-top:10px}.totals-row{display:grid;grid-template-columns:1fr auto;gap:18px;padding:6px 0}" +
        ".totals-label{font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:#756e66}.totals-value{text-align:right;font-size:15px;color:#2b2724}" +
        ".totals-rule{height:1px;background:#ebe5dc;margin:8px 0 10px}.balance{display:grid;grid-template-columns:1fr auto;gap:18px;align-items:end;padding-top:2px}" +
        ".balance-label{font-family:Georgia,'Times New Roman',serif;font-size:24px;line-height:1.1;color:#5f5346}.balance-value{text-align:right;font-size:21px;font-weight:700;color:#5f5346}" +
        ".footer{margin-top:54px;padding-top:18px;border-top:1px solid #ebe5dc;text-align:center;font-family:Georgia,'Times New Roman',serif;font-size:18px;color:#2b2724}" +
        "@media (max-width: 820px){.page{padding:12mm}.hero,.identity,.financials{grid-template-columns:1fr}.table-head,.table-row{grid-template-columns:42px 1fr 120px;gap:10px}.brand{font-size:28px}.doc-title{font-size:28px}.piece{font-size:16px}.balance-label{font-size:20px}.balance-value{font-size:18px}}</style></head><body><div class='page'>" +
        "<div class='overline'>Edition privee</div>" +
        "<div class='brand'>Maison Bouchra Filali Lahlou</div>" +
        "<div class='meta'>Casablanca · contact@bouchrafilalilahlou.com · www.bouchrafilalilahlou.com</div>" +
        "<div class='rule'></div>" +
        "<div class='hero'><div><div class='doc-title'>Reçu de maison</div><div class='doc-sub'>Edité le " + dateLabel + " à " + dateTimeLabel + "</div></div><div class='meta-stack'>" +
        "<div class='meta-label'>Référence</div><div class='meta-value strong'>" + escapeHtml(order.name || "Non renseignée") + "</div>" +
        "<div class='meta-label'>Règlement</div><div class='meta-value'>" + escapeHtml(financialLabel) + "</div>" +
        "<div class='meta-label'>Montant de la commande</div><div class='meta-value strong'>" + formatMoney(previewTotalAmount, order.currency) + "</div>" +
        "</div></div>" +
        "<div class='identity'><div><div class='identity-label'>À l'attention de</div><div class='identity-value'>" + escapeHtml(order.customerLabel || "Cliente non renseignée") + "</div><div class='identity-copy'>" + escapeHtml(order.customerPhone || "Téléphone non renseigné") + "<br/>" + escapeHtml(order.customerEmail || "E-mail non renseigné") + "</div></div>" +
        "<div><div class='identity-label'>Coordonnées de commande</div><div class='identity-value'>" + paymentGateway + "</div><div class='identity-copy'>" + shippingAddress + "</div></div></div>" +
        "<div class='table'><div class='table-head'><div>Qté</div><div>Pièce</div><div style='text-align:right'>Montant</div></div><div class='table-rule'></div>" +
        (order.articles || []).map((article) => {
          const qty = Math.max(0, Number(article.quantity || 0));
          const unit = Math.max(0, Number(article.unitPrice || 0));
          return "<div class='table-row'><div class='qty'>" + qty + "</div><div class='piece'>" + escapeHtml(article.title || "Pièce couture") + "</div><div class='amount'>" + formatMoney(qty * unit, order.currency) + "</div></div>";
        }).join("") +
        "</div>" +
        "<div class='financials'><div class='financial-copy'>" + (hasOutstanding
          ? "Le solde restant pourra être réglé selon les modalités convenues avec la Maison."
          : "Ce document confirme le règlement de votre commande couture."
        ) + "</div><div class='totals'>" +
        "<div class='totals-row'><div class='totals-label'>Sous-total</div><div class='totals-value'>" + formatMoney(subtotalAmount, order.currency) + "</div></div>" +
        (discountAmount > 0 ? "<div class='totals-row'><div class='totals-label'>Remise</div><div class='totals-value'>" + formatMoney(-discountAmount, order.currency) + "</div></div>" : "") +
        "<div class='totals-row'><div class='totals-label'>Total</div><div class='totals-value'>" + formatMoney(previewTotalAmount, order.currency) + "</div></div>" +
        "<div class='totals-row'><div class='totals-label'>Réglé à ce jour</div><div class='totals-value'>" + formatMoney(paidAmount, order.currency) + "</div></div>" +
        "<div class='totals-rule'></div><div class='balance'><div class='balance-label'>Reste à payer</div><div class='balance-value'>" + (hasOutstanding ? formatMoney(previewOutstandingAmount, order.currency) : "-") + "</div></div>" +
        "</div></div>" +
        "<div class='footer'>Avec nos remerciements.</div>" +
        "</div></body></html>"
      );
      const internationalInvoice = (
        "<!doctype html><html><head><meta charset='utf-8' /><title>International Invoice " + escapeHtml(order.name) + "</title>" +
        "<style>@page{size:A4;margin:14mm 12mm 18mm}html,body{margin:0;padding:0;background:#fff;color:#111;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif}" +
        "*{box-sizing:border-box}.page{padding:2mm 0 14mm}.top{display:grid;grid-template-columns:1.2fr 1fr;gap:20px;align-items:start;margin-bottom:16px}" +
        ".brand{font-family:Georgia,'Times New Roman',serif;letter-spacing:.11em;font-size:18px;text-transform:uppercase}.meta{font-size:12px;color:#666;line-height:1.5;margin-top:6px}" +
        ".ibox{border:1px solid #ddd;border-radius:10px;padding:12px}.ibox h2{margin:0 0 8px;font-size:26px;letter-spacing:.08em}.kv{display:grid;grid-template-columns:42% 58%;gap:6px;font-size:12.5px;margin-bottom:5px}" +
        ".k{color:#666}.v{font-weight:600}.cards{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px}.card{border:1px solid #e6e6e6;border-radius:10px;padding:12px}" +
        ".card h3{margin:0 0 8px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#666}table{width:100%;border-collapse:collapse;font-size:13px}" +
        "thead th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:#666;border-bottom:1px solid #ddd;padding:9px 10px}" +
        "tbody td{padding:9px 10px;border-bottom:1px solid #ededed}td.r{text-align:right}.totals{margin-top:12px;border:1px solid #ddd;border-radius:10px;padding:10px;max-width:380px;margin-left:auto}" +
        ".line{display:flex;justify-content:space-between;padding:4px 0;font-size:13px}.line strong{font-size:14px}</style></head><body><div class='page'>" +
        "<div class='top'><div><div class='brand'>Maison Bouchra Filali Lahlou</div><div class='meta'>Casablanca, Morocco<br/>contact@bouchrafilalilahlou.com<br/>www.bouchrafilalilahlou.com</div></div>" +
        "<div class='ibox'><h2>INVOICE</h2><div class='kv'><div class='k'>No.</div><div class='v'>" + escapeHtml(order.name) + "</div></div><div class='kv'><div class='k'>Date</div><div class='v'>" + dateLabel + "</div></div><div class='kv'><div class='k'>Status</div><div class='v'>" + escapeHtml(financialLabel) + "</div></div><div class='kv'><div class='k'>Method</div><div class='v'>" + paymentGateway + "</div></div></div></div>" +
        "<div class='cards'><div class='card'><h3>Client</h3>" +
        "<div class='kv'><div class='k'>Name</div><div class='v'>" + escapeHtml(order.customerLabel || "Client inconnu") + "</div></div>" +
        "<div class='kv'><div class='k'>Phone</div><div class='v'>" + escapeHtml(order.customerPhone || "-") + "</div></div>" +
        "<div class='kv'><div class='k'>Email</div><div class='v'>" + escapeHtml(order.customerEmail || "-") + "</div></div>" +
        "</div><div class='card'><h3>Addresses</h3><div class='kv'><div class='k'>Billing</div><div class='v'>" + billingAddress + "</div></div><div class='kv'><div class='k'>Shipping</div><div class='v'>" + shippingAddress + "</div></div></div></div>" +
        "<table><thead><tr><th style='width:72px'>Qty</th><th>Description</th><th class='r' style='width:190px'>Amount</th></tr></thead><tbody>" +
        rows +
        "</tbody></table>" +
        "<div class='totals'><div class='line'><span>Subtotal</span><span>" + formatMoney(subtotalAmount, order.currency) + "</span></div>" +
        compactDiscountLine +
        "<div class='line'><span>Total</span><span>" + formatMoney(order.totalAmount || 0, order.currency) + "</span></div><div class='line'><span>Paid</span><span>" + formatMoney(paidAmount, order.currency) + "</span></div>" +
        (hasOutstanding ? "<div class='line'><strong>Balance due</strong><strong>" + formatMoney(order.outstandingAmount || 0, order.currency) + "</strong></div>" : "<div class='line'><strong>Balance due</strong><strong>-</strong></div>") +
        "</div></div></body></html>"
      );
      if (templateChoice === "coin") return coinInvoice;
      if (templateChoice === "showroom_receipt") return showroomInvoice;
      if (templateChoice === "international_invoice") return internationalInvoice;
      return classicInvoice;
    }

    function applyBankProfileUI(profileType) {
      if (profileType === "us") {
        bankNameLabelEl.textContent = "Banque";
        swiftLabelEl.textContent = "SWIFT / BIC";
        routingLabelEl.textContent = "Routing / ABA";
        accountLabelEl.textContent = "N° compte";
        bankProfileHelpEl.textContent = "Compte US: utilisez Routing/ABA + numéro de compte.";
        return;
      }
      if (profileType === "ma") {
        bankNameLabelEl.textContent = "Banque";
        swiftLabelEl.textContent = "SWIFT / BIC (optionnel)";
        routingLabelEl.textContent = "Code banque / guichet (optionnel)";
        accountLabelEl.textContent = "RIB";
        bankProfileHelpEl.textContent = "RIB Maroc: renseignez le RIB complet et, si besoin, le SWIFT.";
        return;
      }
      if (profileType === "eu") {
        bankNameLabelEl.textContent = "Banque";
        swiftLabelEl.textContent = "BIC";
        routingLabelEl.textContent = "Code banque (optionnel)";
        accountLabelEl.textContent = "IBAN";
        bankProfileHelpEl.textContent = "Compte FR/EU: renseignez surtout IBAN + BIC.";
        return;
      }
      bankNameLabelEl.textContent = "Banque";
      swiftLabelEl.textContent = "SWIFT / BIC";
      routingLabelEl.textContent = "Routing / Code";
      accountLabelEl.textContent = "N° compte / IBAN / RIB";
      bankProfileHelpEl.textContent = "Format libre: adaptez les champs à votre compte.";
    }

    function guessBankProfile(details) {
      const account = String(details?.accountNumber || "").toUpperCase();
      if (account.startsWith("MA")) return "ma";
      if (account.startsWith("FR") || account.startsWith("DE") || account.startsWith("ES") || account.startsWith("IT")) return "eu";
      if (String(details?.routingNumber || "").trim()) return "us";
      return "other";
    }

    function bankTemplateLabel(templateChoice) {
      return templateChoice === "showroom_receipt" ? "reçu" : "facture";
    }

    function shouldShowBankInfo(showBankSection) {
      return Boolean(showBankSection) && currentBankTemplateChoice !== "showroom_receipt";
    }

    function collectBankModalSelection(showBankSection) {
      return {
        bankDetails:
          shouldShowBankInfo(showBankSection)
            ? {
                bankName: bankNameInputEl.value.trim() || undefined,
                swiftBic: swiftInputEl.value.trim() || undefined,
                routingNumber: routingInputEl.value.trim() || undefined,
                beneficiaryName: bankBeneficiaryNameEl.value.trim() || undefined,
                accountNumber: accountInputEl.value.trim() || undefined,
                bankAddress: bankAddressInputEl.value.trim() || undefined,
                paymentReference: referenceInputEl.value.trim() || undefined
              }
            : undefined,
        templateChoice: currentBankTemplateChoice
      };
    }

    function syncBankTemplateUi() {
      const isReceipt = currentBankTemplateChoice === "showroom_receipt";
      const label = bankTemplateLabel(currentBankTemplateChoice);
      const showBankInfo = shouldShowBankInfo(currentBankNeedsDetails);
      bankTemplateInvoiceBtn.classList.toggle("active", !isReceipt);
      bankTemplateReceiptBtn.classList.toggle("active", isReceipt);
      bankTemplateInvoiceBtn.setAttribute("aria-pressed", String(!isReceipt));
      bankTemplateReceiptBtn.setAttribute("aria-pressed", String(isReceipt));
      bankFieldsGroupEl.classList.toggle("hidden", !showBankInfo);
      bankProfileGroupEl.classList.toggle("hidden", !showBankInfo);
      bankModalPreviewHead.textContent = "Aperçu du " + label;
      bankModalConfirmBtn.textContent = isReceipt ? "Utiliser ce reçu" : "Utiliser cette facture";
      bankModalPreviewBtn.textContent = bankModalPreviewWrap.classList.contains("hidden")
        ? "Aperçu du " + label
        : "Actualiser l'aperçu";
    }

    async function renderBankModalPreview(order, showBankSection) {
      const currentSelection = collectBankModalSelection(showBankSection);
      if (invoicePreviewBlobUrl) {
        URL.revokeObjectURL(invoicePreviewBlobUrl);
        invoicePreviewBlobUrl = "";
      }
      bankModalPreviewFrame.removeAttribute("src");
      bankModalPreviewFrame.srcdoc = "<!doctype html><html><body style='margin:0;font-family:Arial,sans-serif;color:#666;padding:24px;'>Chargement de l'aperçu...</body></html>";
      bankModalPreviewWrap.classList.remove("hidden");
      syncBankTemplateUi();
      if (currentSelection.templateChoice === "showroom_receipt" || currentSelection.templateChoice === "classic") {
        try {
          const previewRes = await fetch(
            "/admin/api/orders/"
              + encodeURIComponent(order.id)
              + "/invoice-preview-html?template="
              + encodeURIComponent(currentSelection.templateChoice)
              + "&_="
              + Date.now()
          );
          const previewHtml = await previewRes.text();
          if (!previewRes.ok) {
            throw new Error(previewHtml || "Aperçu indisponible");
          }
          bankModalPreviewFrame.srcdoc = previewHtml;
        } catch (_error) {
          bankModalPreviewFrame.srcdoc = "<!doctype html><html><body style='margin:0;font-family:Arial,sans-serif;color:#8a1f17;padding:24px;'>Impossible de charger l'aperçu du document.</body></html>";
        }
      } else {
        const html = buildInvoiceHtml(order, currentSelection.bankDetails, currentSelection.templateChoice);
        bankModalPreviewFrame.srcdoc = html;
      }
      return currentSelection;
    }

    function openInvoiceModal(order, showBankSection, initialTemplateChoice = "classic") {
      return new Promise((resolve) => {
        const existing = order.bankDetails || {};
        currentBankNeedsDetails = Boolean(showBankSection);
        bankProfileTypeEl.value = guessBankProfile(existing);
        currentBankTemplateChoice = initialTemplateChoice === "showroom_receipt" ? "showroom_receipt" : "classic";
        bankBeneficiaryNameEl.value = existing.beneficiaryName || "";
        bankNameInputEl.value = existing.bankName || "";
        swiftInputEl.value = existing.swiftBic || "";
        routingInputEl.value = existing.routingNumber || "";
        accountInputEl.value = existing.accountNumber || "";
        bankAddressInputEl.value = existing.bankAddress || "";
        referenceInputEl.value = existing.paymentReference || order.name || "";
        applyBankProfileUI(bankProfileTypeEl.value);
        bankModalPreviewWrap.classList.add("hidden");
        bankModalPreviewFrame.removeAttribute("src");
        syncBankTemplateUi();
        bankModalEl.classList.remove("hidden");

        const cleanup = () => {
          bankModalConfirmBtn.onclick = null;
          bankModalCancelBtn.onclick = null;
          bankModalPreviewBtn.onclick = null;
          bankTemplateInvoiceBtn.onclick = null;
          bankTemplateReceiptBtn.onclick = null;
          bankProfileTypeEl.onchange = null;
          if (invoicePreviewBlobUrl) {
            URL.revokeObjectURL(invoicePreviewBlobUrl);
            invoicePreviewBlobUrl = "";
          }
        };

        bankProfileTypeEl.onchange = () => applyBankProfileUI(bankProfileTypeEl.value);
        bankTemplateInvoiceBtn.onclick = () => {
          currentBankTemplateChoice = "classic";
          syncBankTemplateUi();
          if (!bankModalPreviewWrap.classList.contains("hidden")) {
            void renderBankModalPreview(order, showBankSection);
          }
        };
        bankTemplateReceiptBtn.onclick = () => {
          currentBankTemplateChoice = "showroom_receipt";
          syncBankTemplateUi();
          if (!bankModalPreviewWrap.classList.contains("hidden")) {
            void renderBankModalPreview(order, showBankSection);
          }
        };
        bankModalCancelBtn.onclick = () => {
          bankModalEl.classList.add("hidden");
          cleanup();
          resolve(null);
        };
        bankModalPreviewBtn.onclick = () => {
          void renderBankModalPreview(order, showBankSection);
        };
        bankModalConfirmBtn.onclick = () => {
          const selected = collectBankModalSelection(showBankSection);
          bankModalEl.classList.add("hidden");
          cleanup();
          resolve(selected);
        };
      });
    }

    function detectArticleType(title) {
      const text = String(title || "").toLowerCase();
      if (text.includes("djellaba") || text.includes("jellaba")) return "djellaba";
      if (
        text.includes("caftan") ||
        text.includes("kaftan") ||
        text.includes("tenue") ||
        text.includes("takchita")
      ) {
        return "caftan";
      }
      if (text.includes("gandoura") || text.includes("gandora")) return "gandoura";
      if (text.includes("kimono")) return "kimono";
      return "autres";
    }

    function renderCurrencyBreakdown(element, entries) {
      if (!entries || entries.length === 0) {
        element.innerHTML = "<span class='kpi-muted'>-</span>";
        return;
      }
      element.innerHTML = entries
        .map(([currency, amount]) => "<span class='kpi-break-item'>" + formatMoney(amount, currency) + "</span>")
        .join("");
    }

    function normalizeIsoDay(value) {
      const text = String(value || "").trim();
      if (!text) return "";
      const directMatch = text.match(/^(\d{4}-\d{2}-\d{2})/);
      if (directMatch && directMatch[1]) return directMatch[1];
      const parsed = new Date(text);
      if (Number.isNaN(parsed.getTime())) return "";
      return parsed.toISOString().slice(0, 10);
    }

    function parseIsoDay(value) {
      const normalized = normalizeIsoDay(value);
      if (!normalized) return null;
      const date = new Date(normalized + "T00:00:00.000Z");
      if (Number.isNaN(date.getTime())) return null;
      return date;
    }

    function getActiveChartRange() {
      const fromDate = parseIsoDay(chartRangeFrom) || parseIsoDay(syncFromEl ? syncFromEl.value : "");
      const toDate = parseIsoDay(chartRangeTo) || parseIsoDay(syncToEl ? syncToEl.value : "");
      if (fromDate && toDate && fromDate.getTime() <= toDate.getTime()) {
        return { fromDate, toDate };
      }
      return null;
    }

    function buildChartDaySeries(data) {
      const activeRange = getActiveChartRange();
      if (activeRange) {
        const dayMs = 24 * 60 * 60 * 1000;
        const totalDays = Math.floor((activeRange.toDate.getTime() - activeRange.fromDate.getTime()) / dayMs) + 1;
        const daySeries = [];
        for (let i = 0; i < totalDays; i += 1) {
          const d = new Date(activeRange.fromDate.getTime() + i * dayMs);
          daySeries.push({ key: d.toISOString().slice(0, 10), value: 0 });
        }
        return daySeries;
      }

      if (Array.isArray(data) && data.length > 0) {
        let minTs = Number.POSITIVE_INFINITY;
        let maxTs = Number.NEGATIVE_INFINITY;
        data.forEach((order) => {
          const key = String(order.createdAt || "").slice(0, 10);
          const d = parseIsoDay(key);
          if (!d) return;
          const ts = d.getTime();
          if (ts < minTs) minTs = ts;
          if (ts > maxTs) maxTs = ts;
        });

        if (Number.isFinite(minTs) && Number.isFinite(maxTs) && minTs <= maxTs) {
          const dayMs = 24 * 60 * 60 * 1000;
          const totalDays = Math.floor((maxTs - minTs) / dayMs) + 1;
          const daySeries = [];
          for (let i = 0; i < totalDays; i += 1) {
            const d = new Date(minTs + i * dayMs);
            daySeries.push({ key: d.toISOString().slice(0, 10), value: 0 });
          }
          return daySeries;
        }
      }

      {
        const today = new Date();
        const fallback = [];
        for (let i = 34; i >= 0; i -= 1) {
          const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
          fallback.push({ key: d.toISOString().slice(0, 10), value: 0 });
        }
        return fallback;
      }
    }

    function renderRevenueChart(data) {
      if (!kpiRevenueChartEl) return;
      const width = 640;
      const height = 220;
      const margin = { top: 18, right: 14, bottom: 38, left: 56 };
      const plotWidth = width - margin.left - margin.right;
      const plotHeight = height - margin.top - margin.bottom;
      const activeRange = getActiveChartRange();
      const chartData = activeRange
        ? data.filter((order) => {
            const d = parseIsoDay(String(order.createdAt || "").slice(0, 10));
            return !!d && d.getTime() >= activeRange.fromDate.getTime() && d.getTime() <= activeRange.toDate.getTime();
          })
        : data;
      const daySeries = buildChartDaySeries(data);
      daySeries.forEach((entry) => {
        entry.orderCount = 0;
      });

      const bucket = new Map(daySeries.map((entry) => [entry.key, entry]));
      chartData.forEach((order) => {
        const key = String(order.createdAt || "").slice(0, 10);
        const target = bucket.get(key);
        if (!target) return;
        target.value += Math.max(0, Number(order.totalAmount || 0));
        target.orderCount += 1;
      });

      const values = daySeries.map((entry) => entry.value);
      const maxValue = Math.max(...values, 0);
      const orderCounts = daySeries.map((entry) => Number(entry.orderCount || 0));
      const maxOrderCount = Math.max(...orderCounts, 0);
      const defaultCurrency = String(((chartData[0] && chartData[0].currency) || (data[0] && data[0].currency) || "MAD")).toUpperCase();
      const formatAxisMoney = (value) => {
        if (value <= 0) return "0 " + defaultCurrency;
        if (value >= 1000) {
          return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(value / 1000) + " k " + defaultCurrency;
        }
        return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(value) + " " + defaultCurrency;
      };
      if (!showRevenueCurve && !showScoreCurve) {
        kpiRevenueChartEl.innerHTML =
          "<svg viewBox='0 0 640 220' preserveAspectRatio='none'>" +
            "<line x1='56' y1='182' x2='626' y2='182' stroke='#e4e7ea' stroke-width='1'/>" +
            "<text x='320' y='112' text-anchor='middle' fill='#9aa0a6' font-size='13'>Activez au moins une courbe</text>" +
          "</svg>";
        return;
      }
      if ((showRevenueCurve && maxValue <= 0) && (!showScoreCurve || maxOrderCount <= 0)) {
        kpiRevenueChartEl.innerHTML =
          "<svg viewBox='0 0 640 220' preserveAspectRatio='none'>" +
            "<line x1='56' y1='182' x2='626' y2='182' stroke='#e4e7ea' stroke-width='1'/>" +
            "<text x='320' y='112' text-anchor='middle' fill='#9aa0a6' font-size='13'>Pas encore de ventes sur la période sélectionnée</text>" +
          "</svg>";
        return;
      }

      const stepX = daySeries.length > 1 ? plotWidth / (daySeries.length - 1) : plotWidth;
      const revenueScaleMax = maxValue > 0 ? maxValue : 1;
      const points = values.map((value, index) => {
        const x = margin.left + stepX * index;
        const y = margin.top + (1 - value / revenueScaleMax) * plotHeight;
        return [x, y];
      });
      const linePath = points
        .map((point, index) => (index === 0 ? "M " + point[0] + " " + point[1] : "L " + point[0] + " " + point[1]))
        .join(" ");
      const rawScores = orderCounts.map((count) => (maxOrderCount > 0 ? (count / maxOrderCount) * 100 : 0));
      // Lissage simple pour une courbe volume plus lisible visuellement.
      const scoreValues = rawScores.map((_value, index) => {
        let sum = 0;
        let count = 0;
        for (let i = Math.max(0, index - 2); i <= Math.min(rawScores.length - 1, index + 2); i += 1) {
          sum += rawScores[i];
          count += 1;
        }
        return count > 0 ? sum / count : 0;
      });
      const scorePoints = scoreValues.map((score, index) => {
        const x = margin.left + stepX * index;
        const y = margin.top + (1 - score / 100) * plotHeight;
        return [x, y];
      });
      const scorePath = scorePoints
        .map((point, index) => (index === 0 ? "M " + point[0] + " " + point[1] : "L " + point[0] + " " + point[1]))
        .join(" ");

      const yTicks = showRevenueCurve && maxValue > 0 ? [0, maxValue / 3, (maxValue * 2) / 3, maxValue] : [0];
      let yTickSvg = "";
      yTicks.forEach((value) => {
        const y = margin.top + (1 - value / revenueScaleMax) * plotHeight;
        yTickSvg +=
          "<line x1='" + margin.left + "' y1='" + y + "' x2='" + (margin.left + plotWidth) + "' y2='" + y + "' stroke='#e7eaed' stroke-width='1'/>" +
          "<text x='6' y='" + (y + 4) + "' fill='#008060' font-size='11'>" + formatAxisMoney(value) + "</text>";
      });

      const xTickIndices = [0, Math.floor((daySeries.length - 1) / 3), Math.floor(((daySeries.length - 1) * 2) / 3), daySeries.length - 1];
      let xTickSvg = "";
      xTickIndices.forEach((index) => {
        const x = margin.left + stepX * index;
        const date = new Date(daySeries[index].key + "T00:00:00");
        const label = date.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
        xTickSvg += "<text x='" + x + "' y='" + (height - 8) + "' text-anchor='middle' fill='#8a8f95' font-size='11'>" + label + "</text>";
      });

      kpiRevenueChartEl.innerHTML =
        "<svg viewBox='0 0 640 220' preserveAspectRatio='none'>" +
          yTickSvg +
          (showRevenueCurve
            ? "<path d='" + linePath + "' fill='none' stroke='#008060' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'/>"
            : "") +
          (showScoreCurve
            ? "<path d='" + scorePath + "' fill='none' stroke='#f08a24' stroke-width='2.8' stroke-linecap='round' stroke-linejoin='round'/>"
            : "") +
          "<line id='revHoverLine' x1='0' y1='" + margin.top + "' x2='0' y2='" + (margin.top + plotHeight) + "' stroke='#d0d4d8' stroke-width='1' visibility='hidden'/>" +
          (showRevenueCurve
            ? "<circle id='revHoverDot' cx='0' cy='0' r='4' fill='#008060' stroke='#ffffff' stroke-width='2' visibility='hidden'/>"
            : "") +
          (showScoreCurve
            ? "<circle id='revHoverDotScore' cx='0' cy='0' r='4.5' fill='#f08a24' stroke='#ffffff' stroke-width='2' visibility='hidden'/>"
            : "") +
          xTickSvg +
        "</svg>" +
        (showScoreCurve ? "<div class='rev-score-scale'><span>100</span><span>0</span></div>" : "") +
        "<div id='revChartTooltip' class='kpi-chart-tooltip'>" +
          "<div class='title'>Ventes totales</div>" +
          "<div class='meta'><span class='dot'></span><span class='date'></span></div>" +
          (showRevenueCurve ? "<div id='revAmountMeta' class='amount'></div>" : "") +
          (showScoreCurve ? "<div id='revScoreMeta' class='meta'><span class='dot' style='background:#f08a24;'></span><span class='score'></span></div>" : "") +
        "</div>";

      const svg = kpiRevenueChartEl.querySelector("svg");
      const hoverLine = kpiRevenueChartEl.querySelector("#revHoverLine");
      const hoverDot = kpiRevenueChartEl.querySelector("#revHoverDot");
      const hoverDotScore = kpiRevenueChartEl.querySelector("#revHoverDotScore");
      const tooltip = kpiRevenueChartEl.querySelector("#revChartTooltip");
      const tooltipDate = tooltip.querySelector(".date");
      const tooltipAmount = kpiRevenueChartEl.querySelector("#revAmountMeta");
      const tooltipScore = tooltip.querySelector("#revScoreMeta .score");

      function hideTooltip() {
        hoverLine.setAttribute("visibility", "hidden");
        if (hoverDot) hoverDot.setAttribute("visibility", "hidden");
        if (hoverDotScore) hoverDotScore.setAttribute("visibility", "hidden");
        tooltip.style.display = "none";
      }

      function showAt(clientX) {
        const rect = svg.getBoundingClientRect();
        const localX = Math.max(margin.left, Math.min(margin.left + plotWidth, ((clientX - rect.left) / rect.width) * width));
        const index = Math.max(0, Math.min(daySeries.length - 1, Math.round((localX - margin.left) / stepX)));
        const point = points[index];
        const scorePoint = scorePoints[index];
        const seriesItem = daySeries[index];
        const x = point[0];
        const y = point[1];
        const yScore = scorePoint[1];
        const dayOrders = Number(seriesItem.orderCount || 0);
        const orderScore = maxOrderCount > 0 ? Math.round(scoreValues[index]) : 0;

        hoverLine.setAttribute("x1", String(x));
        hoverLine.setAttribute("x2", String(x));
        hoverLine.setAttribute("visibility", "visible");
        if (hoverDot) {
          hoverDot.setAttribute("cx", String(x));
          hoverDot.setAttribute("cy", String(y));
          hoverDot.setAttribute("visibility", "visible");
        }
        if (hoverDotScore) {
          hoverDotScore.setAttribute("cx", String(x));
          hoverDotScore.setAttribute("cy", String(yScore));
          hoverDotScore.setAttribute("visibility", "visible");
        }

        const showDate = new Date(seriesItem.key + "T00:00:00").toLocaleDateString("fr-FR", {
          day: "numeric",
          month: "short",
          year: "numeric"
        });
        tooltipDate.textContent = showDate;
        if (tooltipAmount) tooltipAmount.textContent = formatMoney(seriesItem.value, defaultCurrency);
        if (tooltipScore) tooltipScore.textContent = "Score commandes: " + orderScore + "/100 (" + dayOrders + " cmd)";
        tooltip.style.display = "block";
        if (y < margin.top + 30) {
          tooltip.classList.add("flip");
        } else {
          tooltip.classList.remove("flip");
        }
        tooltip.style.left = ((x / width) * rect.width) + "px";
        tooltip.style.top = ((y / height) * rect.height - 10) + "px";
      }

      svg.addEventListener("mousemove", (event) => showAt(event.clientX));
      svg.addEventListener("mouseleave", hideTooltip);
      svg.addEventListener("touchmove", (event) => {
        if (!event.touches || event.touches.length === 0) return;
        showAt(event.touches[0].clientX);
      }, { passive: true });
      svg.addEventListener("touchend", hideTooltip, { passive: true });
    }

    function syncCurveToggleUi() {
      showRevenueCurve = !!toggleRevenueCurveEl.checked;
      showScoreCurve = !!toggleScoreCurveEl.checked;
      if (toggleRevenueCurveCardEl) {
        toggleRevenueCurveCardEl.classList.toggle("active", showRevenueCurve);
      }
      if (toggleScoreCurveCardEl) {
        toggleScoreCurveCardEl.classList.toggle("active", showScoreCurve);
      }
      if (toggleRevenueCurveStateEl) {
        toggleRevenueCurveStateEl.textContent = "CA";
      }
      if (toggleScoreCurveStateEl) {
        toggleScoreCurveStateEl.textContent = "Score";
      }
    }

    function buildDeliveryTurns(data) {
      const candidates = data.filter((order) => order.shippingStatus !== "shipped");
      return candidates.sort((a, b) => {
        const shipA = a.shippingDate ? new Date(a.shippingDate).getTime() : Number.POSITIVE_INFINITY;
        const shipB = b.shippingDate ? new Date(b.shippingDate).getTime() : Number.POSITIVE_INFINITY;
        if (shipA !== shipB) return shipA - shipB;
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      });
    }

    function paymentCountDetails(order) {
      const raw = String(order.paymentGateway || "").trim();
      if (!raw) return { count: 0, methods: [] };
      const methods = Array.from(
        new Set(
          raw
            .split(/[,\|\/;+]+/)
            .map((item) => item.trim())
            .filter(Boolean)
        )
      );
      return { count: methods.length || 1, methods };
    }

    function formatPaymentDateLabel(value) {
      const raw = String(value || "").trim();
      if (!raw) return "-";
      const date = new Date(raw);
      if (Number.isNaN(date.getTime())) return "-";
      return date.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
    }

    function orderMatchesSearch(order, term) {
      if (!term) return true;
      const normalizedTerm = String(term || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
      const articleTitles = (order.articles || []).map((article) => String(article.title || "")).join(" ");
      const searchableRaw = [
        order.name,
        order.id,
        order.customerLabel,
        order.customerPhone,
        order.customerEmail,
        order.orderLocation,
        order.paymentGateway,
        order.shippingAddress,
        order.billingAddress,
        articleTitles
      ]
        .filter(Boolean)
        .join(" ");
      const searchable = searchableRaw
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();

      if (searchable.includes(normalizedTerm)) return true;

      const chequeTerms = ["chequier", "cheque", "check", "chq"];
      if (chequeTerms.includes(normalizedTerm)) {
        return chequeTerms.some((word) => searchable.includes(word));
      }

      return false;
    }

    function getVisibleOrders() {
      const term = String(orderSearchTerm || "").trim().toLowerCase();
      if (!term) return orders;
      return orders.filter((order) => orderMatchesSearch(order, term));
    }

    function updateKpis(data) {
      const unpaidCount = data.filter((order) => Number(order.outstandingAmount || 0) > 0).length;
      const shippedCount = data.filter((order) => String(order.shippingStatus) === "shipped").length;
      const inProgressCount = data.filter((order) => String(order.shippingStatus) !== "shipped").length;
      const revenueByCurrency = new Map();
      const cashRevenueByCurrency = new Map();
      const transferRevenueByCurrency = new Map();
      const chequeRevenueByCurrency = new Map();
      const totalsByCurrency = new Map();
      const customerOrderCounts = new Map();
      const articleTypeCounts = {
        djellaba: 0,
        caftan: 0,
        gandoura: 0,
        kimono: 0,
        autres: 0
      };
      let totalArticles = 0;

      data.forEach((order) => {
        const totalAmount = Number(order.totalAmount || 0);
        const currency = String(order.currency || "MAD").toUpperCase();
        if (totalAmount > 0) {
          revenueByCurrency.set(currency, (revenueByCurrency.get(currency) || 0) + totalAmount);
          if (isCashGateway(order.paymentGateway)) {
            cashRevenueByCurrency.set(currency, (cashRevenueByCurrency.get(currency) || 0) + totalAmount);
          }
          if (isTransferGateway(order.paymentGateway)) {
            transferRevenueByCurrency.set(currency, (transferRevenueByCurrency.get(currency) || 0) + totalAmount);
          }
          if (isChequeGateway(order.paymentGateway)) {
            chequeRevenueByCurrency.set(currency, (chequeRevenueByCurrency.get(currency) || 0) + totalAmount);
          }
        }
        const customerKey = orderCustomerKey(order);
        customerOrderCounts.set(customerKey, (customerOrderCounts.get(customerKey) || 0) + 1);

        const outstanding = Number(order.outstandingAmount || 0);
        if (outstanding <= 0) return;
        totalsByCurrency.set(currency, (totalsByCurrency.get(currency) || 0) + outstanding);
      });

      data.forEach((order) => {
        (order.articles || []).forEach((article) => {
          const qty = Math.max(1, Number(article.quantity || 1));
          totalArticles += qty;
          const typeKey = detectArticleType(article.title);
          articleTypeCounts[typeKey] += qty;
        });
      });

      const revenueEntries = Array.from(revenueByCurrency.entries()).sort((a, b) => a[0].localeCompare(b[0]));
      const cashRevenueEntries = Array.from(cashRevenueByCurrency.entries()).sort((a, b) => a[0].localeCompare(b[0]));
      const transferRevenueEntries = Array.from(transferRevenueByCurrency.entries()).sort((a, b) => a[0].localeCompare(b[0]));
      const chequeRevenueEntries = Array.from(chequeRevenueByCurrency.entries()).sort((a, b) => a[0].localeCompare(b[0]));
      const revenueMadApprox = revenueEntries.reduce(
        (sum, [currency, amount]) => sum + toMadApprox(amount, currency),
        0
      );
      const cashRevenueMadApprox = cashRevenueEntries.reduce(
        (sum, [currency, amount]) => sum + toMadApprox(amount, currency),
        0
      );
      const transferRevenueMadApprox = transferRevenueEntries.reduce(
        (sum, [currency, amount]) => sum + toMadApprox(amount, currency),
        0
      );
      const chequeRevenueMadApprox = chequeRevenueEntries.reduce(
        (sum, [currency, amount]) => sum + toMadApprox(amount, currency),
        0
      );
      if (revenueEntries.length === 0) {
        kpiRevenueTotalEl.textContent = "0";
        renderCurrencyBreakdown(kpiRevenueBreakdownEl, []);
        if (kpiRevenueCardEl) kpiRevenueCardEl.classList.remove("multi-currency");
      } else if (revenueEntries.length === 1) {
        const [currency, amount] = revenueEntries[0];
        kpiRevenueTotalEl.textContent = formatMoney(amount, currency);
        renderCurrencyBreakdown(kpiRevenueBreakdownEl, [[currency, amount]]);
        if (kpiRevenueCardEl) kpiRevenueCardEl.classList.remove("multi-currency");
      } else {
        kpiRevenueTotalEl.textContent = "≃ " + formatMoney(revenueMadApprox, "MAD");
        renderCurrencyBreakdown(kpiRevenueBreakdownEl, revenueEntries);
        if (kpiRevenueCardEl) kpiRevenueCardEl.classList.add("multi-currency");
      }
      renderRevenueChart(data);

      const entries = Array.from(totalsByCurrency.entries()).sort((a, b) => a[0].localeCompare(b[0]));
      if (entries.length === 0) {
        kpiUnpaidTotalEl.textContent = "0";
        renderCurrencyBreakdown(kpiUnpaidBreakdownEl, []);
        if (kpiUnpaidCardEl) kpiUnpaidCardEl.classList.remove("multi-currency");
      } else if (entries.length === 1) {
        const [currency, amount] = entries[0];
        kpiUnpaidTotalEl.textContent = formatMoney(amount, currency);
        renderCurrencyBreakdown(kpiUnpaidBreakdownEl, [[currency, amount]]);
        if (kpiUnpaidCardEl) kpiUnpaidCardEl.classList.remove("multi-currency");
      } else {
        const totalMadApprox = entries.reduce(
          (sum, [currency, amount]) => sum + toMadApprox(amount, currency),
          0
        );
        kpiUnpaidTotalEl.textContent = "≃ " + formatMoney(totalMadApprox, "MAD");
        renderCurrencyBreakdown(kpiUnpaidBreakdownEl, entries);
        if (kpiUnpaidCardEl) kpiUnpaidCardEl.classList.add("multi-currency");
      }

      kpiOrdersCountEl.textContent = String(data.length);
      kpiArticlesSummaryEl.innerHTML =
        "<span class='kpi-break-item'>" +
        totalArticles +
        " article(s)</span>" +
        "<span class='kpi-break-item'>Djellaba: " +
        articleTypeCounts.djellaba +
        "</span>" +
        "<span class='kpi-break-item'>Caftan/Tenue/Takchita: " +
        articleTypeCounts.caftan +
        "</span>" +
        "<span class='kpi-break-item'>Gandoura: " +
        articleTypeCounts.gandoura +
        "</span>" +
        "<span class='kpi-break-item'>Kimono: " +
        articleTypeCounts.kimono +
        "</span>" +
        "<span class='kpi-break-item'>Autres: " +
        articleTypeCounts.autres +
        "</span>";
      const uniqueCustomerCount = customerOrderCounts.size;
      const repeatCustomerCount = Array.from(customerOrderCounts.values()).filter((count) => count > 1).length;
      const repeatCustomerRate = uniqueCustomerCount > 0 ? (repeatCustomerCount / uniqueCustomerCount) * 100 : 0;
      const periodSubtitle =
        syncFromEl && syncToEl && syncFromEl.value && syncToEl.value
          ? "du " + syncFromEl.value + " au " + syncToEl.value
          : "sur période chargée";

      if (cashRevenueEntries.length === 0) {
        kpiInsightRevenueEl.textContent = "0";
      } else if (cashRevenueEntries.length === 1) {
        const [currency, amount] = cashRevenueEntries[0];
        kpiInsightRevenueEl.textContent = formatMoney(amount, currency);
      } else {
        kpiInsightRevenueEl.textContent = "≃ " + formatMoney(cashRevenueMadApprox, "MAD");
      }
      kpiInsightRevenueSubEl.textContent = periodSubtitle + " (paiement en espèces)";

      if (data.length === 0) {
        kpiInsightAovEl.textContent = "0";
      } else if (revenueEntries.length === 1) {
        const [currency, amount] = revenueEntries[0];
        kpiInsightAovEl.textContent = formatMoney(amount / data.length, currency);
      } else {
        kpiInsightAovEl.textContent = "≃ " + formatMoney(revenueMadApprox / data.length, "MAD");
      }
      kpiInsightAovSubEl.textContent = periodSubtitle;

      kpiInsightRepeatRateEl.textContent = repeatCustomerRate.toFixed(1) + "%";
      kpiInsightRepeatRateSubEl.textContent = repeatCustomerCount + " / " + uniqueCustomerCount + " clients";

      if (transferRevenueEntries.length === 0) {
        kpiTransferSalesEl.textContent = "0";
      } else if (transferRevenueEntries.length === 1) {
        const [currency, amount] = transferRevenueEntries[0];
        kpiTransferSalesEl.textContent = formatMoney(amount, currency);
      } else {
        kpiTransferSalesEl.textContent = "≃ " + formatMoney(transferRevenueMadApprox, "MAD");
      }
      kpiTransferSalesSubEl.textContent = periodSubtitle;

      if (chequeRevenueEntries.length === 0) {
        kpiChequeSalesEl.textContent = "0";
      } else if (chequeRevenueEntries.length === 1) {
        const [currency, amount] = chequeRevenueEntries[0];
        kpiChequeSalesEl.textContent = formatMoney(amount, currency);
      } else {
        kpiChequeSalesEl.textContent = "≃ " + formatMoney(chequeRevenueMadApprox, "MAD");
      }
      kpiChequeSalesSubEl.textContent = periodSubtitle;

      kpiUnpaidEl.textContent = String(unpaidCount);
      kpiShippedEl.textContent = String(shippedCount);
      kpiInProgressEl.textContent = String(inProgressCount);
    }

    function renderOrdersView() {
      const visibleOrders = getVisibleOrders();

      if (visibleOrders.length === 0) {
        ordersListEl.innerHTML = "<div class='status'>Aucun résultat pour votre recherche.</div>";
        deliveryQueueListEl.innerHTML = "<div class='status'>Aucune livraison pour cette recherche.</div>";
        orderDetailEl.innerHTML = "<div class='detail-empty'>Aucune commande sélectionnée.</div>";
        return;
      }

      if (!selectedOrderId || !visibleOrders.some((order) => order.id === selectedOrderId)) {
        selectedOrderId = visibleOrders[0].id;
      }

      ordersListEl.innerHTML =
        "<table class='orders-table'>" +
        "<thead><tr>" +
        "<th>Commande</th>" +
        "<th>Date</th>" +
        "<th>Client</th>" +
        "<th>Reste à payer</th>" +
        "<th>Statut du paiement</th>" +
        "<th>Livraison</th>" +
        "</tr></thead><tbody></tbody></table>";

      const tbody = ordersListEl.querySelector("tbody");
      visibleOrders.forEach((order) => {
        const row = document.createElement("tr");
        if (order.id === selectedOrderId) {
          row.className = "active-row";
        }

        const shippingClass = order.shippingStatus === "shipped" ? "pill shipped" : "pill";
        row.innerHTML =
          "<td><strong>" +
          order.name +
          "</strong><div class='customer-sub'>#" +
          order.id +
          "</div></td>" +
          "<td>" +
          formatOrderDateLabel(order.createdAt) +
          "</td>" +
          "<td><div class='customer-main'>" +
          (order.customerLabel || "Client inconnu") +
          "</div><div class='customer-sub'>" +
          "Tél: " +
          customerPhoneLabel(order) +
          " · " +
          order.articles.length +
          " article(s)</div></td>" +
          "<td>" +
          remainingAmountLabel(order) +
          "</td>" +
          "<td>" +
          paymentBadgeHtml(order) +
          "</td>" +
          "<td><span class='" +
          shippingClass +
          "'>" +
          statusLabel(order.shippingStatus) +
          "</span></td>";
        row.addEventListener("click", () => {
          selectedOrderId = order.id;
          renderOrderDetail(order);
          loadOrders();
        });
        tbody.appendChild(row);
      });

      renderDeliveryQueue(visibleOrders);

      const selected = visibleOrders.find((order) => order.id === selectedOrderId);
      if (selected) renderOrderDetail(selected);
    }

    function refreshLocationOptions(data) {
      const values = new Set();
      defaultLocationOptions.forEach((location) => values.add(location));
      data.forEach((order) => {
        const value = String(order.orderLocation || "").trim();
        if (value && value.toLowerCase() !== "non renseigné") {
          values.add(value);
        }
      });
      locationOptions = Array.from(values).sort((a, b) => a.localeCompare(b));
    }

    async function loadOrders() {
      const query = new URLSearchParams();
      if (syncFromEl && syncFromEl.value) query.set("from", syncFromEl.value);
      if (syncToEl && syncToEl.value) query.set("to", syncToEl.value);
      const res = await fetch("/admin/api/orders" + (query.toString() ? "?" + query.toString() : ""));
      const parsed = await readJsonSafe(res);
      if (!parsed.ok) {
        ordersListEl.innerHTML = "<div class='status'>Impossible de charger les commandes.</div>";
        return;
      }

      orders = parsed.data.orders || [];
      if (orders.length === 0) {
        ordersListEl.innerHTML = "<div class='status'>Aucune commande chargée. Cliquez sur Synchroniser les commandes.</div>";
        deliveryQueueListEl.innerHTML = "<div class='status'>Aucune livraison en attente.</div>";
        orderDetailEl.innerHTML = "<div class='detail-empty'>Aucune commande sélectionnée.</div>";
        updateKpis([]);
        return;
      }

      refreshLocationOptions(orders);
      updateKpis(orders);
      renderOrdersView();
    }

    function renderDeliveryQueue(data) {
      const turns = buildDeliveryTurns(data);
      if (turns.length === 0) {
        deliveryQueueListEl.innerHTML = "<div class='status'>Aucune livraison en attente.</div>";
        return;
      }

      deliveryQueueListEl.innerHTML =
        "<table class='orders-table'>" +
        "<thead><tr>" +
        "<th>Tour</th>" +
        "<th>Commande</th>" +
        "<th>Client</th>" +
        "<th>Date livraison</th>" +
        "<th>Statut</th>" +
        "</tr></thead><tbody></tbody></table>";

      const tbody = deliveryQueueListEl.querySelector("tbody");
      turns.forEach((order, index) => {
        const row = document.createElement("tr");
        row.innerHTML =
          "<td><strong>" +
          (index + 1) +
          "</strong></td>" +
          "<td>" +
          order.name +
          "</td>" +
          "<td>" +
          (order.customerLabel || "Client inconnu") +
          "<div class='customer-sub'>Tél: " +
          customerPhoneLabel(order) +
          "</div>" +
          "</td>" +
          "<td>" +
          (order.shippingDate ? String(order.shippingDate).slice(0, 10) : "Non planifiée") +
          "</td>" +
          "<td><span class='pill'>" +
          statusLabel(order.shippingStatus) +
          "</span></td>";
        row.addEventListener("click", () => {
          selectedOrderId = order.id;
          renderOrderDetail(order);
          loadOrders();
        });
        tbody.appendChild(row);
      });
    }

    function renderOrderDetail(order) {
      orderDetailEl.innerHTML = "";
      const detail = document.createElement("div");
      const needsBankDetails = Number(order.outstandingAmount || 0) > 0;
      const createdDate = new Date(order.createdAt);
      const createdDateLabel = createdDate.toLocaleDateString("fr-FR");
      const createdTimeLabel = createdDate.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
      const clientInfoRows = [
        "<div class='info-item'><div class='info-label'>Client</div><div class='info-value'>" +
          (order.customerLabel || "Client inconnu") +
          "</div></div>",
        "<div class='info-item'><div class='info-label'>Téléphone</div><div class='info-value'>" +
          customerPhoneLabel(order) +
          "</div></div>"
      ];
      if (order.customerEmail) {
        clientInfoRows.push(
          "<div class='info-item'><div class='info-label'>Email</div><div class='info-value'>" +
            order.customerEmail +
            "</div></div>"
        );
      }
      if (order.shippingAddress) {
        clientInfoRows.push(
          "<div class='info-item'><div class='info-label'>Adresse d'expédition</div><div class='info-value'>" +
            order.shippingAddress +
            "</div></div>"
        );
      }
      if (order.billingAddress) {
        clientInfoRows.push(
          "<div class='info-item'><div class='info-label'>Adresse de facturation</div><div class='info-value'>" +
            order.billingAddress +
            "</div></div>"
        );
      }
      const paymentDetails = paymentCountDetails(order);
      const paymentTransactions = Array.isArray(order.paymentTransactions) ? order.paymentTransactions : [];
      const paymentBreakdown = Array.isArray(order.paymentBreakdown) ? order.paymentBreakdown : [];
      const paymentCountText = paymentTransactions.length > 0 ? String(paymentTransactions.length) : String(paymentDetails.count);
      const paymentRows = paymentTransactions.length
        ? paymentTransactions.map((entry, index) => ({
            idx: index + 1,
            method: escapeHtml(entry.gateway || "Autre"),
            amount: formatMoney(Number(entry.amount || 0), entry.currency || order.currency),
            occurredAt: String(entry.occurredAt || "")
          }))
        : paymentBreakdown.length
          ? paymentBreakdown.map((entry, index) => ({
              idx: index + 1,
              method: escapeHtml(entry.gateway || "Autre"),
              amount: formatMoney(Number(entry.amount || 0), entry.currency || order.currency),
              occurredAt: ""
            }))
          : paymentDetails.methods.length === 1
            ? [
                {
                  idx: 1,
                  method: escapeHtml(paymentDetails.methods[0]),
                  amount: formatMoney(
                    Math.max(0, Number(order.totalAmount || 0) - Number(order.outstandingAmount || 0)),
                    order.currency
                  ),
                  occurredAt: ""
                }
              ]
            : [];
      paymentRows.sort((a, b) => {
        const ta = Date.parse(String(a.occurredAt || ""));
        const tb = Date.parse(String(b.occurredAt || ""));
        const aValid = Number.isFinite(ta);
        const bValid = Number.isFinite(tb);
        if (aValid && bValid) return ta - tb;
        if (aValid) return -1;
        if (bValid) return 1;
        return 0;
      });
      const paymentBreakdownTableHtml = paymentRows.length
        ? "<table class='payment-detail-table'><tbody>" +
          paymentRows
            .map((row) => "<tr><td>" + row.method + "</td><td class='d'>" + formatPaymentDateLabel(row.occurredAt) + "</td><td class='r'>" + row.amount + "</td></tr>")
            .join("") +
          "</tbody></table>"
        : "<span>Montants par moyen non disponibles</span>";
      const paymentInfoRows = [
        "<div class='info-item'><div class='info-label'>Statut</div><div class='info-value'>" +
          paymentLabel(order) +
          "</div></div>",
        "<div class='info-item'><div class='info-label'>Nombre de paiements</div><div class='info-value'>" +
          paymentCountText +
          "</div></div>",
        "<div class='info-item'><div class='info-label'>Détail des paiements</div><div class='info-value'>" +
          paymentBreakdownTableHtml +
          "</div></div>",
        "<div class='info-item'><div class='info-label'>Total</div><div class='info-value'>" +
          formatMoney(order.totalAmount || 0, order.currency) +
          "</div></div>"
      ];
      if (Number(order.outstandingAmount || 0) > 0) {
        paymentInfoRows.push(
          "<div class='info-item'><div class='info-label'>Reste à payer</div><div class='info-value'>" +
            remainingAmountLabel(order) +
            "</div></div>"
        );
      }
      const gatewayTag = order.paymentGateway
        ? "<span class='badge-status gateway'><span class='badge-icon'>●</span>" + escapeHtml(order.paymentGateway) + "</span>"
        : "";
      detail.innerHTML =
        "<div class='line detail-title-row'><strong>" +
        order.name +
        "</strong><span class='pill'>Rang #" +
        order.rank +
        "</span></div>" +
        "<div class='order-meta-row'>" +
        paymentBadgeHtml(order) +
        treatmentBadgeHtml(order) +
        gatewayTag +
        "</div>" +
        "<div class='status'>Reçu le " +
        createdDateLabel +
        " à " +
        createdTimeLabel +
        " · " +
        (order.orderLocation || "Non renseigné") +
        "</div>" +
        "<div class='order-shell'>" +
          "<div class='order-card'>" +
            "<h4>Client</h4>" +
            "<div class='info-list'>" +
            clientInfoRows.join("") +
            "</div>" +
            "<div class='line' style='margin-top:10px; gap:8px;'>" +
              "<button type='button' id='reviewBtn' class='save-order-btn' style='margin-top:0;'>Envoyer demande avis Google</button>" +
            "</div>" +
          "</div>" +
          "<div class='order-card'>" +
            "<h4>Traitement</h4>" +
            "<div class='status'>Statut de livraison et date planifiée</div>" +
            "<div id='quickOrderForm'></div>" +
          "</div>" +
          "<div class='order-card'>" +
            "<h4>Paiement</h4>" +
            "<div class='info-list'>" +
            paymentInfoRows.join("") +
            "</div>" +
            "<div class='line' style='margin-top:10px; gap:8px;'>" +
              "<button type='button' id='printInvoiceBtn' class='save-order-btn' style='margin-top:0;'>Imprimer facture</button>" +
              "<button type='button' id='printReceiptBtn' class='save-order-btn btn-secondary' style='margin-top:0;'>Imprimer reçu</button>" +
              "<button type='button' id='sendClientBtn' class='save-order-btn' style='margin-top:0;'>Envoyer au client</button>" +
              "<button type='button' id='sendMaisonBtn' class='save-order-btn btn-secondary' style='margin-top:0;'>Envoyer à Bouchra</button>" +
            "</div>" +
          "</div>" +
        "</div>";

      const form = document.createElement("form");
      form.innerHTML =
        "<div class='detail-grid'>" +
        "<div><label>Statut de livraison</label><select name='shippingStatus'>" +
        "<option value='in_progress'>En cours</option>" +
        "<option value='ready'>Prête</option>" +
        "<option value='shipped'>Expédiée</option>" +
        "</select></div>" +
        "<div><label>Date de livraison</label><input type='date' name='shippingDate' /></div>" +
        "<div><label>Emplacement commande</label><select name='orderLocation'></select></div>" +
        "<div id='orderLocationCustomWrap' class='hidden'><label>Autre emplacement</label><input type='text' name='orderLocationCustom' placeholder='Ex: POS Casa Centre' /></div>" +
        "</div>" +
        "<div class='articles'></div>" +
        "<button type='submit' class='save-order-btn'>Enregistrer les modifications</button> <span class='status' id='saveOrderStatus'></span>";

      form.shippingStatus.value = order.shippingStatus;
      form.shippingDate.value = order.shippingDate ? String(order.shippingDate).slice(0, 10) : "";
      const locationSelect = form.orderLocation;
      const locationCustomWrap = form.querySelector("#orderLocationCustomWrap");
      const locationCustomInput = form.orderLocationCustom;

      const options = Array.from(new Set([...locationOptions, order.orderLocation || ""])).filter(Boolean);
      if (options.length === 0) {
        options.push("Non renseigné");
      }

      locationSelect.innerHTML = "";
      options.forEach((value) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value;
        locationSelect.appendChild(option);
      });
      const customOption = document.createElement("option");
      customOption.value = "__custom__";
      customOption.textContent = "Autre...";
      locationSelect.appendChild(customOption);

      const currentLocation = order.orderLocation && order.orderLocation !== "Non renseigné" ? order.orderLocation : "";
      if (currentLocation && !options.includes(currentLocation)) {
        locationSelect.value = "__custom__";
        locationCustomInput.value = currentLocation;
      } else if (currentLocation) {
        locationSelect.value = currentLocation;
      } else {
        locationSelect.value = options[0];
      }

      function syncCustomLocationVisibility() {
        const isCustom = locationSelect.value === "__custom__";
        locationCustomWrap.classList.toggle("hidden", !isCustom);
        if (!isCustom) {
          locationCustomInput.value = "";
        }
      }

      locationSelect.addEventListener("change", syncCustomLocationVisibility);
      syncCustomLocationVisibility();

      const articlesEl = form.querySelector(".articles");
      order.articles.forEach((article) => {
        const row = document.createElement("div");
        row.className = "article-row";
        row.innerHTML =
          "<div class='article-title'>" +
          article.title +
          " x" +
          article.quantity +
          "</div>" +
          "<select data-article-id='" +
          article.id +
          "'>" +
          "<option value='pending'>En attente</option>" +
          "<option value='in_progress'>En cours</option>" +
          "<option value='prepared'>Préparé</option>" +
          "<option value='shipped'>Expédié</option>" +
          "</select>";
        const select = row.querySelector("select");
        select.value = article.status;
        articlesEl.appendChild(row);
      });

      const quickContainer = detail.querySelector("#quickOrderForm");
      quickContainer.appendChild(form);
      const reviewBtn = detail.querySelector("#reviewBtn");
      const sendClientBtn = detail.querySelector("#sendClientBtn");
      const sendMaisonBtn = detail.querySelector("#sendMaisonBtn");
      const printInvoiceBtn = detail.querySelector("#printInvoiceBtn");
      const printReceiptBtn = detail.querySelector("#printReceiptBtn");
      const maisonPhone = "+212661981392";

      async function fetchFreshOrderSnapshot() {
        const res = await fetch("/admin/api/orders/" + encodeURIComponent(order.id));
        const parsed = await readJsonSafe(res);
        if (!parsed.ok || !parsed.data) {
          throw new Error(parsed.ok ? "Commande introuvable" : "Impossible de recharger la commande.");
        }
        return parsed.data;
      }

      async function sendDocument(recipientPhone, initialTemplateChoice, options = {}) {
        try {
          const latestOrder = await fetchFreshOrderSnapshot();
          const latestNeedsBankDetails = Number(latestOrder.outstandingAmount || 0) > 0;
          syncStatusEl.textContent = "Préparation du document...";
          const modalResult = await openInvoiceModal(latestOrder, latestNeedsBankDetails, initialTemplateChoice);
          if (!modalResult) {
            syncStatusEl.textContent = "Envoi annulé.";
            return;
          }

          const templateChoice = modalResult.templateChoice || "classic";
          const requestedTemplateChoices = Array.from(new Set(
            Array.isArray(options.templateChoices) && options.templateChoices.length > 0
              ? options.templateChoices
              : (options.sendCompanionReceipt
                  ? ["classic", "showroom_receipt"]
                  : [templateChoice])
          ));
          const documentLabels = requestedTemplateChoices.map((choice) => choice === "showroom_receipt" ? "reçu" : "facture");
          const documentLabel = documentLabels.length > 1 ? "facture et reçu" : documentLabels[0];
          const destinationLabel = recipientPhone === maisonPhone
            ? "Bouchra Filali Lahlou"
            : (latestOrder.customerLabel || "le client");
          const confirmed = window.confirm(
            "Confirmer l'envoi du " + documentLabel + " pour " + latestOrder.name + " a " + destinationLabel + " ?"
          );
          if (!confirmed) {
            syncStatusEl.textContent = "Envoi annulé.";
            return;
          }

          if (modalResult.bankDetails) {
            await fetch("/admin/api/orders/" + encodeURIComponent(latestOrder.id), {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ bankDetails: modalResult.bankDetails })
            });
          }

          syncStatusEl.textContent = requestedTemplateChoices.length > 1 ? "Envoi des PDF en cours..." : "Envoi API en cours...";
          const sendRes = await fetch("/admin/api/orders/" + encodeURIComponent(latestOrder.id) + "/send-invoice-template", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              templateChoice,
              templateChoices: requestedTemplateChoices,
              recipientPhone: recipientPhone
            })
          });
          const parsed = await readJsonSafe(sendRes);
          if (!sendRes.ok) {
            const errMsg = extractApiErrorMessage(parsed, "Réponse invalide API.");
            syncStatusEl.textContent = "Envoi API échoué: " + errMsg;
            return;
          }
          const sentCount = Array.isArray(parsed.data?.results) ? parsed.data.results.length : requestedTemplateChoices.length;
          syncStatusEl.textContent = sentCount > 1
            ? "Facture et reçu envoyés via API template."
            : documentLabel.charAt(0).toUpperCase() + documentLabel.slice(1) + " envoye via API template.";
        } catch (error) {
          syncStatusEl.textContent =
            "Envoi API échoué: " +
            (error instanceof Error ? error.message : "Erreur inattendue");
        }
      }

      sendClientBtn.addEventListener("click", async () => {
        await sendDocument(order.customerPhone || "", "classic");
      });

      sendMaisonBtn.addEventListener("click", async () => {
        await sendDocument(maisonPhone, "classic");
      });

      reviewBtn.addEventListener("click", async () => {
        try {
          syncStatusEl.textContent = "Envoi demande avis Google...";
          const sendRes = await fetch("/admin/api/orders/" + encodeURIComponent(order.id) + "/send-review-template", {
            method: "POST",
            headers: { "Content-Type": "application/json" }
          });
          const parsed = await readJsonSafe(sendRes);
          if (!sendRes.ok) {
            const errMsg = extractApiErrorMessage(parsed, "Réponse invalide API.");
            syncStatusEl.textContent = "Envoi API échoué: " + errMsg;
            return;
          }
          syncStatusEl.textContent = "Demande d'avis Google envoyée via WhatsApp.";
        } catch (error) {
          syncStatusEl.textContent =
            "Envoi API échoué: " +
            (error instanceof Error ? error.message : "Erreur inattendue");
        }
      });

      async function printDocument(initialTemplateChoice) {
        const latestOrder = await fetchFreshOrderSnapshot();
        const latestNeedsBankDetails = Number(latestOrder.outstandingAmount || 0) > 0;
        const modalResult = await openInvoiceModal(latestOrder, latestNeedsBankDetails, initialTemplateChoice);
        if (!modalResult) return;
        if (modalResult.bankDetails) {
          await fetch("/admin/api/orders/" + encodeURIComponent(latestOrder.id), {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ bankDetails: modalResult.bankDetails })
          });
        }
        const html = buildInvoiceHtml(latestOrder, modalResult.bankDetails, modalResult.templateChoice);
        const popup = window.open("", "_blank");
        if (!popup) {
          syncStatusEl.textContent = "Autorisez les popups pour imprimer la facture.";
          return;
        }
        popup.document.open();
        popup.document.write(html);
        popup.document.close();
        popup.focus();
        popup.print();
      }

      printInvoiceBtn.addEventListener("click", async () => {
        await printDocument("classic");
      });

      printReceiptBtn.addEventListener("click", async () => {
        await printDocument("showroom_receipt");
      });

      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const saveStatus = form.querySelector("#saveOrderStatus");
        const articleRows = Array.from(form.querySelectorAll("select[data-article-id]"));
        const payload = {
          shippingStatus: form.shippingStatus.value,
          shippingDate: form.shippingDate.value || null,
          orderLocation:
            form.orderLocation.value === "__custom__"
              ? (form.orderLocationCustom.value || "").trim()
              : (form.orderLocation.value || "").trim(),
          articles: articleRows.map((select) => ({
            id: select.getAttribute("data-article-id"),
            status: select.value
          }))
        };

        saveStatus.textContent = "Enregistrement...";
        const res = await fetch("/admin/api/orders/" + encodeURIComponent(order.id), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });

        if (!res.ok) {
          const parsedError = await readJsonSafe(res);
          saveStatus.textContent = parsedError.ok ? (parsedError.data.error || "Échec de l'enregistrement") : "Échec de l'enregistrement";
          return;
        }

        saveStatus.textContent = "Enregistré";
        await loadOrders();
        setTimeout(() => {
          saveStatus.textContent = "";
        }, 1200);
      });

      orderDetailEl.appendChild(detail);
    }

    function validDateRange(from, to) {
      if (!from || !to) return false;
      return new Date(from + "T00:00:00Z").getTime() <= new Date(to + "T00:00:00Z").getTime();
    }

    async function syncOrders() {
      const from = syncFromEl.value;
      const to = syncToEl.value;
      if (!validDateRange(from, to)) {
        syncStatusEl.textContent = "Plage de dates invalide.";
        return;
      }
      // Keep the UI responsive by showing the latest available data immediately.
      void loadOrders();
      chartRangeFrom = from;
      chartRangeTo = to;
      if (syncInFlight) {
        syncQueued = true;
        return;
      }
      syncInFlight = true;
      syncQueued = false;
      const runId = ++syncRunId;
      syncStatusEl.textContent = "Synchronisation...";

      const res = await fetch("/admin/api/orders/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, to })
      });

      if (!res.ok) {
        const parsedError = await readJsonSafe(res);
        if (runId === syncRunId) {
          syncStatusEl.textContent = parsedError.ok ? (parsedError.data.error || "Échec de la synchronisation") : "Échec de la synchronisation";
        }
        syncInFlight = false;
        if (syncQueued) syncOrders();
        return;
      }

      const parsed = await readJsonSafe(res);
      if (!parsed.ok) {
        if (runId === syncRunId) {
          syncStatusEl.textContent = "Échec de la synchronisation";
        }
        syncInFlight = false;
        if (syncQueued) syncOrders();
        return;
      }

      if (runId === syncRunId) {
        syncStatusEl.textContent = "Synchronisées: " + parsed.data.syncedOrders + " commande(s)";
        await loadOrders();
      }
      syncInFlight = false;
      if (syncQueued) syncOrders();
    }

    function scheduleSync(delayMs = 280) {
      if (syncDebounceTimer) {
        clearTimeout(syncDebounceTimer);
      }
      syncDebounceTimer = setTimeout(() => {
        syncDebounceTimer = null;
        syncOrders();
      }, delayMs);
    }

    presetRangeEl.addEventListener("change", () => {
      if (presetRangeEl.value !== "custom") {
        applyPreset(presetRangeEl.value);
      } else {
        syncPeriodHorizonUi("custom");
      }
      chartRangeFrom = syncFromEl.value;
      chartRangeTo = syncToEl.value;
      updateKpis(orders);
      scheduleSync(180);
    });

    syncFromEl.addEventListener("change", () => {
      presetRangeEl.value = "custom";
      syncPeriodHorizonUi("custom");
      chartRangeFrom = syncFromEl.value;
      chartRangeTo = syncToEl.value;
      updateKpis(orders);
      scheduleSync();
    });

    syncToEl.addEventListener("change", () => {
      presetRangeEl.value = "custom";
      syncPeriodHorizonUi("custom");
      chartRangeFrom = syncFromEl.value;
      chartRangeTo = syncToEl.value;
      updateKpis(orders);
      scheduleSync();
    });

    if (periodHorizonBarEl) {
      periodHorizonBarEl.addEventListener("click", (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const btn = target.closest(".period-horizon-btn[data-period-preset]");
        if (!(btn instanceof HTMLElement)) return;
        const preset = btn.getAttribute("data-period-preset") || "year";
        presetRangeEl.value = preset;
        applyPreset(preset);
        chartRangeFrom = syncFromEl.value;
        chartRangeTo = syncToEl.value;
        updateKpis(orders);
        scheduleSync(180);
      });
    }

    orderSearchEl.addEventListener("input", () => {
      orderSearchTerm = orderSearchEl.value || "";
      renderOrdersView();
    });
    toggleRevenueCurveEl.addEventListener("change", () => {
      syncCurveToggleUi();
      renderRevenueChart(orders);
    });
    toggleScoreCurveEl.addEventListener("change", () => {
      syncCurveToggleUi();
      renderRevenueChart(orders);
    });
    syncCurveToggleUi();

    presetRangeEl.value = "year";
    applyPreset("year");
    syncOrders();
  </script>
</body>
</html>`);
});

adminRouter.get("/invoices", (req, res) => {
  const host: string = typeof req.query.host === "string" ? req.query.host : "";
  const shop: string = typeof req.query.shop === "string" ? req.query.shop : "";
  const embedded: string = typeof req.query.embedded === "string" ? req.query.embedded : "";
  const navParams = new URLSearchParams();
  if (host) navParams.set("host", host);
  if (shop) navParams.set("shop", shop);
  if (embedded) navParams.set("embedded", embedded);
  const navSuffix = navParams.toString() ? `?${navParams.toString()}` : "";

  res.type("html").send(`<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="shopify-api-key" content="${env.SHOPIFY_API_KEY}" />
  <title>Factures</title>
  <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
  <style>
    :root {
      --bg: #f6f6f7;
      --panel: #ffffff;
      --text: #202223;
      --muted: #6d7175;
      --border: #e1e3e5;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; background: var(--bg); color: var(--text); }
    .wrap { max-width: 1480px; margin: 20px auto; padding: 0 14px 24px; }
    .top { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 10px; }
    h1 { margin: 0; font-size: 30px; font-weight: 700; }
    .intro { margin: 0 0 14px; color: var(--muted); font-size: 14px; }
    button { border: 1px solid #5e656d; border-radius: 10px; background: linear-gradient(180deg, #3d434b 0%, #23282f 100%); color: #fff; text-decoration: none; min-height: 34px; padding: 0 14px; font-size: 13px; font-weight: 700; line-height: 1; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
    .layout { display: grid; grid-template-columns: 1.05fr 0.95fr; gap: 14px; }
    .card { border: 1px solid var(--border); background: var(--panel); border-radius: 12px; padding: 14px; box-shadow: 0 1px 0 rgba(0, 0, 0, 0.04); }
    .section-title { margin: 0 0 10px; font-size: 20px; font-weight: 700; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .full { grid-column: 1 / -1; }
    label { display: block; margin: 0 0 6px; font-size: 13px; color: var(--muted); }
    input, select, textarea { width: 100%; border: 1px solid var(--border); border-radius: 8px; padding: 10px; font-size: 14px; font-family: inherit; background: #fff; }
    textarea { min-height: 74px; resize: vertical; }
    .line-items { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; margin-top: 4px; }
    .line-items table { width: 100%; border-collapse: collapse; }
    .line-items th, .line-items td { border-bottom: 1px solid var(--border); padding: 8px; text-align: left; vertical-align: middle; }
    .line-items th { background: #f6f6f7; color: #5f6368; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; }
    .line-items td input { padding: 8px; font-size: 13px; }
    .line-items td:last-child, .line-items th:last-child { width: 76px; text-align: center; }
    .muted-btn { border: 1px solid #c7c9cc; border-radius: 8px; background: #fff; color: #202223; min-height: 30px; padding: 0 10px; font-size: 12px; font-weight: 600; }
    .switch-row { display: flex; align-items: center; gap: 10px; margin-top: 4px; flex-wrap: wrap; }
    .switch-row input[type="checkbox"] { width: auto; transform: scale(1.1); }
    .totals { border: 1px solid var(--border); border-radius: 10px; padding: 12px; background: #fbfbfb; display: grid; gap: 6px; margin-top: 10px; }
    .totals .row { display: flex; justify-content: space-between; gap: 10px; font-size: 14px; }
    .totals .row strong { font-size: 16px; }
    .actions { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
    .preview { width: 100%; min-height: 76vh; border: 1px solid var(--border); border-radius: 10px; background: #fff; }
    @media (max-width: 1100px) {
      .layout { grid-template-columns: 1fr; }
      .grid { grid-template-columns: 1fr; }
      .preview { min-height: 56vh; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <h1>Factures</h1>
    </div>
    <ui-nav-menu>
      <a href="/admin${navSuffix}">Commandes</a>
      <a href="/admin/invoices${navSuffix}">Factures</a>
      <a href="/admin/insights${navSuffix}">Insights</a>
      <a href="/admin/appointments${navSuffix}">Rendez-vous</a>
      <a href="/admin/forecast${navSuffix}">Forecast</a>
      <a href="/admin/ml${navSuffix}">ML Dashboard</a>
      <a href="/admin/priority${navSuffix}">Priority</a>
      <a href="/blueprint${navSuffix}">Blueprint</a>
      <a href="/admin/spline${navSuffix}">Spline</a>
      <a href="/admin/whatsapp-intelligence${navSuffix}">WhatsApp Intelligence</a>
    </ui-nav-menu>
    <p class="intro">Version 1: génération manuelle premium avec modèles Bouchra / Coin de Couture.</p>
    <div class="layout">
      <section class="card">
        <h2 class="section-title">Création de facture</h2>
        <form id="invoiceForm">
          <div class="grid">
            <div>
              <label for="modelType">Modèle</label>
              <select id="modelType">
                <option value="classic">Modèle Bouchra Filali Lahlou</option>
                <option value="coin">Modèle Coin de Couture</option>
                <option value="showroom_receipt">Version 1 — Showroom Receipt (MAD, Cash/Card)</option>
                <option value="international_invoice">Version 2 — International Couture Invoice (€ / $)</option>
              </select>
            </div>
            <div>
              <label for="invoiceNumber">N° facture (INV-YYYY-0001)</label>
              <input id="invoiceNumber" type="text" />
            </div>
            <div>
              <label for="invoiceDate">Date facture</label>
              <input id="invoiceDate" type="date" />
            </div>
            <div>
              <label for="dueDate">Date échéance</label>
              <input id="dueDate" type="date" />
            </div>
            <div>
              <label for="currency">Devise</label>
              <select id="currency">
                <option value="MAD">MAD</option>
                <option value="EUR">EUR</option>
                <option value="USD">USD</option>
              </select>
            </div>
            <div>
              <label for="financialStatus">Statut</label>
              <select id="financialStatus">
                <option value="paid">Payée</option>
                <option value="partially_paid">Partielle</option>
                <option value="due">Due</option>
                <option value="proforma">Proforma</option>
              </select>
            </div>
            <div>
              <label for="customerName">Client</label>
              <input id="customerName" type="text" placeholder="Nom client" />
            </div>
            <div>
              <label for="customerPhone">Téléphone</label>
              <input id="customerPhone" type="text" placeholder="+212..." />
            </div>
            <div>
              <label for="customerEmail">Email</label>
              <input id="customerEmail" type="email" placeholder="client@email.com" />
            </div>
            <div>
              <label for="customerTaxId">ICE / IF client (optionnel)</label>
              <input id="customerTaxId" type="text" placeholder="ICE / IF" />
            </div>
            <div>
              <label for="paymentGateway">Passerelle paiement</label>
              <select id="paymentGateway">
                <option value="Cash">Cash</option>
                <option value="Virement">Virement</option>
                <option value="Carte">Carte</option>
                <option value="Autre">Autre</option>
              </select>
            </div>
            <div>
              <label for="depositAmount">Acompte versé</label>
              <input id="depositAmount" type="number" min="0" step="0.01" value="0" />
            </div>
            <div class="bouchra-only">
              <label for="productionTimeline">Timeline production</label>
              <input id="productionTimeline" type="text" placeholder="Ex: 4 weeks from measurement confirmation" />
            </div>
            <div class="bouchra-only">
              <label for="designCollection">Collection</label>
              <input id="designCollection" type="text" placeholder="Ex: Fall / Winter 2026" />
            </div>
            <div class="bouchra-only">
              <label for="designType">Type</label>
              <input id="designType" type="text" placeholder="Ex: Demi-mesure couture" />
            </div>
            <div class="bouchra-only">
              <label for="designColor">Coloris</label>
              <input id="designColor" type="text" placeholder="Ex: Deep emerald" />
            </div>
            <div class="bouchra-only">
              <label for="designFabric">Tissu</label>
              <input id="designFabric" type="text" placeholder="Ex: Silk base with hand embroidery" />
            </div>
            <div class="bouchra-only">
              <label for="designCustomization">Personnalisation</label>
              <input id="designCustomization" type="text" placeholder="Ex: Tailored to client measurements" />
            </div>
            <div>
              <label for="discountAmount">Remise (montant)</label>
              <input id="discountAmount" type="number" min="0" step="0.01" value="0" />
            </div>
            <div>
              <label for="shippingAmount">Livraison (montant)</label>
              <input id="shippingAmount" type="number" min="0" step="0.01" value="0" />
            </div>
            <div class="full">
              <label for="billingAddress">Adresse de facturation</label>
              <textarea id="billingAddress" placeholder="Adresse facturation (optionnelle)"></textarea>
            </div>
            <div class="full">
              <label for="shippingAddress">Adresse de livraison</label>
              <textarea id="shippingAddress" placeholder="Adresse livraison (optionnelle)"></textarea>
            </div>
            <div class="full">
              <label>Produits</label>
              <div class="line-items">
                <table>
                  <thead>
                    <tr>
                      <th>Article</th>
                      <th>Qté</th>
                      <th>Prix unitaire</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody id="lineItemsBody"></tbody>
                </table>
              </div>
              <div style="margin-top:8px;">
                <button type="button" id="addLineBtn" class="muted-btn">Ajouter une ligne</button>
              </div>
            </div>
            <div class="full">
              <label>TVA</label>
              <div class="switch-row">
                <input id="withVat" type="checkbox" />
                <span>Activer la TVA</span>
                <input id="vatRate" type="number" min="0" max="100" step="0.01" value="0" style="max-width:120px;" />
                <span>%</span>
              </div>
            </div>
          </div>
          <div class="totals">
            <div class="row"><span>Sous-total</span><span id="subtotalView">0</span></div>
            <div class="row"><span>Remise</span><span id="discountView">0</span></div>
            <div class="row"><span>Livraison</span><span id="shippingView">0</span></div>
            <div class="row"><span>TVA</span><span id="vatView">0</span></div>
            <div class="row"><strong>Total</strong><strong id="totalView">0</strong></div>
            <div class="row"><span>Acompte versé</span><span id="depositView">0</span></div>
            <div class="row"><span>Solde dû</span><span id="outstandingView">0</span></div>
          </div>
          <div class="actions">
            <button type="button" id="previewBtn">Aperçu</button>
            <button type="button" id="printBtn">Imprimer / Télécharger PDF</button>
          </div>
        </form>
      </section>
      <section class="card">
        <h2 class="section-title">Aperçu</h2>
        <iframe id="previewFrame" class="preview"></iframe>
      </section>
    </div>
  </div>
  <script>
    (() => {
      const apiKey = document.querySelector('meta[name="shopify-api-key"]')?.content || "";
      const host = new URLSearchParams(window.location.search).get("host") || "";
      const appBridge = window["app-bridge"];
      if (!apiKey || !host || !appBridge?.default) return;
      try {
        appBridge.default({ apiKey, host, forceRedirect: true });
      } catch (err) {
        console.warn("App Bridge init failed", err);
      }
    })();
  </script>
  <script>
    const modelTypeEl = document.getElementById("modelType");
    const invoiceNumberEl = document.getElementById("invoiceNumber");
    const invoiceDateEl = document.getElementById("invoiceDate");
    const dueDateEl = document.getElementById("dueDate");
    const currencyEl = document.getElementById("currency");
    const customerNameEl = document.getElementById("customerName");
    const customerPhoneEl = document.getElementById("customerPhone");
    const customerEmailEl = document.getElementById("customerEmail");
    const customerTaxIdEl = document.getElementById("customerTaxId");
    const paymentGatewayEl = document.getElementById("paymentGateway");
    const financialStatusEl = document.getElementById("financialStatus");
    const depositAmountEl = document.getElementById("depositAmount");
    const productionTimelineEl = document.getElementById("productionTimeline");
    const designCollectionEl = document.getElementById("designCollection");
    const designTypeEl = document.getElementById("designType");
    const designColorEl = document.getElementById("designColor");
    const designFabricEl = document.getElementById("designFabric");
    const designCustomizationEl = document.getElementById("designCustomization");
    const discountAmountEl = document.getElementById("discountAmount");
    const shippingAmountEl = document.getElementById("shippingAmount");
    const billingAddressEl = document.getElementById("billingAddress");
    const shippingAddressEl = document.getElementById("shippingAddress");
    const lineItemsBodyEl = document.getElementById("lineItemsBody");
    const addLineBtn = document.getElementById("addLineBtn");
    const withVatEl = document.getElementById("withVat");
    const vatRateEl = document.getElementById("vatRate");
    const subtotalViewEl = document.getElementById("subtotalView");
    const discountViewEl = document.getElementById("discountView");
    const shippingViewEl = document.getElementById("shippingView");
    const vatViewEl = document.getElementById("vatView");
    const totalViewEl = document.getElementById("totalView");
    const depositViewEl = document.getElementById("depositView");
    const outstandingViewEl = document.getElementById("outstandingView");
    const previewBtn = document.getElementById("previewBtn");
    const printBtn = document.getElementById("printBtn");
    const previewFrame = document.getElementById("previewFrame");

    function esc(value) {
      return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function fmtMoney(amount, currency) {
      return new Intl.NumberFormat("fr-FR", {
        style: "currency",
        currency: currency || "MAD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      }).format(Number(amount || 0));
    }

    function formatInvoiceNumber(raw, dateIso) {
      const year = String(dateIso || new Date().toISOString().slice(0, 10)).slice(0, 4);
      const text = String(raw || "").trim().toUpperCase();
      const valid = text.match(/^INV-(\\d{4})-(\\d{1,4})$/);
      if (valid) {
        return "INV-" + year + "-" + String(Number(valid[2]) || 1).padStart(4, "0");
      }
      const fallbackDigits = text.match(/(\\d{1,4})$/);
      const seq = fallbackDigits ? Number(fallbackDigits[1]) || 1 : 1;
      return "INV-" + year + "-" + String(seq).padStart(4, "0");
    }

    function normalizeInvoiceField() {
      invoiceNumberEl.value = formatInvoiceNumber(invoiceNumberEl.value, invoiceDateEl.value);
    }

    function addLine(item) {
      const tr = document.createElement("tr");
      tr.innerHTML =
        "<td><input type='text' class='li-title' placeholder='Nom article' value='" + esc(item && item.title ? item.title : "") + "' /></td>" +
        "<td><input type='number' class='li-qty' min='1' step='1' value='" + String(item && item.qty ? item.qty : 1) + "' /></td>" +
        "<td><input type='number' class='li-price' min='0' step='0.01' value='" + String(item && item.price ? item.price : 0) + "' /></td>" +
        "<td><button type='button' class='muted-btn li-remove'>Suppr.</button></td>";
      lineItemsBodyEl.appendChild(tr);
      tr.querySelectorAll("input").forEach((el) => el.addEventListener("input", renderTotals));
      tr.querySelector(".li-remove").addEventListener("click", () => {
        tr.remove();
        renderTotals();
      });
    }

    function paymentLabel(status) {
      if (status === "paid") return "Payée";
      if (status === "partially_paid") return "Partielle";
      if (status === "proforma") return "Proforma";
      return "Due";
    }

    function paymentLabelEn(status) {
      if (status === "paid") return "Paid";
      if (status === "partially_paid") return "Partially Paid";
      if (status === "proforma") return "Proforma";
      return "Due";
    }

    function paymentMethodLabelEn(method) {
      const text = String(method || "").toLowerCase();
      if (!text) return "Cash (Showroom)";
      if (text.includes("cash")) return "Cash (Showroom)";
      if (text.includes("carte") || text.includes("card")) return "Card";
      if (text.includes("virement") || text.includes("bank")) return "Bank Transfer";
      return String(method);
    }

    function collectData() {
      normalizeInvoiceField();
      const items = Array.from(lineItemsBodyEl.querySelectorAll("tr"))
        .map((row) => ({
          title: row.querySelector(".li-title").value.trim(),
          qty: Math.max(1, Number(row.querySelector(".li-qty").value || 1)),
          price: Math.max(0, Number(row.querySelector(".li-price").value || 0))
        }))
        .filter((item) => item.title);

      const subtotal = items.reduce((sum, it) => sum + it.qty * it.price, 0);
      const discountAmount = Math.max(0, Number(discountAmountEl.value || 0));
      const shippingAmount = Math.max(0, Number(shippingAmountEl.value || 0));
      const taxableBase = Math.max(0, subtotal - discountAmount + shippingAmount);
      const vatRate = withVatEl.checked ? Math.max(0, Number(vatRateEl.value || 0)) : 0;
      const vatAmount = taxableBase * vatRate / 100;
      const total = taxableBase + vatAmount;
      const status = financialStatusEl.value;
      const depositInput = Math.max(0, Number(depositAmountEl.value || 0));
      const depositAmount = status === "paid" ? total : Math.min(depositInput, total);
      const outstanding = Math.max(0, total - depositAmount);

      return {
        modelType: modelTypeEl.value,
        invoiceNumber: invoiceNumberEl.value.trim(),
        invoiceDate: invoiceDateEl.value || new Date().toISOString().slice(0, 10),
        dueDate: dueDateEl.value || "",
        currency: currencyEl.value,
        customerName: customerNameEl.value.trim() || "Client",
        customerPhone: customerPhoneEl.value.trim(),
        customerEmail: customerEmailEl.value.trim(),
        customerTaxId: customerTaxIdEl.value.trim(),
        paymentGateway: paymentGatewayEl.value,
        financialStatus: status,
        productionTimeline: productionTimelineEl.value.trim(),
        designCollection: designCollectionEl.value.trim(),
        designType: designTypeEl.value.trim(),
        designColor: designColorEl.value.trim(),
        designFabric: designFabricEl.value.trim(),
        designCustomization: designCustomizationEl.value.trim(),
        billingAddress: billingAddressEl.value.trim(),
        shippingAddress: shippingAddressEl.value.trim(),
        items,
        withVat: withVatEl.checked,
        vatRate,
        subtotal,
        discountAmount,
        shippingAmount,
        vatAmount,
        total,
        depositAmount,
        outstanding
      };
    }

    function renderTotals() {
      const data = collectData();
      subtotalViewEl.textContent = fmtMoney(data.subtotal, data.currency);
      discountViewEl.textContent = data.discountAmount > 0 ? "-" + fmtMoney(data.discountAmount, data.currency) : "-";
      shippingViewEl.textContent = data.shippingAmount > 0 ? fmtMoney(data.shippingAmount, data.currency) : "-";
      vatViewEl.textContent = data.withVat ? fmtMoney(data.vatAmount, data.currency) : "-";
      totalViewEl.textContent = fmtMoney(data.total, data.currency);
      depositViewEl.textContent = data.depositAmount > 0 ? fmtMoney(data.depositAmount, data.currency) : "-";
      outstandingViewEl.textContent = fmtMoney(data.outstanding, data.currency);
    }

    function lineRowsHtml(data, borderColor) {
      return data.items.map((item) =>
        "<tr>" +
          "<td style='padding:10px 12px;border-bottom:1px solid " + borderColor + ";'>" + item.qty + "</td>" +
          "<td style='padding:10px 12px;border-bottom:1px solid " + borderColor + ";font-weight:500;'>" + esc(item.title) + "</td>" +
          "<td style='padding:10px 12px;border-bottom:1px solid " + borderColor + ";text-align:right;'>" + fmtMoney(item.price * item.qty, data.currency) + "</td>" +
        "</tr>"
      ).join("");
    }

    function buildClassicHtml(data) {
      const discountRow = data.discountAmount > 0 ? "<tr><td colspan='2' style='text-align:right;padding:10px 12px;'>Remise</td><td style='text-align:right;padding:10px 12px;'>-" + fmtMoney(data.discountAmount, data.currency) + "</td></tr>" : "";
      const shippingRow = data.shippingAmount > 0 ? "<tr><td colspan='2' style='text-align:right;padding:10px 12px;'>Livraison</td><td style='text-align:right;padding:10px 12px;'>" + fmtMoney(data.shippingAmount, data.currency) + "</td></tr>" : "";
      const vatRow = data.withVat ? "<tr><td colspan='2' style='text-align:right;padding:10px 12px;'>TVA (" + data.vatRate + "%)</td><td style='text-align:right;padding:10px 12px;'>" + fmtMoney(data.vatAmount, data.currency) + "</td></tr>" : "";
      const outstandingRow = data.outstanding > 0 ? "<tr><td colspan='2' style='text-align:right;padding:12px;border-top:1px solid #f0f0f0;'><strong>Montant impayé</strong></td><td style='text-align:right;padding:12px;border-top:1px solid #f0f0f0;color:#b41c18;'><strong>" + fmtMoney(data.outstanding, data.currency) + "</strong></td></tr>" : "";
      return "<!doctype html><html><head><meta charset='utf-8' /><title>Facture " + esc(data.invoiceNumber) + "</title>" +
        "<style>body{max-width:860px;margin:0 auto;font-family:'Helvetica Neue',Arial,sans-serif;line-height:1.55;color:#222;padding:24px;background:#fff}table{width:100%;border-collapse:collapse;margin-bottom:12px;font-size:14px}thead tr{background:#fafafa}th{font-weight:600;text-align:left;padding:10px 12px}.cards{display:flex;gap:12px;flex-wrap:wrap}.box{flex:1;min-width:180px;background:#fff;padding:16px;border-radius:10px;border:1px solid #f0f0f0}</style></head><body>" +
        "<div style='display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:16px;'><div style='display:flex;align-items:center;gap:12px;'><img src='https://cdn.shopify.com/s/files/1/0551/5558/9305/files/loooogoooo.png?v=1727896750' style='max-width:150px;height:auto;' alt='Logo' /><div style='font-size:14px;color:#555;'><strong style='display:block;color:#222;'>Bouchra Filali Lahlou</strong>www.bouchrafilalilahlou.com<br/>contact@bouchrafilalilahlou.com</div></div><div style='text-align:right;background:#f6f6f8;padding:10px 12px;border-radius:8px;border:1px solid #eee;'><div style='font-size:12px;color:#777;'>Facture</div><div style='font-size:16px;font-weight:700;'>" + esc(data.invoiceNumber) + "</div></div></div>" +
        "<div style='display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;'><h1 style='margin:0;font-size:22px;'>Facture</h1><div style='text-align:right;color:#555;font-size:14px;'>Statut : " + paymentLabel(data.financialStatus) + "<br/>Date: " + esc(data.invoiceDate) + "</div></div>" +
        "<div class='cards' style='margin-bottom:14px;'><div class='box'><strong>Client</strong><br/>" + esc(data.customerName) + "<br/>" + (data.customerPhone ? esc(data.customerPhone) + "<br/>" : "") + (data.customerEmail ? esc(data.customerEmail) : "") + "</div><div class='box'><strong>Adresse de facturation</strong><br/>" + (data.billingAddress ? esc(data.billingAddress).replace(/\\n/g, "<br/>") : "<span style='color:#888;'>Non fournie</span>") + "</div><div class='box'><strong>Adresse de livraison</strong><br/>" + (data.shippingAddress ? esc(data.shippingAddress).replace(/\\n/g, "<br/>") : "<span style='color:#888;'>Non fournie</span>") + "</div></div>" +
        "<table><thead><tr><th>Qté</th><th>Article</th><th style='text-align:right;'>Prix</th></tr></thead><tbody>" +
          lineRowsHtml(data, "#eee") +
          "<tr><td colspan='2' style='text-align:right;padding:10px 12px;'>Sous-total</td><td style='text-align:right;padding:10px 12px;'>" + fmtMoney(data.subtotal, data.currency) + "</td></tr>" +
          discountRow + shippingRow + vatRow +
          "<tr><td colspan='2' style='text-align:right;padding:12px;border-top:1px solid #f0f0f0;'><strong>Total</strong></td><td style='text-align:right;padding:12px;border-top:1px solid #f0f0f0;'><strong>" + fmtMoney(data.total, data.currency) + "</strong></td></tr>" +
          "<tr><td colspan='2' style='text-align:right;padding:8px 12px;'>Acompte versé</td><td style='text-align:right;padding:8px 12px;'>" + fmtMoney(data.depositAmount, data.currency) + "</td></tr>" +
          outstandingRow +
        "</tbody></table>" +
        "<div style='margin-top:18px;padding:14px;border-radius:8px;background:#fff;border:1px solid #f0f0f0;font-size:14px;color:#333;'><strong>Merci pour votre confiance.</strong></div>" +
      "</body></html>";
    }

    function buildCoinHtml(data) {
      const discountRow = data.discountAmount > 0 ? "<tr><td colspan='2' class='lbl'>Remise</td><td class='val'>-" + fmtMoney(data.discountAmount, data.currency) + "</td></tr>" : "";
      const shippingRow = data.shippingAmount > 0 ? "<tr><td colspan='2' class='lbl'>Livraison</td><td class='val'>" + fmtMoney(data.shippingAmount, data.currency) + "</td></tr>" : "";
      const vatRow = data.withVat ? "<tr><td colspan='2' class='lbl'>TVA (" + data.vatRate + "%)</td><td class='val'>" + fmtMoney(data.vatAmount, data.currency) + "</td></tr>" : "";
      const outstandingRow = data.outstanding > 0 ? "<tr class='due'><td colspan='2' class='lbl'><strong>Solde dû</strong></td><td class='val'><strong>" + fmtMoney(data.outstanding, data.currency) + "</strong></td></tr>" : "";
      const customerTaxLine = data.customerTaxId ? "<div><span class='meta-k'>ICE/IF</span><span class='meta-v'>" + esc(data.customerTaxId) + "</span></div>" : "";
      return "<!doctype html><html><head><meta charset='utf-8' /><title>Facture " + esc(data.invoiceNumber) + "</title>" +
        "<style>@page{size:A4;margin:14mm 12mm 18mm}html,body{margin:0;padding:0;background:#fff;color:#111;font-family:'Inter','Helvetica Neue',Helvetica,Arial,sans-serif}*{box-sizing:border-box}" +
        ".page{padding:2mm 0 16mm}.top{display:grid;grid-template-columns:1.4fr 1fr;gap:24px;align-items:start;margin-bottom:22px}" +
        ".brand{display:grid;grid-template-columns:62px 1fr;gap:14px;align-items:start}.logo{width:62px;height:62px;border:1px solid #1f1f1f;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;letter-spacing:.12em}" +
        ".brand h1{margin:0;font-size:17px;letter-spacing:.14em;font-weight:700}.brand .small{font-size:12px;color:#333;line-height:1.5}" +
        ".invoice-box{border:1px solid #d9d9d9;border-radius:10px;padding:14px 16px}.invoice-title{font-size:30px;letter-spacing:.08em;font-weight:750;margin:0 0 10px}" +
        ".kv{display:grid;grid-template-columns:94px 1fr;gap:8px;font-size:13px;line-height:1.45;padding:2px 0}.kv .k{color:#555}.kv .v{font-weight:600}" +
        ".sep{border-top:1px solid #e6e6e6;margin:14px 0}.client{border:1px solid #ddd;border-radius:10px;padding:14px 16px;margin-bottom:16px}.client h3{margin:0 0 10px;font-size:14px;letter-spacing:.07em;text-transform:uppercase}" +
        ".client-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 18px}.meta-k{display:block;font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.04em}.meta-v{display:block;font-size:13px;font-weight:500}" +
        "table{width:100%;border-collapse:collapse;font-size:13px}thead{display:table-header-group}thead th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#4c4c4c;border-bottom:1px solid #d7d7d7;padding:9px 10px}" +
        "tbody td{padding:10px;border-bottom:1px solid #ededed;vertical-align:top}tbody tr{break-inside:avoid;page-break-inside:avoid}.amt{text-align:right}" +
        ".totals{margin-top:12px;border:1px solid #d7d7d7;border-radius:10px;padding:10px 14px;max-width:360px;margin-left:auto;break-inside:avoid;page-break-inside:avoid}.totals table{font-size:13px}" +
        ".totals .lbl{text-align:left;color:#4d4d4d;padding:6px 0}.totals .val{text-align:right;padding:6px 0}.totals .due .val,.totals .due .lbl{color:#111}" +
        ".footer{position:fixed;left:12mm;right:12mm;bottom:6mm;padding-top:6px;border-top:1px solid #dcdcdc;display:flex;justify-content:space-between;font-size:11px;color:#666}" +
        ".page-num:after{content:counter(page)}.pages-num:after{content:counter(pages)}" +
        "@media screen{body{padding:20px}.page{max-width:840px;margin:0 auto;padding-bottom:20px}.footer{position:static;margin-top:14px}}" +
        "</style></head><body><div class='page'>" +
        "<div class='top'>" +
          "<div class='brand'><div class='logo'>CDC</div><div><h1>COIN DE COUTURE</h1><div class='small'>Siège Social 19 ET 21 ROND POINT DES SPORTS QUARTIER RACINE, Casablanca<br/>ICE 002031076000092<br/>RC (Registre analytique): 401313<br/>contact@bouchrafilalilahlou.com</div></div></div>" +
          "<div class='invoice-box'><h2 class='invoice-title'>FACTURE</h2>" +
            "<div class='kv'><span class='k'>Numéro</span><span class='v'>" + esc(data.invoiceNumber) + "</span></div>" +
            "<div class='kv'><span class='k'>Date</span><span class='v'>" + esc(data.invoiceDate) + "</span></div>" +
            "<div class='kv'><span class='k'>Échéance</span><span class='v'>" + (data.dueDate ? esc(data.dueDate) : "-") + "</span></div>" +
            "<div class='kv'><span class='k'>Statut</span><span class='v'>" + paymentLabel(data.financialStatus) + "</span></div>" +
          "</div>" +
        "</div>" +
        "<div class='client'><h3>Client</h3><div class='client-grid'>" +
          "<div><span class='meta-k'>Nom</span><span class='meta-v'>" + esc(data.customerName) + "</span></div>" +
          "<div><span class='meta-k'>Téléphone</span><span class='meta-v'>" + (data.customerPhone ? esc(data.customerPhone) : "-") + "</span></div>" +
          "<div><span class='meta-k'>Email</span><span class='meta-v'>" + (data.customerEmail ? esc(data.customerEmail) : "-") + "</span></div>" +
          customerTaxLine +
          "<div><span class='meta-k'>Adresse</span><span class='meta-v'>" + (data.billingAddress ? esc(data.billingAddress).replace(/\\n/g, "<br/>") : "-") + "</span></div>" +
          "<div><span class='meta-k'>Adresse livraison</span><span class='meta-v'>" + (data.shippingAddress ? esc(data.shippingAddress).replace(/\\n/g, "<br/>") : "-") + "</span></div>" +
        "</div></div>" +
        "<table><thead><tr><th style='width:60px'>Qté</th><th>Article</th><th class='amt' style='width:170px'>Montant</th></tr></thead><tbody>" +
          lineRowsHtml(data, "#ededed") +
        "</tbody></table>" +
        "<div class='totals'><table>" +
          "<tr><td class='lbl'>Sous-total</td><td class='val'>" + fmtMoney(data.subtotal, data.currency) + "</td></tr>" +
          discountRow +
          shippingRow +
          vatRow +
          "<tr><td class='lbl'><strong>Total</strong></td><td class='val'><strong>" + fmtMoney(data.total, data.currency) + "</strong></td></tr>" +
          "<tr><td class='lbl'>Acompte versé</td><td class='val'>" + fmtMoney(data.depositAmount, data.currency) + "</td></tr>" +
          outstandingRow +
        "</table></div>" +
        "<div class='footer'><span>COIN DE COUTURE · " + esc(data.paymentGateway) + "</span><span>Page <span class='page-num'></span> / <span class='pages-num'></span></span></div>" +
      "</div></body></html>";
    }

    function buildShowroomReceiptHtml(data) {
      const itemsHtml = data.items.map((item) =>
        "<tr>" +
          "<td style='padding:8px 10px;border-bottom:1px solid #ececec;'>" + item.qty + "</td>" +
          "<td style='padding:8px 10px;border-bottom:1px solid #ececec;font-weight:600;'>" + esc(item.title) + "</td>" +
          "<td style='padding:8px 10px;border-bottom:1px solid #ececec;text-align:right;'>" + fmtMoney(item.price * item.qty, data.currency || "MAD") + "</td>" +
        "</tr>"
      ).join("");
      return "<!doctype html><html><head><meta charset='utf-8' /><title>Showroom Receipt " + esc(data.invoiceNumber) + "</title>" +
        "<style>@page{size:A4;margin:12mm}html,body{margin:0;padding:0;background:#fff;color:#111;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif}" +
        ".page{padding:8mm 6mm}.header{text-align:center;margin-bottom:14px}.brand{font-family:Georgia,'Times New Roman',serif;letter-spacing:.1em;font-size:18px;font-weight:600;text-transform:uppercase}" +
        ".meta{font-size:12px;color:#666;margin-top:6px}.title{font-size:13px;letter-spacing:.08em;text-transform:uppercase;margin-top:10px}" +
        ".boxes{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:14px 0}.box{border:1px solid #e8e8e8;border-radius:10px;padding:12px;break-inside:avoid;page-break-inside:avoid}" +
        ".box h3{margin:0 0 8px;font-size:12px;color:#666;text-transform:uppercase;letter-spacing:.07em}.row{display:grid;grid-template-columns:42% 58%;gap:4px;margin-bottom:6px;font-size:12.5px}" +
        ".k{color:#666}.v{font-weight:600}.sep{height:1px;background:#ececec;margin:12px 0}" +
        "table{width:100%;border-collapse:collapse;font-size:13px}thead th{text-align:left;color:#666;font-size:11px;text-transform:uppercase;letter-spacing:.07em;border-bottom:1px solid #e8e8e8;padding:8px 10px}" +
        "tbody tr{break-inside:avoid;page-break-inside:avoid}.totals{margin-top:10px;border:1px solid #e8e8e8;border-radius:10px;padding:10px;max-width:340px;margin-left:auto}" +
        ".tr{display:flex;justify-content:space-between;gap:10px;padding:4px 0;font-size:13px}.strong{font-weight:700}.note{margin-top:10px;font-size:12px;color:#666}" +
        "@media screen{body{background:#f6f6f6}.page{max-width:860px;margin:20px auto;background:#fff;box-shadow:0 8px 24px rgba(0,0,0,.08);padding:18mm 14mm}}" +
        "</style></head><body><div class='page'>" +
          "<div class='header'><div class='brand'>Maison Bouchra Filali Lahlou</div><div class='meta'>Casablanca, Morocco • contact@bouchrafilalilahlou.com • www.bouchrafilalilahlou.com</div><div class='title'>Showroom Receipt</div></div>" +
          "<div class='boxes'>" +
            "<div class='box'><h3>Order</h3>" +
              "<div class='row'><div class='k'>Number</div><div class='v'>" + esc(data.invoiceNumber) + "</div></div>" +
              "<div class='row'><div class='k'>Date</div><div class='v'>" + esc(data.invoiceDate) + "</div></div>" +
              "<div class='row'><div class='k'>Payment Status</div><div class='v'>" + esc(paymentLabelEn(data.financialStatus)) + "</div></div>" +
              "<div class='row'><div class='k'>Payment Method</div><div class='v'>" + esc(paymentMethodLabelEn(data.paymentGateway)) + "</div></div>" +
            "</div>" +
            "<div class='box'><h3>Client</h3>" +
              "<div class='row'><div class='k'>Name</div><div class='v'>" + esc(data.customerName) + "</div></div>" +
              "<div class='row'><div class='k'>Phone</div><div class='v'>" + (data.customerPhone ? esc(data.customerPhone) : "-") + "</div></div>" +
              "<div class='row'><div class='k'>Address</div><div class='v'>" + (data.shippingAddress ? esc(data.shippingAddress).replace(/\\n/g, "<br/>") : "-") + "</div></div>" +
            "</div>" +
          "</div>" +
          "<div class='sep'></div>" +
          "<table><thead><tr><th style='width:70px'>Qty</th><th>Description</th><th style='width:180px;text-align:right'>Amount</th></tr></thead><tbody>" +
            itemsHtml +
          "</tbody></table>" +
          "<div class='totals'>" +
            "<div class='tr'><span>Subtotal</span><span>" + fmtMoney(data.subtotal, data.currency || "MAD") + "</span></div>" +
            (data.discountAmount > 0 ? "<div class='tr'><span>Discount</span><span>-" + fmtMoney(data.discountAmount, data.currency || "MAD") + "</span></div>" : "") +
            (data.shippingAmount > 0 ? "<div class='tr'><span>Shipping</span><span>" + fmtMoney(data.shippingAmount, data.currency || "MAD") + "</span></div>" : "") +
            (data.withVat ? "<div class='tr'><span>Tax (" + data.vatRate + "%)</span><span>" + fmtMoney(data.vatAmount, data.currency || "MAD") + "</span></div>" : "") +
            "<div class='tr strong'><span>Total</span><span>" + fmtMoney(data.total, data.currency || "MAD") + "</span></div>" +
            "<div class='tr'><span>Deposit Paid</span><span>" + fmtMoney(data.depositAmount, data.currency || "MAD") + "</span></div>" +
            (data.outstanding > 0 ? "<div class='tr strong'><span>Balance Due</span><span>" + fmtMoney(data.outstanding, data.currency || "MAD") + "</span></div>" : "") +
          "</div>" +
          "<div class='note'>Issued by Maison Bouchra Filali Lahlou.</div>" +
        "</div></body></html>";
    }

    function buildMaisonReceiptHtml(data) {
      const firstDesignName = data.items.length ? data.items[0].title : "Design personnalisé";
      return "<!doctype html><html><head><meta charset='utf-8' /><title>Receipt " + esc(data.invoiceNumber) + "</title>" +
      "<style>:root{--ink:#121212;--muted:#646464;--paper:#fff;--rule:#e7e7e7}*{box-sizing:border-box}" +
      "@page{size:A4;margin:14mm 12mm 18mm}" +
      "html,body{margin:0;padding:0;background:#f6f6f6;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;line-height:1.35}" +
      ".page{width:210mm;min-height:297mm;margin:14mm auto;background:var(--paper);padding:16mm 14mm 20mm;box-shadow:0 8px 24px rgba(0,0,0,.08)}" +
      ".brand{text-align:center;margin-bottom:10mm}.brand .logo{font-family:Georgia,'Times New Roman',serif;letter-spacing:.12em;font-size:18px;font-weight:600;text-transform:uppercase}.brand .meta{margin-top:3.5mm;color:var(--muted);font-size:12px}" +
      ".title{text-align:center;margin:9mm 0 8mm;font-family:Georgia,'Times New Roman',serif;letter-spacing:.08em;text-transform:uppercase;font-size:14px}" +
      ".row{display:flex;gap:9mm;align-items:stretch}.col{flex:1}.card{border:1px solid var(--rule);padding:5.5mm;border-radius:10px;break-inside:avoid;page-break-inside:avoid}" +
      "h3{margin:0 0 3.8mm;font-size:11.8px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-weight:600}" +
      ".kv{display:grid;grid-template-columns:40% 60%;gap:2mm 4mm;font-size:12.5px}.k{color:var(--muted)}.v{font-weight:500}" +
      ".rule{height:1px;background:var(--rule);margin:8mm 0}" +
      "table{width:100%;border-collapse:collapse;font-size:12.5px}thead{display:table-header-group}tr{break-inside:avoid;page-break-inside:avoid}th,td{padding:3.2mm 0}" +
      "th{text-align:left;font-size:11.2px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-weight:600;border-bottom:1px solid var(--rule)}" +
      "td{border-bottom:1px solid var(--rule);vertical-align:top}.right{text-align:right}.total{font-weight:700;font-size:13.5px}" +
      ".note{color:var(--muted);font-size:12px;margin-top:4.5mm}.disclaimer{margin-top:7.5mm;font-size:12px;color:var(--muted);border-left:2px solid var(--rule);padding-left:4.5mm;break-inside:avoid;page-break-inside:avoid}" +
      ".footer{display:flex;justify-content:space-between;align-items:flex-end;color:var(--muted);font-size:11.5px;gap:10mm;margin-top:12mm}" +
      ".signature{text-align:right;color:var(--ink)}.signature .name{font-family:Georgia,'Times New Roman',serif;font-style:italic;margin-top:9mm;display:inline-block}" +
      "@media print{body{background:#fff}.page{margin:0;box-shadow:none;width:auto;min-height:auto;padding:0 0 10mm}}</style></head><body>" +
      "<div class='page'>" +
      "<div class='brand'><div class='logo'>Maison Bouchra Filali Lahlou</div><div class='meta'>Casablanca, Morocco • contact@bouchrafilalilahlou.com • www.bouchrafilalilahlou.com</div></div>" +
      "<div class='title'>Couture Order Confirmation & Payment Receipt</div>" +
      "<div class='row'>" +
      "<div class='col card'><h3>Order</h3>" +
      "<div class='kv'><div class='k'>Order Number</div><div class='v'>" + esc(data.invoiceNumber) + "</div></div>" +
      "<div class='kv'><div class='k'>Order Date</div><div class='v'>" + esc(data.invoiceDate) + "</div></div>" +
      "<div class='kv'><div class='k'>Production Timeline</div><div class='v'>" + esc(data.productionTimeline || "-") + "</div></div>" +
      "<div class='kv'><div class='k'>Payment Status</div><div class='v'>" + esc(paymentLabelEn(data.financialStatus)) + "</div></div>" +
      "<div class='kv'><div class='k'>Payment Method</div><div class='v'>" + esc(paymentMethodLabelEn(data.paymentGateway)) + "</div></div>" +
      "</div>" +
      "<div class='col card'><h3>Client</h3>" +
      "<div class='kv'><div class='k'>Client Name</div><div class='v'>" + esc(data.customerName) + "</div></div>" +
      "<div class='kv'><div class='k'>Email</div><div class='v'>" + esc(data.customerEmail || "-") + "</div></div>" +
      "<div class='kv'><div class='k'>Phone</div><div class='v'>" + esc(data.customerPhone || "-") + "</div></div>" +
      "<div class='kv'><div class='k'>Shipping Address</div><div class='v'>" + (data.shippingAddress ? esc(data.shippingAddress).replace(/\\n/g, "<br/>") : "-") + "</div></div>" +
      "</div></div>" +
      "<div class='rule'></div>" +
      "<div class='card'><h3>Design Details</h3>" +
      "<div class='kv'><div class='k'>Design Name</div><div class='v'>" + esc(firstDesignName) + "</div></div>" +
      "<div class='kv'><div class='k'>Collection</div><div class='v'>" + esc(data.designCollection || "-") + "</div></div>" +
      "<div class='kv'><div class='k'>Type</div><div class='v'>" + esc(data.designType || "-") + "</div></div>" +
      "<div class='kv'><div class='k'>Color</div><div class='v'>" + esc(data.designColor || "-") + "</div></div>" +
      "<div class='kv'><div class='k'>Fabric</div><div class='v'>" + esc(data.designFabric || "-") + "</div></div>" +
      "<div class='kv'><div class='k'>Customization</div><div class='v'>" + esc(data.designCustomization || "-") + "</div></div>" +
      "</div>" +
      "<div class='rule'></div>" +
      "<table><thead><tr><th>Description</th><th class='right'>Amount</th></tr></thead><tbody>" +
      "<tr><td>Subtotal</td><td class='right'>" + fmtMoney(data.subtotal, data.currency) + "</td></tr>" +
      "<tr><td>Shipping</td><td class='right'>" + fmtMoney(data.shippingAmount || 0, data.currency) + "</td></tr>" +
      "<tr><td>Taxes</td><td class='right'>" + fmtMoney(data.vatAmount || 0, data.currency) + "</td></tr>" +
      "<tr><td class='total'>Total</td><td class='right total'>" + fmtMoney(data.total, data.currency) + "</td></tr>" +
      (data.depositAmount > 0 ? "<tr><td>Deposit Received</td><td class='right'>" + fmtMoney(data.depositAmount, data.currency) + "</td></tr>" : "") +
      (data.outstanding > 0 ? "<tr><td class='total'>Remaining Balance</td><td class='right total'>" + fmtMoney(data.outstanding, data.currency) + "</td></tr>" : "") +
      "</tbody></table>" +
      "<div class='note'>Currency shown in " + esc(data.currency) + ". If you need this receipt in MAD or USD, we can provide an additional copy upon request.</div>" +
      "<div class='disclaimer'>Each Maison Bouchra Filali Lahlou creation is handcrafted in our Casablanca atelier by skilled artisans. Production begins once measurements are confirmed. Estimated completion time is 4 weeks. Demi-mesure and custom-made pieces are final sale.</div>" +
      "<div class='footer'><div>Handcrafted in Morocco<br/>Order Reference: <strong style='color:#111;font-weight:600'>" + esc(data.invoiceNumber) + "</strong></div><div class='signature'>Signature<br/><span class='name'>Bouchra Filali Lahlou</span></div></div>" +
      "</div></body></html>";
    }

    function buildInvoiceHtml(data) {
      if (data.modelType === "showroom_receipt") return buildShowroomReceiptHtml(data);
      if (data.modelType === "international_invoice") return buildMaisonReceiptHtml(data);
      if (data.modelType === "coin") return buildCoinHtml(data);
      return buildClassicHtml(data);
    }

    function renderPreview() {
      const data = collectData();
      previewFrame.srcdoc = buildInvoiceHtml(data);
    }

    const today = new Date();
    const todayIso = today.toISOString().slice(0, 10);
    invoiceDateEl.value = todayIso;
    dueDateEl.value = todayIso;
    invoiceNumberEl.value = formatInvoiceNumber("", todayIso);

    addLineBtn.addEventListener("click", () => addLine({ title: "", qty: 1, price: 0 }));
    withVatEl.addEventListener("change", renderTotals);
    vatRateEl.addEventListener("input", renderTotals);
    currencyEl.addEventListener("change", renderTotals);
    financialStatusEl.addEventListener("change", renderTotals);
    depositAmountEl.addEventListener("input", renderTotals);
    discountAmountEl.addEventListener("input", renderTotals);
    shippingAmountEl.addEventListener("input", renderTotals);
    invoiceDateEl.addEventListener("change", () => {
      normalizeInvoiceField();
      renderTotals();
    });
    invoiceNumberEl.addEventListener("blur", normalizeInvoiceField);
    previewBtn.addEventListener("click", renderPreview);
    printBtn.addEventListener("click", () => {
      const html = buildInvoiceHtml(collectData());
      const popup = window.open("", "_blank");
      if (!popup) return;
      popup.document.open();
      popup.document.write(html);
      popup.document.close();
      popup.focus();
      popup.print();
    });

    addLine({ title: "Article exemple", qty: 1, price: 0 });
    renderTotals();
    renderPreview();
  </script>
</body>
</html>`);
});

adminRouter.get("/insights", (req, res) => {
  const host = typeof req.query.host === "string" ? req.query.host : String(req.query.host ?? "");
  const shop = typeof req.query.shop === "string" ? req.query.shop : String(req.query.shop ?? "");
  const embedded =
    typeof req.query.embedded === "string" ? req.query.embedded : String(req.query.embedded ?? "");
  const navParams = new URLSearchParams();
  if (host) navParams.set("host", host);
  if (shop) navParams.set("shop", shop);
  if (embedded) navParams.set("embedded", embedded);
  const navSuffix = navParams.toString() ? `?${navParams.toString()}` : "";

  res.type("html").send(`<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="shopify-api-key" content="${env.SHOPIFY_API_KEY}" />
  <title>Insights</title>
  <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
  <style>
    :root { --bg:#f6f6f7; --panel:#fff; --text:#202223; --muted:#6d7175; --border:#e1e3e5; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; background: var(--bg); color: var(--text); }
    .wrap { max-width: 1180px; margin: 18px auto; padding: 0 12px 20px; }
    h1 { margin: 0 0 6px; font-size: 32px; font-weight: 700; }
    .intro { margin: 0 0 14px; color: #5c5f62; font-size: 14px; }
    .card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 16px; box-shadow: 0 1px 0 rgba(0,0,0,.04); margin-bottom: 14px; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 10px; }
    .period-wrap {
      margin-top: 10px;
      position: relative;
      display: inline-block;
      width: 100%;
      max-width: 100%;
    }
    .segmented {
      margin-top: 10px;
      display: flex;
      border: 1px solid #a7abb2;
      border-radius: 16px;
      overflow: hidden;
      background: #e6e8ec;
    }
    .seg-btn {
      padding: 8px 10px;
      border: 0;
      border-right: 1px solid #aeb2b9;
      background: transparent;
      color: #3f4348;
      font-size: 14px;
      font-weight: 700;
      line-height: 1;
      cursor: pointer;
      flex: 1 1 0;
      width: auto;
      min-height: 54px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }
    .seg-btn:last-child { border-right: 0; }
    .seg-btn.active {
      background: #9cc9e8;
      color: #2f3942;
    }
    .seg-btn.active::before {
      content: "✓";
      font-weight: 800;
    }
    .seg-btn.plus-toggle {
      flex: 0 0 110px;
      justify-content: center;
    }
    .seg-btn .caret {
      font-size: 12px;
      line-height: 1;
      opacity: 0.8;
      margin-left: 4px;
    }
    .plus-menu {
      position: absolute;
      top: calc(100% + 6px);
      right: 0;
      min-width: 240px;
      border: 1px solid #c0c5cb;
      border-radius: 12px;
      overflow: hidden;
      background: #fff;
      box-shadow: 0 12px 26px rgba(0, 0, 0, 0.14);
      z-index: 10;
    }
    .plus-item {
      border: 0;
      border-bottom: 1px solid #eceef1;
      background: #fff;
      color: #3e444b;
      font-size: 14px;
      font-weight: 700;
      padding: 11px 12px;
      text-align: left;
      width: 100%;
      cursor: pointer;
    }
    .plus-item:last-child {
      border-bottom: 0;
    }
    .plus-item.active {
      background: #e8f2fb;
      color: #2f4f6f;
    }
    .type-filters {
      margin-top: 10px;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .type-btn {
      width: auto;
      border: 1px solid #d0d4da;
      border-radius: 999px;
      background: #fff;
      color: #4b5158;
      padding: 7px 12px;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
    }
    .type-btn.active {
      background: #ecf4ff;
      border-color: #a9c2dd;
      color: #2f4f6f;
    }
    .inline-check {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      color: #4c5056;
      font-weight: 600;
      margin-top: 6px;
    }
    .inline-check input[type="checkbox"] {
      width: auto;
      margin: 0;
    }
    .actions-row {
      margin-top: 10px;
      display: flex;
      justify-content: flex-end;
    }
    .actions-row button {
      width: min(320px, 100%);
    }
    label { display: block; margin-bottom: 6px; color: var(--muted); font-size: 13px; }
    input, button { width: 100%; border: 1px solid var(--border); border-radius: 8px; padding: 10px; font-size: 14px; background:#fff; }
    button { cursor: pointer; font-weight: 700; background: linear-gradient(180deg,#3d434b 0%,#23282f 100%); color:#fff; border-color:#5e656d; }
    .status { color: var(--muted); font-size: 13px; }
    .metrics { display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:10px; margin-top: 12px; }
    .metric { border:1px solid var(--border); border-radius:10px; padding:10px; background:#fff; }
    .metric .t { color:#6d7175; font-size:11px; text-transform:uppercase; letter-spacing:.05em; font-weight:700; }
    .metric .v { margin-top:6px; font-size:24px; font-weight:700; }
    .metric .s { margin-top:4px; font-size:12px; color:#7a8086; }
    .chart-panel {
      margin-top: 12px;
      border: 1px solid #d9dde2;
      border-radius: 10px;
      background: #fff;
      padding: 10px;
    }
    .chart-legend {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 8px;
    }
    .legend-chip {
      width: auto;
      border: 1px solid #d0d4da;
      border-radius: 999px;
      background: #fff;
      color: #4b5158;
      padding: 6px 11px;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .legend-chip .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      display: inline-block;
    }
    .legend-chip.off {
      opacity: 0.45;
    }
    .insights-chart {
      height: 280px;
      border: 1px solid #eceff2;
      border-radius: 8px;
      overflow: hidden;
      position: relative;
    }
    .insights-chart svg {
      width: 100%;
      height: 100%;
      display: block;
    }
    .forecast-panel {
      margin-top: 10px;
      border: 1px solid #d9dde2;
      border-radius: 10px;
      background: #fff;
      padding: 10px;
    }
    .forecast-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
      margin-bottom: 8px;
    }
    .forecast-status {
      color: #6d7175;
      font-size: 12px;
    }
    .forecast-cards {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 8px;
    }
    .forecast-card {
      border: 1px solid #eceff2;
      border-radius: 8px;
      padding: 8px 10px;
      background: #fbfcfd;
    }
    .forecast-card .k {
      color: #6d7175;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-weight: 700;
    }
    .forecast-card .v {
      margin-top: 4px;
      font-size: 20px;
      font-weight: 700;
      color: #2c3137;
    }
    .forecast-card .s {
      margin-top: 3px;
      color: #7b8087;
      font-size: 11px;
    }
    .forecast-chart {
      height: 220px;
      border: 1px solid #eceff2;
      border-radius: 8px;
      overflow: hidden;
    }
    .forecast-chart svg {
      width: 100%;
      height: 100%;
      display: block;
    }
    .insights-tooltip {
      position: absolute;
      top: 10px;
      left: 10px;
      min-width: 210px;
      background: rgba(255, 255, 255, 0.95);
      border: 1px solid #d8dde3;
      border-radius: 10px;
      box-shadow: 0 10px 22px rgba(0, 0, 0, 0.14);
      padding: 10px;
      font-size: 13px;
      color: #2b2f34;
      pointer-events: none;
      display: none;
      z-index: 3;
    }
    .insights-tooltip .d {
      font-weight: 700;
      margin-bottom: 8px;
      color: #40464d;
    }
    .insights-tooltip .r {
      display: grid;
      grid-template-columns: auto 1fr auto;
      align-items: center;
      gap: 8px;
      margin-bottom: 5px;
    }
    .insights-tooltip .sw {
      width: 10px;
      height: 4px;
      border-radius: 8px;
      display: inline-block;
    }
    .insights-tooltip .k {
      color: #545b63;
    }
    .insights-tooltip .v {
      font-weight: 700;
      color: #2f343a;
      justify-self: end;
    }
    .msgs { display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:10px; margin-top:10px; }
    .msg { border:1px solid #e6e8eb; border-radius:10px; padding:10px; background:#fff; min-height:96px; }
    .msg.warn { border-color:#f2d7ad; background:#fff9ef; }
    .msg .t { font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:#6d7175; font-weight:700; margin-bottom:4px; }
    .msg .v { font-size:13px; line-height:1.35; }
    .hidden { display: none !important; }
    @media (max-width: 980px) {
      .grid, .metrics, .msgs { grid-template-columns: 1fr; }
      .forecast-cards { grid-template-columns: 1fr; }
      .period-wrap { max-width: 100%; }
      .segmented { width: 100%; }
      .seg-btn { font-size: 13px; }
      .seg-btn.plus-toggle { flex-basis: 110px; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Insights</h1>
    <ui-nav-menu>
      <a href="/admin${navSuffix}">Commandes</a>
      <a href="/admin/invoices${navSuffix}">Factures</a>
      <a href="/admin/insights${navSuffix}">Insights</a>
      <a href="/admin/appointments${navSuffix}">Rendez-vous</a>
      <a href="/admin/forecast${navSuffix}">Forecast</a>
      <a href="/admin/ml${navSuffix}">ML Dashboard</a>
      <a href="/admin/priority${navSuffix}">Priority</a>
      <a href="/blueprint${navSuffix}">Blueprint</a>
      <a href="/admin/spline${navSuffix}">Spline</a>
      <a href="/admin/whatsapp-intelligence${navSuffix}">WhatsApp Intelligence</a>
    </ui-nav-menu>
    <p class="intro">Analyse IA séparée pour ne pas impacter la vitesse de synchronisation des commandes.</p>

    <section class="card">
      <div id="periodWrap" class="period-wrap">
        <div class="segmented" id="periodBar">
          <button type="button" class="seg-btn" data-preset="ytd">Année en cours</button>
          <button type="button" class="seg-btn" data-preset="24h">24 heures</button>
          <button type="button" class="seg-btn" data-preset="7d">7 jours</button>
          <button type="button" class="seg-btn" data-preset="28d">28 jours</button>
          <button type="button" class="seg-btn" data-preset="3m">3 mois</button>
          <button type="button" class="seg-btn" data-preset="12m">12 mois</button>
          <button type="button" id="plusToggle" class="seg-btn plus-toggle" data-role="plus">
            <span id="plusToggleText">Plus</span><span class="caret">▼</span>
          </button>
        </div>
        <div id="plusMenu" class="plus-menu hidden">
          <button type="button" class="plus-item" data-preset="lastYear">Année dernière</button>
          <button type="button" class="plus-item" data-preset="16m">16 mois</button>
        </div>
      </div>
      <div class="type-filters" id="typeFilters">
        <button type="button" class="type-btn active" data-type="all">Tous</button>
        <button type="button" class="type-btn" data-type="risk">Risque</button>
        <button type="button" class="type-btn" data-type="growth">Croissance</button>
        <button type="button" class="type-btn" data-type="concentration">Concentration</button>
        <button type="button" class="type-btn" data-type="stability">Stabilité</button>
      </div>
      <div class="grid">
        <div>
          <label for="from">Du</label>
          <input id="from" type="date" />
        </div>
        <div>
          <label for="to">Au</label>
          <input id="to" type="date" />
        </div>
      </div>
      <div style="margin-top:8px;">
        <label class="inline-check" for="manualCompare">
          <input id="manualCompare" type="checkbox" />
          Comparaison personnalisée
        </label>
      </div>
      <div class="grid" style="margin-top:6px;">
        <div>
          <label for="compareFrom">Comparaison du</label>
          <input id="compareFrom" type="date" disabled />
        </div>
        <div>
          <label for="compareTo">Comparaison au</label>
          <input id="compareTo" type="date" disabled />
        </div>
      </div>
      <div class="actions-row">
        <button id="refreshBtn" type="button">Actualiser insights</button>
      </div>
      <div id="metrics" class="metrics"></div>
      <div id="messages" class="msgs"></div>
      <div class="chart-panel">
        <div class="chart-legend">
          <button id="legendOrders" type="button" class="legend-chip"><span class="dot" style="background:#6f42c1;"></span>Commandes</button>
          <button id="legendRevenue" type="button" class="legend-chip"><span class="dot" style="background:#2f80ed;"></span>CA</button>
          <button id="legendAov" type="button" class="legend-chip"><span class="dot" style="background:#f08a24;"></span>Panier moyen</button>
          <button id="legendRepeat" type="button" class="legend-chip"><span class="dot" style="background:#17a589;"></span>Clients récurrents</button>
        </div>
        <div id="insightsChart" class="insights-chart"></div>
      </div>
      <div class="card" style="margin-top:12px; padding:12px;">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;">
          <div class="status">La prévision a été déplacée dans une page dédiée pour une lecture plus claire.</div>
          <a href="/admin/forecast${navSuffix}" style="text-decoration:none; display:inline-flex;">
            <button type="button" style="width:auto; min-width:220px;">Ouvrir la page Forecast</button>
          </a>
        </div>
      </div>
    </section>
  </div>

  <script>
    (() => {
      const apiKey = document.querySelector('meta[name="shopify-api-key"]')?.content || "";
      const host = new URLSearchParams(window.location.search).get("host") || "";
      const appBridge = window["app-bridge"];
      if (!apiKey || !host || !appBridge?.default) return;
      try { appBridge.default({ apiKey, host, forceRedirect: true }); } catch {}
    })();

    const fromEl = document.getElementById("from");
    const toEl = document.getElementById("to");
    const manualCompareEl = document.getElementById("manualCompare");
    const compareFromEl = document.getElementById("compareFrom");
    const compareToEl = document.getElementById("compareTo");
    const refreshBtn = document.getElementById("refreshBtn");
    const metricsEl = document.getElementById("metrics");
    const messagesEl = document.getElementById("messages");
    const insightsChartEl = document.getElementById("insightsChart");
    const forecastChartEl = document.getElementById("forecastChart");
    const ordersMonthlyChartEl = document.getElementById("ordersMonthlyChart");
    const runForecastBtnEl = document.getElementById("runForecastBtn");
    const forecastStatusEl = document.getElementById("forecastStatus");
    const forecastSelectedLabelEl = document.getElementById("forecastSelectedLabel");
    const forecastSelectedEl = document.getElementById("forecastSelected");
    const forecastSelectedSubEl = document.getElementById("forecastSelectedSub");
    const forecast7El = document.getElementById("forecast7");
    const forecast30El = document.getElementById("forecast30");
    const legendOrdersEl = document.getElementById("legendOrders");
    const legendRevenueEl = document.getElementById("legendRevenue");
    const legendAovEl = document.getElementById("legendAov");
    const legendRepeatEl = document.getElementById("legendRepeat");
    const periodWrapEl = document.getElementById("periodWrap");
    const periodBarEl = document.getElementById("periodBar");
    const plusToggleEl = document.getElementById("plusToggle");
    const plusToggleTextEl = document.getElementById("plusToggleText");
    const plusMenuEl = document.getElementById("plusMenu");
    const typeFiltersEl = document.getElementById("typeFilters");
    let activeType = "all";
    let activePreset = "ytd";
    let showOrders = true;
    let showRevenue = true;
    let showAov = true;
    let showRepeat = true;

    function daysAgoString(days) {
      const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      return d.toISOString().slice(0, 10);
    }
    function todayString() { return new Date().toISOString().slice(0, 10); }
    function escapeHtml(value) {
      return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }
    function monthsAgoString(months) {
      const now = new Date();
      const d = new Date(now.getFullYear(), now.getMonth() - months, now.getDate());
      return d.toISOString().slice(0, 10);
    }
    function startOfYearString() {
      const now = new Date();
      return new Date(now.getFullYear(), 0, 1).toISOString().slice(0, 10);
    }
    function lastYearRange() {
      const now = new Date();
      const year = now.getFullYear() - 1;
      const from = new Date(year, 0, 1).toISOString().slice(0, 10);
      const to = new Date(year, 11, 31).toISOString().slice(0, 10);
      return { from, to };
    }
    function applyPreset(preset) {
      const today = todayString();
      if (preset === "24h") {
        fromEl.value = today;
        toEl.value = today;
      } else if (preset === "7d") {
        fromEl.value = daysAgoString(6);
        toEl.value = today;
      } else if (preset === "28d") {
        fromEl.value = daysAgoString(27);
        toEl.value = today;
      } else if (preset === "3m") {
        fromEl.value = monthsAgoString(3);
        toEl.value = today;
      } else if (preset === "ytd") {
        fromEl.value = startOfYearString();
        toEl.value = today;
      } else if (preset === "12m") {
        fromEl.value = monthsAgoString(12);
        toEl.value = today;
      } else if (preset === "lastYear") {
        const r = lastYearRange();
        fromEl.value = r.from;
        toEl.value = r.to;
      } else {
        fromEl.value = monthsAgoString(16);
        toEl.value = today;
      }
    }
    function closePlusMenu() {
      if (!plusMenuEl) return;
      plusMenuEl.classList.add("hidden");
    }
    function togglePlusMenu() {
      if (!plusMenuEl) return;
      plusMenuEl.classList.toggle("hidden");
    }
    function updatePeriodUi(preset) {
      activePreset = preset;
      const mainButtons = Array.from(periodBarEl.querySelectorAll(".seg-btn[data-preset]"));
      mainButtons.forEach((el) => el.classList.toggle("active", el.getAttribute("data-preset") === preset));
      const plusItems = Array.from((plusMenuEl ? plusMenuEl.querySelectorAll(".plus-item") : []));
      plusItems.forEach((el) => el.classList.toggle("active", el.getAttribute("data-preset") === preset));

      const isMainPreset = ["24h", "7d", "28d", "3m", "ytd", "12m"].includes(preset);
      if (plusToggleEl) {
        plusToggleEl.classList.toggle("active", !isMainPreset);
      }
      if (plusToggleTextEl) {
        plusToggleTextEl.textContent = isMainPreset ? "Plus" : "Plus";
      }
    }
    function syncCompareInputsUi() {
      const enabled = !!manualCompareEl.checked;
      compareFromEl.disabled = !enabled;
      compareToEl.disabled = !enabled;
    }
    function selectPreset(preset) {
      updatePeriodUi(preset);
      applyPreset(preset);
      closePlusMenu();
      loadInsights();
    }
    function formatMad(value) {
      return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "MAD", maximumFractionDigits: 0 }).format(Number(value || 0));
    }
    function formatPct(value) {
      const n = Number(value);
      if (!Number.isFinite(n)) return "n/a";
      const prefix = n > 0 ? "+" : "";
      return prefix + n.toFixed(1) + "%";
    }
    function formatPts(value) {
      const n = Number(value);
      if (!Number.isFinite(n)) return "n/a";
      const prefix = n > 0 ? "+" : "";
      return prefix + n.toFixed(1) + " pts";
    }
    async function readJsonSafe(res) {
      const raw = await res.text();
      try { return { ok: true, data: JSON.parse(raw) }; } catch { return { ok: false, raw }; }
    }
    function buildV4ApiUrl() {
      const query = new URLSearchParams();
      const shop = new URLSearchParams(window.location.search).get("shop") || "";
      if (shop) query.set("shop", shop);
      query.set("horizon", "365");
      return "/admin/api/forecast/v4/latest?" + query.toString();
    }

    function sumForecast(points, days) {
      if (!Array.isArray(points) || points.length === 0) return 0;
      const safeDays = Math.max(1, Math.floor(days));
      return points.slice(0, safeDays).reduce((sum, p) => sum + Number(p && p.value ? p.value : 0), 0);
    }

    async function loadInsights() {
      const from = fromEl.value;
      const to = toEl.value;
      if (!from || !to) return;
      const query = new URLSearchParams({ from, to });
      if (manualCompareEl.checked && compareFromEl.value && compareToEl.value) {
        query.set("compareFrom", compareFromEl.value);
        query.set("compareTo", compareToEl.value);
      }
      const res = await fetch("/admin/api/insights?" + query.toString());
      const parsed = await readJsonSafe(res);
      if (!res.ok || !parsed.ok || !parsed.data || !parsed.data.ok) {
        metricsEl.innerHTML = "";
        messagesEl.innerHTML = "";
        return;
      }

      const insights = parsed.data.insights;
      if (!manualCompareEl.checked) {
        compareFromEl.value = insights.period.previousFrom;
        compareToEl.value = insights.period.previousTo;
      }

      metricsEl.innerHTML =
        "<div class='metric'><div class='t'>CA (MAD)</div><div class='v'>" + formatMad(insights.metrics.revenueMad) + "</div><div class='s'>Δ " + formatPct(insights.deltas.revenuePct) + "</div></div>" +
        "<div class='metric'><div class='t'>Commandes</div><div class='v'>" + insights.metrics.orders + "</div><div class='s'>Δ " + formatPct(insights.deltas.ordersPct) + "</div></div>" +
        "<div class='metric'><div class='t'>Panier moyen (MAD)</div><div class='v'>" + formatMad(insights.metrics.aovMad) + "</div><div class='s'>Δ " + formatPct(insights.deltas.aovPct) + "</div></div>" +
        "<div class='metric'><div class='t'>Clients récurrents</div><div class='v'>" + Number(insights.metrics.repeatCustomerRate || 0).toFixed(1) + "%</div><div class='s'>Δ " + formatPts(insights.deltas.repeatRatePts) + "</div></div>";

      const allMessages = Array.isArray(insights.messages) ? insights.messages : [];
      const messages = activeType === "all" ? allMessages : allMessages.filter((m) => m.kind === activeType);
      if (messages.length === 0) {
        messagesEl.innerHTML = "<div class='msg'><div class='t'>Analyse</div><div class='v'>Aucun insight pour ce type sur cette période.</div></div>";
        return;
      }
      messagesEl.innerHTML = messages.map((m) =>
        "<div class='msg " + (m.level === "warning" ? "warn" : "") + "'>" +
          "<div class='t'>" + escapeHtml(m.title || "Analyse") + " · " + escapeHtml(m.kind || "info") + "</div>" +
          "<div class='v'>" + escapeHtml(m.message || "") + "</div>" +
        "</div>"
      ).join("");

      await loadInsightsSeries(from, to);
    }

    function pathFromSeries(values, xAt, yAt) {
      return values
        .map((value, index) => {
          const x = xAt(index);
          const y = yAt(value);
          return (index === 0 ? "M " : "L ") + x + " " + y;
        })
        .join(" ");
    }

    function renderInsightsChart(points) {
      if (!insightsChartEl) return;
      const width = 980;
      const height = 280;
      const margin = { top: 18, right: 16, bottom: 34, left: 56 };
      const plotWidth = width - margin.left - margin.right;
      const plotHeight = height - margin.top - margin.bottom;
      if (!Array.isArray(points) || points.length === 0) {
        insightsChartEl.innerHTML =
          "<svg viewBox='0 0 " + width + " " + height + "' preserveAspectRatio='none'>" +
            "<line x1='" + margin.left + "' y1='" + (height - margin.bottom) + "' x2='" + (width - margin.right) + "' y2='" + (height - margin.bottom) + "' stroke='#e4e7ea' stroke-width='1'/>" +
            "<text x='" + (width / 2) + "' y='" + (height / 2) + "' text-anchor='middle' fill='#9aa0a6' font-size='13'>Pas de données sur cette période</text>" +
          "</svg>";
        return;
      }

      const stepX = points.length > 1 ? plotWidth / (points.length - 1) : plotWidth;
      const xAt = (index) => margin.left + stepX * index;
      const ordersMax = Math.max(...points.map((p) => Number(p.orders || 0)), 1);
      const revenueMax = Math.max(...points.map((p) => Number(p.revenueMad || 0)), 1);
      const aovMax = Math.max(...points.map((p) => Number(p.aovMad || 0)), 1);
      const repeatMax = Math.max(...points.map((p) => Number(p.repeatRate || 0)), 1);
      const yAt = (value, maxValue) => margin.top + (1 - Math.max(0, Number(value || 0)) / Math.max(1, maxValue)) * plotHeight;

      const ordersValues = points.map((p) => Number(p.orders || 0));
      const revenueValues = points.map((p) => Number(p.revenueMad || 0));
      const aovValues = points.map((p) => Number(p.aovMad || 0));
      const repeatValues = points.map((p) => Number(p.repeatRate || 0));
      const ordersPath = pathFromSeries(ordersValues, xAt, (v) => yAt(v, ordersMax));
      const revenuePath = pathFromSeries(revenueValues, xAt, (v) => yAt(v, revenueMax));
      const aovPath = pathFromSeries(aovValues, xAt, (v) => yAt(v, aovMax));
      const repeatPath = pathFromSeries(repeatValues, xAt, (v) => yAt(v, repeatMax));

      const yTicks = [0, 1 / 3, 2 / 3, 1];
      const yTickSvg = yTicks
        .map((value) => {
          const y = margin.top + (1 - value) * plotHeight;
          return (
            "<line x1='" + margin.left + "' y1='" + y + "' x2='" + (margin.left + plotWidth) + "' y2='" + y + "' stroke='#edf0f3' stroke-width='1'/>" +
            "<text x='8' y='" + (y + 4) + "' fill='#8a8f95' font-size='10'>" + Math.round(value * 100) + "</text>"
          );
        })
        .join("");

      const xTickIndices = [0, Math.floor((points.length - 1) / 3), Math.floor(((points.length - 1) * 2) / 3), points.length - 1];
      const xTickSvg = xTickIndices
        .map((index) => {
          const x = xAt(index);
          const date = new Date(points[index].date + "T00:00:00");
          const label = date.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "2-digit" });
          return "<text x='" + x + "' y='" + (height - 10) + "' text-anchor='middle' fill='#8a8f95' font-size='10'>" + label + "</text>";
        })
        .join("");

      insightsChartEl.innerHTML =
        "<svg viewBox='0 0 " + width + " " + height + "' preserveAspectRatio='none'>" +
          yTickSvg +
          (showOrders ? "<path d='" + ordersPath + "' fill='none' stroke='#6f42c1' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'/>" : "") +
          (showRevenue ? "<path d='" + revenuePath + "' fill='none' stroke='#2f80ed' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'/>" : "") +
          (showAov ? "<path d='" + aovPath + "' fill='none' stroke='#f08a24' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'/>" : "") +
          (showRepeat ? "<path d='" + repeatPath + "' fill='none' stroke='#17a589' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'/>" : "") +
          "<line id='insightsHoverLine' x1='0' y1='" + margin.top + "' x2='0' y2='" + (height - margin.bottom) + "' stroke='#8f96a0' stroke-dasharray='3 3' stroke-width='1' visibility='hidden'/>" +
          (showOrders ? "<circle id='insightsDotOrders' cx='0' cy='0' r='4' fill='#6f42c1' stroke='#fff' stroke-width='2' visibility='hidden'/>" : "") +
          (showRevenue ? "<circle id='insightsDotRevenue' cx='0' cy='0' r='4' fill='#2f80ed' stroke='#fff' stroke-width='2' visibility='hidden'/>" : "") +
          (showAov ? "<circle id='insightsDotAov' cx='0' cy='0' r='4' fill='#f08a24' stroke='#fff' stroke-width='2' visibility='hidden'/>" : "") +
          (showRepeat ? "<circle id='insightsDotRepeat' cx='0' cy='0' r='4' fill='#17a589' stroke='#fff' stroke-width='2' visibility='hidden'/>" : "") +
          xTickSvg +
        "</svg>" +
        "<div id='insightsTooltip' class='insights-tooltip'>" +
          "<div class='d' id='ttDate'></div>" +
          "<div class='r' id='ttRowOrders'><span class='sw' style='background:#6f42c1;'></span><span class='k'>Commandes</span><span class='v' id='ttOrders'></span></div>" +
          "<div class='r' id='ttRowRevenue'><span class='sw' style='background:#2f80ed;'></span><span class='k'>CA</span><span class='v' id='ttRevenue'></span></div>" +
          "<div class='r' id='ttRowAov'><span class='sw' style='background:#f08a24;'></span><span class='k'>Panier moyen</span><span class='v' id='ttAov'></span></div>" +
          "<div class='r' id='ttRowRepeat'><span class='sw' style='background:#17a589;'></span><span class='k'>Clients récurrents</span><span class='v' id='ttRepeat'></span></div>" +
        "</div>";

      const svg = insightsChartEl.querySelector("svg");
      const hoverLine = insightsChartEl.querySelector("#insightsHoverLine");
      const dotOrders = insightsChartEl.querySelector("#insightsDotOrders");
      const dotRevenue = insightsChartEl.querySelector("#insightsDotRevenue");
      const dotAov = insightsChartEl.querySelector("#insightsDotAov");
      const dotRepeat = insightsChartEl.querySelector("#insightsDotRepeat");
      const tooltip = insightsChartEl.querySelector("#insightsTooltip");
      const ttDate = insightsChartEl.querySelector("#ttDate");
      const ttOrders = insightsChartEl.querySelector("#ttOrders");
      const ttRevenue = insightsChartEl.querySelector("#ttRevenue");
      const ttAov = insightsChartEl.querySelector("#ttAov");
      const ttRepeat = insightsChartEl.querySelector("#ttRepeat");
      const ttRowOrders = insightsChartEl.querySelector("#ttRowOrders");
      const ttRowRevenue = insightsChartEl.querySelector("#ttRowRevenue");
      const ttRowAov = insightsChartEl.querySelector("#ttRowAov");
      const ttRowRepeat = insightsChartEl.querySelector("#ttRowRepeat");

      function hideHover() {
        hoverLine && hoverLine.setAttribute("visibility", "hidden");
        dotOrders && dotOrders.setAttribute("visibility", "hidden");
        dotRevenue && dotRevenue.setAttribute("visibility", "hidden");
        dotAov && dotAov.setAttribute("visibility", "hidden");
        dotRepeat && dotRepeat.setAttribute("visibility", "hidden");
        if (tooltip) tooltip.style.display = "none";
      }

      function showAt(clientX) {
        if (!svg || !hoverLine || !tooltip) return;
        const rect = svg.getBoundingClientRect();
        if (rect.width <= 0) return;
        const localX = Math.max(margin.left, Math.min(margin.left + plotWidth, ((clientX - rect.left) / rect.width) * width));
        const index = Math.max(0, Math.min(points.length - 1, Math.round((localX - margin.left) / stepX)));
        const x = xAt(index);

        hoverLine.setAttribute("x1", String(x));
        hoverLine.setAttribute("x2", String(x));
        hoverLine.setAttribute("visibility", "visible");

        const ord = ordersValues[index];
        const rev = revenueValues[index];
        const aov = aovValues[index];
        const rep = repeatValues[index];

        if (dotOrders && showOrders) {
          dotOrders.setAttribute("cx", String(x));
          dotOrders.setAttribute("cy", String(yAt(ord, ordersMax)));
          dotOrders.setAttribute("visibility", "visible");
        }
        if (dotRevenue && showRevenue) {
          dotRevenue.setAttribute("cx", String(x));
          dotRevenue.setAttribute("cy", String(yAt(rev, revenueMax)));
          dotRevenue.setAttribute("visibility", "visible");
        }
        if (dotAov && showAov) {
          dotAov.setAttribute("cx", String(x));
          dotAov.setAttribute("cy", String(yAt(aov, aovMax)));
          dotAov.setAttribute("visibility", "visible");
        }
        if (dotRepeat && showRepeat) {
          dotRepeat.setAttribute("cx", String(x));
          dotRepeat.setAttribute("cy", String(yAt(rep, repeatMax)));
          dotRepeat.setAttribute("visibility", "visible");
        }

        const d = new Date(points[index].date + "T00:00:00");
        if (ttDate) ttDate.textContent = d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "short", year: "numeric" });
        if (ttOrders) ttOrders.textContent = String(Math.round(ord));
        if (ttRevenue) ttRevenue.textContent = formatMad(rev);
        if (ttAov) ttAov.textContent = formatMad(aov);
        if (ttRepeat) ttRepeat.textContent = (Math.max(0, rep)).toFixed(1) + "%";
        if (ttRowOrders) ttRowOrders.style.display = showOrders ? "grid" : "none";
        if (ttRowRevenue) ttRowRevenue.style.display = showRevenue ? "grid" : "none";
        if (ttRowAov) ttRowAov.style.display = showAov ? "grid" : "none";
        if (ttRowRepeat) ttRowRepeat.style.display = showRepeat ? "grid" : "none";

        tooltip.style.display = "block";
        let leftPx = (x / width) * rect.width + 8;
        if (leftPx > rect.width - 220) leftPx = rect.width - 220;
        if (leftPx < 8) leftPx = 8;
        tooltip.style.left = leftPx + "px";
        tooltip.style.top = "10px";
      }

      if (svg) {
        svg.addEventListener("mousemove", (event) => showAt(event.clientX));
        svg.addEventListener("mouseleave", hideHover);
        svg.addEventListener("touchmove", (event) => {
          if (!event.touches || event.touches.length === 0) return;
          showAt(event.touches[0].clientX);
        }, { passive: true });
        svg.addEventListener("touchend", hideHover, { passive: true });
      }
    }

    async function loadInsightsSeries(from, to) {
      const query = new URLSearchParams({ from, to });
      const res = await fetch("/admin/api/insights/series?" + query.toString());
      const parsed = await readJsonSafe(res);
      if (!res.ok || !parsed.ok || !parsed.data || !parsed.data.ok || !Array.isArray(parsed.data.series)) {
        renderInsightsChart([]);
        return;
      }
      renderInsightsChart(parsed.data.series);
    }

    function renderForecastChart(points) {
      if (!forecastChartEl) return;
      if (!Array.isArray(points) || points.length === 0) {
        forecastChartEl.innerHTML =
          "<svg viewBox='0 0 900 220' preserveAspectRatio='none'>" +
            "<line x1='48' y1='188' x2='882' y2='188' stroke='#e4e7ea' stroke-width='1'/>" +
            "<text x='450' y='114' text-anchor='middle' fill='#9aa0a6' font-size='13'>Aucune prévision affichée</text>" +
          "</svg>";
        return;
      }

      const width = 900;
      const height = 220;
      const margin = { top: 18, right: 18, bottom: 32, left: 48 };
      const plotWidth = width - margin.left - margin.right;
      const plotHeight = height - margin.top - margin.bottom;
      const stepX = points.length > 1 ? plotWidth / (points.length - 1) : plotWidth;
      const xAt = (index) => margin.left + stepX * index;
      const maxUpper = Math.max(...points.map((p) => Number(p.upper || 0)), 1);
      const yAt = (value) => margin.top + (1 - Math.max(0, Number(value || 0)) / maxUpper) * plotHeight;

      const valuePath = points
        .map((point, index) => (index === 0 ? "M " : "L ") + xAt(index) + " " + yAt(point.value))
        .join(" ");
      const upperPath = points
        .map((point, index) => (index === 0 ? "M " : "L ") + xAt(index) + " " + yAt(point.upper))
        .join(" ");
      const lowerPathReverse = [...points]
        .reverse()
        .map((point, idx) => {
          const index = points.length - 1 - idx;
          return "L " + xAt(index) + " " + yAt(point.lower);
        })
        .join(" ");
      const areaPath = upperPath + " " + lowerPathReverse + " Z";

      const xTickIndices = [0, Math.floor((points.length - 1) / 2), points.length - 1];
      const xTickSvg = xTickIndices
        .map((index) => {
          const x = xAt(index);
          const label = new Date(points[index].date + "T00:00:00").toLocaleDateString("fr-FR", {
            day: "2-digit",
            month: "2-digit"
          });
          return "<text x='" + x + "' y='" + (height - 8) + "' text-anchor='middle' fill='#8a8f95' font-size='10'>" + label + "</text>";
        })
        .join("");

      forecastChartEl.innerHTML =
        "<svg viewBox='0 0 " + width + " " + height + "' preserveAspectRatio='none'>" +
          "<path d='" + areaPath + "' fill='rgba(47,128,237,0.14)' stroke='none'/>" +
          "<path d='" + valuePath + "' fill='none' stroke='#2f80ed' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'/>" +
          xTickSvg +
        "</svg>";
    }

    async function runForecast() {
      if (!runForecastBtnEl) return;
      runForecastBtnEl.disabled = true;
      if (forecastStatusEl) forecastStatusEl.textContent = "Forecast en cours...";
      const selectedHorizon = Number(forecastHorizonEl && forecastHorizonEl.value ? forecastHorizonEl.value : 30);
      const safeHorizon = Number.isFinite(selectedHorizon) ? Math.max(7, Math.min(365, Math.floor(selectedHorizon))) : 30;
      try {
        const res = await fetch("/admin/api/forecast/revenue?horizon=" + safeHorizon + "&mode=robust");
        const parsed = await readJsonSafe(res);
        if (!res.ok || !parsed.ok || !parsed.data || !parsed.data.ok) {
          const msg = parsed.ok && parsed.data && parsed.data.error ? parsed.data.error : "Erreur forecast";
          if (forecastStatusEl) forecastStatusEl.textContent = "Forecast échoué: " + msg;
          return;
        }
        const data = parsed.data.forecast;
        const points = Array.isArray(data.points) ? data.points : [];
        const selectedTotal = sumForecast(points, Number(data.horizon || safeHorizon));
        if (forecastSelectedLabelEl) forecastSelectedLabelEl.textContent = "Prévision " + Number(data.horizon || safeHorizon) + " jours";
        if (forecastSelectedEl) forecastSelectedEl.textContent = formatMad(selectedTotal);
        if (forecastSelectedSubEl) forecastSelectedSubEl.textContent = "Total cumulé sur l'horizon sélectionné";
        if (forecast7El) forecast7El.textContent = formatMad(data.next7RevenueMad);
        if (forecast30El) forecast30El.textContent = formatMad(data.next30RevenueMad);
        if (forecastStatusEl) {
          forecastStatusEl.textContent =
            "Modèle: " + data.modelName + " · Mode " + (data.mode || "robust") + " · Horizon " + data.horizon + "j";
        }
        renderForecastChart(points);
      } catch (error) {
        if (forecastStatusEl) {
          forecastStatusEl.textContent =
            "Forecast échoué: " + (error instanceof Error ? error.message : "Erreur inconnue");
        }
      } finally {
        runForecastBtnEl.disabled = false;
      }
    }

    refreshBtn.addEventListener("click", loadInsights);
    if (runForecastBtnEl) {
      runForecastBtnEl.addEventListener("click", runForecast);
    }
    legendOrdersEl.addEventListener("click", () => {
      showOrders = !showOrders;
      legendOrdersEl.classList.toggle("off", !showOrders);
      loadInsights();
    });
    legendRevenueEl.addEventListener("click", () => {
      showRevenue = !showRevenue;
      legendRevenueEl.classList.toggle("off", !showRevenue);
      loadInsights();
    });
    legendAovEl.addEventListener("click", () => {
      showAov = !showAov;
      legendAovEl.classList.toggle("off", !showAov);
      loadInsights();
    });
    legendRepeatEl.addEventListener("click", () => {
      showRepeat = !showRepeat;
      legendRepeatEl.classList.toggle("off", !showRepeat);
      loadInsights();
    });
    manualCompareEl.addEventListener("change", () => {
      syncCompareInputsUi();
      if (!manualCompareEl.checked) {
        loadInsights();
      }
    });
    periodBarEl.addEventListener("click", (event) => {
      const plusTrigger = event.target.closest("[data-role='plus']");
      if (plusTrigger) {
        togglePlusMenu();
        return;
      }
      const btn = event.target.closest(".seg-btn[data-preset]");
      if (!btn) return;
      const preset = btn.getAttribute("data-preset") || "28d";
      selectPreset(preset);
    });
    if (plusMenuEl) {
      plusMenuEl.addEventListener("click", (event) => {
        const item = event.target.closest(".plus-item[data-preset]");
        if (!item) return;
        const preset = item.getAttribute("data-preset") || "ytd";
        selectPreset(preset);
      });
    }
    document.addEventListener("click", (event) => {
      if (!periodWrapEl) return;
      const target = event.target;
      if (target instanceof Node && periodWrapEl.contains(target)) return;
      closePlusMenu();
    });
    typeFiltersEl.addEventListener("click", (event) => {
      const btn = event.target.closest(".type-btn");
      if (!btn) return;
      activeType = btn.getAttribute("data-type") || "all";
      Array.from(typeFiltersEl.querySelectorAll(".type-btn")).forEach((el) => el.classList.remove("active"));
      btn.classList.add("active");
      loadInsights();
    });
    updatePeriodUi("ytd");
    applyPreset("ytd");
    syncCompareInputsUi();
    renderForecastChart([]);
    loadInsights();
  </script>
</body>
</html>`);
});

adminRouter.get("/forecast", (req, res) => {
  const host = typeof req.query.host === "string" ? req.query.host : "";
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  const embedded = typeof req.query.embedded === "string" ? req.query.embedded : "";
  const navParams = new URLSearchParams();
  if (host) navParams.set("host", host);
  if (shop) navParams.set("shop", shop);
  if (embedded) navParams.set("embedded", embedded);
  const navSuffix = navParams.toString() ? `?${navParams.toString()}` : "";

  res.type("html").send(`<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="shopify-api-key" content="${env.SHOPIFY_API_KEY}" />
  <title>Forecast</title>
  <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
  <style>
    :root { --bg:#f6f6f7; --panel:#fff; --text:#202223; --muted:#6d7175; --border:#e1e3e5; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; background: var(--bg); color: var(--text); }
    .wrap { max-width: 1180px; margin: 18px auto; padding: 0 12px 20px; }
    h1 { margin: 0 0 6px; font-size: 32px; font-weight: 700; }
    .intro { margin: 0 0 14px; color: #5c5f62; font-size: 14px; }
    .card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 16px; box-shadow: 0 1px 0 rgba(0,0,0,.04); margin-bottom: 14px; }
    label { display: block; margin-bottom: 6px; color: var(--muted); font-size: 13px; }
    button, select { border: 1px solid var(--border); border-radius: 8px; font-size: 14px; }
    select { height: 38px; padding: 0 10px; min-width: 160px; background: #fff; }
    button { min-height: 38px; padding: 0 14px; cursor: pointer; font-weight: 700; background: linear-gradient(180deg,#3d434b 0%,#23282f 100%); color:#fff; border-color:#5e656d; }
    .forecast-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
    .forecast-controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .forecast-status { color: #6d7175; font-size: 12px; }
    .forecast-cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-bottom: 10px; }
    .forecast-card { border: 1px solid #eceff2; border-radius: 8px; padding: 8px 10px; background: #fbfcfd; }
    .forecast-card .k { color: #6d7175; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 700; }
    .forecast-card .v { margin-top: 4px; font-size: 24px; font-weight: 700; color: #2c3137; }
    .forecast-card .s { margin-top: 4px; color: #7b8087; font-size: 11px; }
    .forecast-chart { height: 300px; border: 1px solid #eceff2; border-radius: 8px; overflow: hidden; position: relative; background:#fff; }
    .forecast-chart svg { width: 100%; height: 100%; display: block; touch-action: none; }
    .forecast-tip {
      position: absolute;
      top: 10px;
      left: 10px;
      min-width: 240px;
      background: rgba(255, 255, 255, 0.97);
      border: 1px solid #d8dde3;
      border-radius: 10px;
      box-shadow: 0 10px 22px rgba(0, 0, 0, 0.14);
      padding: 10px;
      font-size: 13px;
      color: #2b2f34;
      pointer-events: none;
      display: none;
      z-index: 3;
    }
    .forecast-tip .d { font-weight: 700; margin-bottom: 8px; color: #40464d; }
    .forecast-tip .r { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 8px; margin-bottom: 5px; }
    .forecast-tip .sw { width: 10px; height: 4px; border-radius: 8px; display: inline-block; }
    .forecast-tip .k { color: #545b63; }
    .forecast-tip .v { font-weight: 700; color: #2f343a; justify-self: end; }
    .hint { margin-top: 8px; color: #7b8087; font-size: 12px; }
    .scenario-grid {
      margin-top: 10px;
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }
    .scenario-card {
      border: 1px solid #eceff2;
      border-radius: 8px;
      padding: 8px 10px;
      background: #fff;
    }
    .scenario-card.pess { border-color: #e6d4d4; background: #fff8f8; }
    .scenario-card.real { border-color: #d5e0f2; background: #f6f9ff; }
    .scenario-card.opti { border-color: #d3e7d9; background: #f4fbf6; }
    .scenario-card .k { color: #6d7175; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; font-weight: 700; }
    .scenario-card .v { margin-top: 4px; font-size: 20px; font-weight: 700; color: #2c3137; }
    .horizon-table {
      margin-top: 10px;
      border: 1px solid #e5e8ec;
      border-radius: 8px;
      overflow: hidden;
      background: #fff;
    }
    .horizon-table table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .horizon-table th, .horizon-table td { padding: 8px 10px; border-bottom: 1px solid #eff2f5; text-align: left; }
    .horizon-table th { background: #f7f9fb; color: #6d7175; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
    .horizon-table tr:last-child td { border-bottom: 0; }
    .orders-monthly-strip {
      margin-top: 10px;
      border: 1px solid rgba(15, 23, 42, 0.08);
      border-radius: 14px;
      background: #fafafa;
      padding: 10px 12px;
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
    }
    .orders-monthly-strip .k {
      font-size: 10.5px;
      text-transform: uppercase;
      letter-spacing: .06em;
      color: #64748b;
      font-weight: 700;
    }
    .orders-monthly-strip .v {
      margin-top: 4px;
      font-size: 14px;
      font-weight: 700;
      color: #0f172a;
      font-variant-numeric: tabular-nums;
    }
    .orders-monthly-chart {
      margin-top: 12px;
      height: 290px;
      border: 0;
      border-radius: 16px;
      overflow: hidden;
      background: #fafafa;
      position: relative;
      padding: 12px;
      box-shadow: inset 0 0 0 1px rgba(15, 23, 42, 0.08);
    }
    .orders-monthly-controls {
      margin-top: 12px;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 10px 14px;
      padding: 10px 12px;
      border: 1px solid rgba(15, 23, 42, 0.08);
      border-radius: 12px;
      background: #ffffff;
    }
    .orders-monthly-controls .group {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .orders-monthly-controls .lbl {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: .06em;
      color: #64748b;
      font-weight: 700;
    }
    .orders-monthly-controls .pill {
      border: 1px solid rgba(15, 23, 42, 0.14);
      border-radius: 999px;
      padding: 6px 11px;
      background: #fff;
      color: #334155;
      font-size: 12px;
      font-weight: 700;
      line-height: 1.1;
      cursor: pointer;
      transition: all 160ms ease;
    }
    .orders-monthly-controls .pill.active {
      background: #eaf0ff;
      border-color: rgba(30, 58, 138, 0.35);
      color: #1e3a8a;
      box-shadow: 0 1px 3px rgba(30, 58, 138, 0.12);
    }
    .orders-monthly-controls .pill.toggle.active {
      background: #ecfdf5;
      border-color: rgba(6, 95, 70, 0.35);
      color: #065f46;
    }
    .orders-monthly-chart svg { width: 100%; height: 100%; display: block; touch-action: none; }
    .orders-monthly-chart .chart-line {
      opacity: 0;
      animation: chartFadeIn 600ms ease forwards;
    }
    .orders-monthly-chart .chart-line.delay-1 { animation-delay: 80ms; }
    .orders-monthly-chart .chart-line.delay-2 { animation-delay: 140ms; }
    @keyframes chartFadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    .orders-monthly-legend {
      margin-top: 12px;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }
    .orders-monthly-legend .lg {
      border: 1px solid rgba(15, 23, 42, 0.12);
      border-radius: 999px;
      padding: 6px 12px;
      font-size: 12px;
      font-weight: 600;
      color: #3e4650;
      background: #fff;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      cursor: pointer;
      user-select: none;
      transition: all 150ms ease;
    }
    .orders-monthly-legend .lg.active[data-tone="forecast"] {
      background: rgba(30, 58, 138, 0.11);
      border-color: rgba(30, 58, 138, 0.32);
      color: #1e3a8a;
    }
    .orders-monthly-legend .lg.active[data-tone="prev"] {
      background: rgba(73, 109, 109, 0.12);
      border-color: rgba(73, 109, 109, 0.28);
      color: #2e4f4f;
    }
    .orders-monthly-legend .lg.active[data-tone="current"] {
      background: rgba(6, 95, 70, 0.11);
      border-color: rgba(6, 95, 70, 0.3);
      color: #065f46;
    }
    .orders-monthly-legend .lg.off {
      opacity: 0.5;
      background: #fff;
    }
    .orders-monthly-legend .sw {
      width: 12px;
      height: 4px;
      border-radius: 8px;
      display: inline-block;
      flex: 0 0 12px;
    }
    .orders-signal-panel {
      margin-top: 8px;
      height: 84px;
      border-radius: 12px;
      background: #ffffff;
      box-shadow: inset 0 0 0 1px rgba(15, 23, 42, 0.08);
      position: relative;
      padding: 8px 12px 10px;
      display: none;
    }
    .orders-signal-panel.show {
      display: block;
    }
    .orders-signal-panel .signal-title {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: .06em;
      color: #64748b;
      font-weight: 700;
      margin-bottom: 4px;
    }
    .orders-signal-panel svg {
      width: 100%;
      height: calc(100% - 16px);
      display: block;
    }
    .monthly-forecast-table {
      margin-top: 10px;
      border: 1px solid #e5e8ec;
      border-radius: 8px;
      overflow: hidden;
      background: #fff;
    }
    .monthly-forecast-table table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .monthly-forecast-table th, .monthly-forecast-table td { padding: 8px 10px; border-bottom: 1px solid #eff2f5; text-align: left; }
    .monthly-forecast-table th { background: #f7f9fb; color: #6d7175; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
    .monthly-forecast-table tr:last-child td { border-bottom: 0; }
    .monthly-forecast-table .month-cell {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      max-width: 100%;
      white-space: nowrap;
    }
    .monthly-forecast-table .month-label {
      font-weight: 600;
      color: #2f343a;
    }
    .monthly-forecast-table .month-chip {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: .01em;
      border: 1px solid transparent;
      line-height: 1.2;
    }
    .monthly-forecast-table .month-chip-past {
      background: #e7f6ef;
      color: #166c4a;
      border-color: #c8ebdb;
    }
    .monthly-forecast-table .month-chip-current {
      background: #fff5dd;
      color: #8a5a00;
      border-color: #f0ddb0;
    }
    .monthly-forecast-table .month-chip-future {
      background: #edf2ff;
      color: #3553a1;
      border-color: #d8e3ff;
    }
    .monthly-forecast-table .month-orders {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      white-space: nowrap;
    }
    .monthly-forecast-table .month-dual {
      display: inline-flex;
      align-items: baseline;
      gap: 6px;
      white-space: nowrap;
    }
    .monthly-forecast-table .month-real {
      color: #1f6d4d;
      font-weight: 700;
    }
    .monthly-forecast-table .month-forecast {
      color: #3553a1;
      font-weight: 600;
    }
    .monthly-forecast-table .month-sep {
      color: #8a93a0;
      font-weight: 500;
    }
    .monthly-forecast-table .trend-signal {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 11px;
      font-weight: 700;
      border: 1px solid transparent;
      line-height: 1.2;
    }
    .monthly-forecast-table .trend-up {
      background: #e9f8f1;
      color: #1b7b56;
      border-color: #c9ebdd;
    }
    .monthly-forecast-table .trend-down {
      background: #fdecec;
      color: #9d2b2b;
      border-color: #f6cccc;
    }
    .monthly-forecast-table .trend-flat {
      background: #f2f4f7;
      color: #5f6874;
      border-color: #e0e5eb;
    }
    .orders-tip {
      position: absolute;
      top: 12px;
      left: 12px;
      min-width: 270px;
      background: rgba(255, 255, 255, 0.99);
      border: 1px solid rgba(15, 23, 42, 0.1);
      border-radius: 12px;
      box-shadow: 0 10px 20px rgba(15, 23, 42, 0.12);
      padding: 12px;
      font-size: 13px;
      color: #1e293b;
      pointer-events: none;
      display: none;
      z-index: 3;
    }
    .orders-tip .d {
      font-weight: 750;
      margin-bottom: 8px;
      color: #0f172a;
      font-size: 14px;
      letter-spacing: -0.01em;
    }
    .orders-tip .divider {
      height: 1px;
      background: rgba(15, 23, 42, 0.1);
      margin: 6px 0 8px;
    }
    .orders-tip .r { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 8px; margin-bottom: 6px; }
    .orders-tip .sw { width: 10px; height: 4px; border-radius: 8px; display: inline-block; }
    .orders-tip .k { color: #4b5563; }
    .orders-tip .v { font-weight: 750; color: #0f172a; justify-self: end; font-variant-numeric: tabular-nums; }
    .explain {
      margin-top: 12px;
      border: 1px solid #e3e6ea;
      border-radius: 10px;
      background: #fbfcfd;
      padding: 10px 12px;
    }
    .explain h3 {
      margin: 0 0 8px;
      font-size: 14px;
      font-weight: 700;
      color: #2d3339;
    }
    .explain-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px 12px;
    }
    .explain-item .k {
      color: #6d7175;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-weight: 700;
    }
    .explain-item .v {
      margin-top: 2px;
      color: #2f343a;
      font-size: 13px;
      line-height: 1.3;
    }
    .explain-note {
      margin-top: 8px;
      color: #69707a;
      font-size: 12px;
      line-height: 1.35;
    }
    @media (max-width: 980px) {
      .forecast-cards { grid-template-columns: 1fr; }
      .scenario-grid { grid-template-columns: 1fr; }
      .forecast-top { align-items: flex-start; }
      .orders-monthly-chart { height: 220px; }
      .orders-monthly-controls { padding: 10px; }
      .orders-monthly-controls .group { width: 100%; }
      .orders-signal-panel { height: 76px; }
      .explain-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Forecast</h1>
    <ui-nav-menu>
      <a href="/admin${navSuffix}">Commandes</a>
      <a href="/admin/invoices${navSuffix}">Factures</a>
      <a href="/admin/insights${navSuffix}">Insights</a>
      <a href="/admin/appointments${navSuffix}">Rendez-vous</a>
      <a href="/admin/forecast${navSuffix}">Forecast</a>
      <a href="/admin/ml${navSuffix}">ML Dashboard</a>
      <a href="/admin/priority${navSuffix}">Priority</a>
      <a href="/blueprint${navSuffix}">Blueprint</a>
      <a href="/admin/spline${navSuffix}">Spline</a>
      <a href="/admin/whatsapp-intelligence${navSuffix}">WhatsApp Intelligence</a>
    </ui-nav-menu>
    <p class="intro">Page dédiée aux prévisions de chiffre d'affaires (BigQuery ML) avec graphe interactif tactile.</p>

    <section class="card">
      <div class="forecast-top">
        <div class="forecast-controls">
          <button id="runForecastBtn" type="button">Actualiser forecast complet</button>
        </div>
        <span id="forecastStatus" class="forecast-status">Un clic calcule automatiquement 30/90/180/365 jours.</span>
      </div>
      <div class="forecast-cards">
        <div class="forecast-card">
          <div id="forecastSelectedLabel" class="k">Prévision 365 jours</div>
          <div id="forecastSelected" class="v">-</div>
          <div id="forecastSelectedSub" class="s">Total cumulé annuel estimé</div>
        </div>
        <div class="forecast-card">
          <div class="k">Prévision 7 jours</div>
          <div id="forecast7" class="v">-</div>
          <div class="s">Court terme</div>
        </div>
        <div class="forecast-card">
          <div class="k">Prévision 30 jours</div>
          <div id="forecast30" class="v">-</div>
          <div class="s">Mensuel</div>
        </div>
        <div class="forecast-card">
          <div id="forecastOrdersLabel" class="k">Commandes prévues (365j)</div>
          <div id="forecastOrders" class="v">-</div>
          <div id="forecastOrdersSub" class="s">Estimation via rythme commandes</div>
        </div>
      </div>
      <div class="scenario-grid">
        <div class="scenario-card pess">
          <div class="k">Scénario pessimiste</div>
          <div id="forecastPess" class="v">-</div>
        </div>
        <div class="scenario-card real">
          <div class="k">Scénario réaliste</div>
          <div id="forecastReal" class="v">-</div>
        </div>
        <div class="scenario-card opti">
          <div class="k">Scénario optimiste</div>
          <div id="forecastOpti" class="v">-</div>
        </div>
      </div>
      <div class="horizon-table">
        <table>
          <thead>
            <tr>
              <th>Horizon</th>
              <th>CA Réaliste</th>
              <th>Commandes</th>
              <th>Vs période précédente</th>
              <th>Pessimiste</th>
              <th>Optimiste</th>
            </tr>
          </thead>
          <tbody id="horizonTableBody">
            <tr><td colspan="6" class="forecast-status">Lancez le forecast pour afficher les horizons.</td></tr>
          </tbody>
        </table>
      </div>
      <div id="ordersMonthlyStrip" class="orders-monthly-strip">
        <div><div class="k">Croissance prévue vs réel</div><div id="stripGrowth" class="v">-</div></div>
        <div><div class="k">Écart cumulé</div><div id="stripGap" class="v">-</div></div>
        <div><div class="k">Projection confiance</div><div id="stripConfidence" class="v">-</div></div>
      </div>
      <div class="orders-monthly-controls">
        <div class="group">
          <span class="lbl">Horizon</span>
          <button id="horizon7" type="button" class="pill">7j</button>
          <button id="horizon30" type="button" class="pill">30j</button>
          <button id="horizon90" type="button" class="pill">90j</button>
          <button id="horizon365" type="button" class="pill active">365j</button>
        </div>
        <div class="group">
          <span class="lbl">Scénario</span>
          <button id="scenarioConservative" type="button" class="pill">Conservateur</button>
          <button id="scenarioRealistic" type="button" class="pill active">Réaliste</button>
          <button id="scenarioAggressive" type="button" class="pill">Agressif</button>
        </div>
        <div class="group">
          <span class="lbl">Affichage</span>
          <button id="toggleReal" type="button" class="pill toggle active">Réel</button>
          <button id="toggleForecast" type="button" class="pill toggle active">Prévu</button>
          <button id="toggleSignal" type="button" class="pill toggle active">Signal</button>
        </div>
      </div>
      <div id="ordersMonthlyChart" class="orders-monthly-chart"></div>
      <div id="ordersSignalPanel" class="orders-signal-panel">
        <div class="signal-title">Signal période (index 0–100)</div>
        <div id="ordersSignalChart"></div>
      </div>
      <div class="orders-monthly-legend">
        <button id="legendRevenueForecast" data-tone="forecast" class="lg" type="button"><span class="sw" style="background:#1E3A8A;"></span>CA prévu</button>
        <button id="legendRevenuePrev" data-tone="prev" class="lg" type="button"><span class="sw" style="background:rgba(73,109,109,0.72);"></span>CA réel période précédente</button>
        <button id="legendRevenueCurrentYear" data-tone="current" class="lg" type="button"><span class="sw" style="background:#065F46;"></span>CA réel année en cours</button>
      </div>
      <div class="monthly-forecast-table">
        <div class="forecast-status" style="padding: 0 0 8px 0;">Survolez le graphe pour comparer CA prévu et réel.</div>
        <table>
          <thead>
            <tr>
              <th>Mois</th>
              <th>CA (réel/prévu)</th>
              <th>Commandes (réel/prévues)</th>
            </tr>
          </thead>
          <tbody id="monthlyForecastBody">
            <tr><td colspan="3" class="forecast-status">Lancez le forecast pour afficher les mois à venir.</td></tr>
          </tbody>
        </table>
      </div>
      <div class="explain">
        <h3>Données utilisées pour ce forecast</h3>
        <div id="forecastExplain" class="explain-grid">
          <div class="explain-item"><div class="k">État</div><div class="v">Lancez le forecast pour voir les données manipulées.</div></div>
        </div>
        <div id="forecastExplainNote" class="explain-note"></div>
      </div>
    </section>
  </div>

  <script>
    (() => {
      const apiKey = document.querySelector('meta[name="shopify-api-key"]')?.content || "";
      const host = new URLSearchParams(window.location.search).get("host") || "";
      const appBridge = window["app-bridge"];
      if (!apiKey || !host || !appBridge?.default) return;
      try { appBridge.default({ apiKey, host, forceRedirect: true }); } catch {}
    })();

    const ordersMonthlyChartEl = document.getElementById("ordersMonthlyChart");
    const runForecastBtnEl = document.getElementById("runForecastBtn");
    const forecastStatusEl = document.getElementById("forecastStatus");
    const forecastSelectedLabelEl = document.getElementById("forecastSelectedLabel");
    const forecastSelectedEl = document.getElementById("forecastSelected");
    const forecastSelectedSubEl = document.getElementById("forecastSelectedSub");
    const forecast7El = document.getElementById("forecast7");
    const forecast30El = document.getElementById("forecast30");
    const forecastOrdersLabelEl = document.getElementById("forecastOrdersLabel");
    const forecastOrdersEl = document.getElementById("forecastOrders");
    const forecastOrdersSubEl = document.getElementById("forecastOrdersSub");
    const forecastPessEl = document.getElementById("forecastPess");
    const forecastRealEl = document.getElementById("forecastReal");
    const forecastOptiEl = document.getElementById("forecastOpti");
    const horizonTableBodyEl = document.getElementById("horizonTableBody");
    const monthlyForecastBodyEl = document.getElementById("monthlyForecastBody");
    const forecastExplainEl = document.getElementById("forecastExplain");
    const forecastExplainNoteEl = document.getElementById("forecastExplainNote");
    const legendRevenueForecastEl = document.getElementById("legendRevenueForecast");
    const legendRevenuePrevEl = document.getElementById("legendRevenuePrev");
    const legendRevenueCurrentYearEl = document.getElementById("legendRevenueCurrentYear");
    const ordersSignalPanelEl = document.getElementById("ordersSignalPanel");
    const ordersSignalChartEl = document.getElementById("ordersSignalChart");
    const horizon7El = document.getElementById("horizon7");
    const horizon30El = document.getElementById("horizon30");
    const horizon90El = document.getElementById("horizon90");
    const horizon365El = document.getElementById("horizon365");
    const scenarioConservativeEl = document.getElementById("scenarioConservative");
    const scenarioRealisticEl = document.getElementById("scenarioRealistic");
    const scenarioAggressiveEl = document.getElementById("scenarioAggressive");
    const toggleRealEl = document.getElementById("toggleReal");
    const toggleForecastEl = document.getElementById("toggleForecast");
    const toggleSignalEl = document.getElementById("toggleSignal");
    const stripGrowthEl = document.getElementById("stripGrowth");
    const stripGapEl = document.getElementById("stripGap");
    const stripConfidenceEl = document.getElementById("stripConfidence");
    let latestForecastData = null;
    let currentYearActualMonthlyRows = [];
    let previousPeriodMonthlyRows = [];
    let previousYearSameMonthsRows = [];
    let showRevenueForecast = true;
    let showRevenuePrev = true;
    let showRevenueCurrentYear = true;
    let showSignal = true;
    let selectedHorizonDays = 365;
    let selectedScenario = "realistic";
    const signalThresholds = { better: 10, neutral: -10 };

    function formatMad(value) {
      return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "MAD", maximumFractionDigits: 0 }).format(Number(value || 0));
    }
    function formatMadLabel(value) {
      const amount = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(Number(value || 0));
      return amount + " MAD";
    }
    async function readJsonSafe(res) {
      const raw = await res.text();
      try { return { ok: true, data: JSON.parse(raw) }; } catch { return { ok: false, raw }; }
    }
    function sumForecast(points, days) {
      if (!Array.isArray(points) || points.length === 0) return 0;
      const safeDays = Math.max(1, Math.floor(days));
      return points.slice(0, safeDays).reduce((sum, p) => sum + Number(p && p.value ? p.value : 0), 0);
    }
    function escapeHtml(value) {
      return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }
    function formatPct(value) {
      const n = Number(value || 0);
      if (!Number.isFinite(n)) return "0%";
      const sign = n > 0 ? "+" : "";
      return sign + n.toFixed(1) + "%";
    }
    function formatCompactMad(value) {
      const n = Math.max(0, Number(value || 0));
      if (!Number.isFinite(n)) return "0 MAD";
      if (n >= 1000000) return (n / 1000000).toFixed(1).replace(".0", "") + "M MAD";
      if (n >= 1000) return (n / 1000).toFixed(1).replace(".0", "") + "k MAD";
      return Math.round(n).toLocaleString("fr-FR") + " MAD";
    }
    function computeSignalLabel(deltaPct) {
      const delta = Number(deltaPct || 0);
      if (!Number.isFinite(delta)) return "Neutre";
      if (delta > signalThresholds.better) return "Meilleur";
      if (delta < signalThresholds.neutral) return "Pire";
      return "Neutre";
    }
    function normalizeSignalIndex(deltaPct) {
      const delta = Number(deltaPct || 0);
      if (!Number.isFinite(delta)) return 50;
      return Math.max(0, Math.min(100, 50 + delta));
    }
    function applyForecastData(data) {
      latestForecastData = data;
      const points = Array.isArray(data.points) ? data.points : [];
      const summary365 = Array.isArray(data.horizonSummaries)
        ? data.horizonSummaries.find((s) => Number(s.horizonDays) === 365) || data.horizonSummaries[data.horizonSummaries.length - 1]
        : null;
      const selectedTotal = summary365 ? Number(summary365.realisticMad || 0) : sumForecast(points, 365);
      if (forecastSelectedLabelEl) forecastSelectedLabelEl.textContent = "Prévision " + String(summary365 ? summary365.horizonDays : 365) + " jours";
      if (forecastSelectedEl) forecastSelectedEl.textContent = formatMad(selectedTotal);
      if (forecastSelectedSubEl) forecastSelectedSubEl.textContent = "Total cumulé annuel estimé";
      if (forecast7El) forecast7El.textContent = formatMad(data.next7RevenueMad);
      if (forecast30El) forecast30El.textContent = formatMad(data.next30RevenueMad);
      if (forecastOrdersLabelEl) forecastOrdersLabelEl.textContent = "Commandes prévues (" + String(summary365 ? summary365.horizonDays : 365) + "j)";
      if (forecastOrdersEl) forecastOrdersEl.textContent = String(Number(summary365 ? summary365.orders : data.nextHorizonOrders || 0));
      if (forecastOrdersSubEl) {
        const cmp = summary365
          ? { previousPeriodOrders: summary365.previousPeriodOrders, deltaPct: summary365.deltaPct }
          : (data.ordersComparison || {});
        forecastOrdersSubEl.textContent =
          "vs période précédente: " + String(Number(cmp.previousPeriodOrders || 0)) + " (" + formatPct(cmp.deltaPct || 0) + ")";
      }
      if (forecastPessEl) forecastPessEl.textContent = formatMad(data.scenarios && data.scenarios.pessimisticMad ? data.scenarios.pessimisticMad : 0);
      if (forecastRealEl) forecastRealEl.textContent = formatMad(data.scenarios && data.scenarios.realisticMad ? data.scenarios.realisticMad : selectedTotal);
      if (forecastOptiEl) forecastOptiEl.textContent = formatMad(data.scenarios && data.scenarios.optimisticMad ? data.scenarios.optimisticMad : selectedTotal);
      if (forecastPessEl && data.scenarios) forecastPessEl.textContent += " · " + String(Number(data.scenarios.pessimisticOrders || 0)) + " cmd";
      if (forecastRealEl && data.scenarios) forecastRealEl.textContent += " · " + String(Number(data.scenarios.realisticOrders || 0)) + " cmd";
      if (forecastOptiEl && data.scenarios) forecastOptiEl.textContent += " · " + String(Number(data.scenarios.optimisticOrders || 0)) + " cmd";
      renderHorizonTable(Array.isArray(data.horizonSummaries) ? data.horizonSummaries : []);
      renderForecastExplain(data.dataUsage, data);
      const monthlyRows = Array.isArray(data.monthlyOrdersForecast) ? data.monthlyOrdersForecast : [];
      renderOrdersMonthlyChart(monthlyRows, previousPeriodMonthlyRows);
      void loadPreviousPeriodMonthlyRowsForForecast(monthlyRows).then((rows) => {
        previousPeriodMonthlyRows = rows;
        renderOrdersMonthlyChart(monthlyRows, previousPeriodMonthlyRows);
      }).catch(() => {
        previousPeriodMonthlyRows = [];
        renderOrdersMonthlyChart(monthlyRows, previousPeriodMonthlyRows);
      });
      const currentMonthIso = new Date().toISOString().slice(0, 7);
      void loadPreviousYearSameMonthsRows(currentMonthIso).then((rows) => {
        previousYearSameMonthsRows = rows;
        renderOrdersMonthlyChart(monthlyRows, previousPeriodMonthlyRows);
      }).catch(() => {
        previousYearSameMonthsRows = [];
        renderOrdersMonthlyChart(monthlyRows, previousPeriodMonthlyRows);
      });
      renderMonthlyForecastTable(mergeMonthlyRowsWithActuals(monthlyRows, currentYearActualMonthlyRows));
    }
    function buildMockForecastData() {
      const now = new Date();
      const startMonth = String(now.getUTCFullYear()) + "-01";
      const monthlyOrdersForecast = [];
      for (let i = 0; i < 12; i += 1) {
        const month = addMonthsIsoMonth(startMonth, i);
        const seasonal = 1 + (Math.sin((i / 12) * Math.PI * 2) * 0.16);
        const revenueMad = Math.max(90000, Math.round((170000 + (i * 8500)) * seasonal));
        const orders = Math.max(1, Math.round(revenueMad / 1700));
        monthlyOrdersForecast.push({ month, revenueMad, orders });
      }
      const realisticMad = monthlyOrdersForecast.reduce((s, m) => s + Number(m.revenueMad || 0), 0);
      return {
        horizon: 365,
        mode: "robust",
        modelName: "ARIMA_PLUS (mock fallback)",
        points: [],
        next7RevenueMad: realisticMad / 52,
        next30RevenueMad: realisticMad / 12,
        nextHorizonOrders: Math.round(realisticMad / 1700),
        scenarios: {
          pessimisticMad: realisticMad * 0.9,
          realisticMad,
          optimisticMad: realisticMad * 1.1,
          pessimisticOrders: Math.round((realisticMad * 0.9) / 1700),
          realisticOrders: Math.round(realisticMad / 1700),
          optimisticOrders: Math.round((realisticMad * 1.1) / 1700)
        },
        horizonSummaries: [
          {
            horizonDays: 365,
            realisticMad,
            pessimisticMad: realisticMad * 0.9,
            optimisticMad: realisticMad * 1.1,
            orders: Math.round(realisticMad / 1700),
            previousPeriodOrders: 0,
            deltaPct: 0
          }
        ],
        monthlyOrdersForecast,
        dataUsage: {
          source: "mock",
          historyFrom: "-",
          historyTo: "-",
          historyPoints: 0,
          historyOrders: 0,
          trainingTable: "-",
          modelType: "Mock fallback",
          features: [],
          currencyNormalization: "-",
          ordersMethodology: "-",
          rareMonthAdjustment: "-",
          externalSignals: null,
          notes: ["Données mock affichées en attendant un forecast réel."]
        }
      };
    }
    function toIsoDaySafe(value) {
      const text = String(value || "").trim();
      if (!text) return "";
      const direct = text.match(/^(\d{4}-\d{2}-\d{2})/);
      if (direct && direct[1]) return direct[1];
      const parsed = new Date(text);
      if (Number.isNaN(parsed.getTime())) return "";
      return parsed.toISOString().slice(0, 10);
    }
    async function loadCurrentYearActualMonthlyRows() {
      const now = new Date();
      const currentYear = now.getUTCFullYear();
      const from = String(currentYear) + "-01-01";
      const to = now.toISOString().slice(0, 10);
      const query = new URLSearchParams({ from, to });
      const res = await fetch("/admin/api/insights/series?" + query.toString());
      const parsed = await readJsonSafe(res);
      if (!res.ok || !parsed.ok || !parsed.data || !parsed.data.ok || !Array.isArray(parsed.data.series)) {
        return [];
      }
      const currentMonthIndex = now.getUTCMonth(); // 0-based
      const buckets = new Map();
      parsed.data.series.forEach((point) => {
        const day = toIsoDaySafe(point && point.date ? point.date : "");
        if (!day) return;
        const d = new Date(day + "T00:00:00.000Z");
        if (Number.isNaN(d.getTime())) return;
        if (d.getUTCFullYear() !== currentYear) return;
        // Keep elapsed months + current month (partial real data).
        if (d.getUTCMonth() > currentMonthIndex) return;
        const month = day.slice(0, 7);
        const agg = buckets.get(month) || { month, orders: 0, revenueMad: 0, isActual: true };
        agg.orders += Number(point && point.orders ? point.orders : 0);
        agg.revenueMad += Number(point && point.revenueMad ? point.revenueMad : 0);
        buckets.set(month, agg);
      });
      return Array.from(buckets.values())
        .sort((a, b) => String(a.month || "").localeCompare(String(b.month || "")))
        .map((row) => ({
          month: String(row.month || ""),
          orders: Math.max(0, Math.round(Number(row.orders || 0))),
          revenueMad: Number(Number(row.revenueMad || 0).toFixed(2)),
          isActual: true
        }));
    }
    function mergeMonthlyRowsWithActuals(forecastRows, actualRows) {
      const merged = new Map();
      (Array.isArray(actualRows) ? actualRows : []).forEach((row) => {
        const month = String(row && row.month ? row.month : "").slice(0, 7);
        if (!month) return;
        merged.set(month, {
          month,
          actualOrders: Math.max(0, Math.round(Number(row && row.orders ? row.orders : 0))),
          actualRevenueMad: Number(row && row.revenueMad ? row.revenueMad : 0),
          forecastOrders: null,
          forecastRevenueMad: null,
          isActual: true
        });
      });
      (Array.isArray(forecastRows) ? forecastRows : []).forEach((row) => {
        const month = String(row && row.month ? row.month : "").slice(0, 7);
        if (!month) return;
        const existing = merged.get(month);
        if (existing) {
          existing.forecastOrders = Math.max(0, Math.round(Number(row && row.orders ? row.orders : 0)));
          existing.forecastRevenueMad = Number(row && row.revenueMad ? row.revenueMad : 0);
          merged.set(month, existing);
          return;
        }
        merged.set(month, {
          month,
          actualOrders: null,
          actualRevenueMad: null,
          forecastOrders: Math.max(0, Math.round(Number(row && row.orders ? row.orders : 0))),
          forecastRevenueMad: Number(row && row.revenueMad ? row.revenueMad : 0),
          isActual: false
        });
      });
      return Array.from(merged.values()).sort((a, b) => String(a.month || "").localeCompare(String(b.month || "")));
    }
    function addMonthsIsoMonth(monthIso, delta) {
      const y = Number(String(monthIso || "").slice(0, 4));
      const m = Number(String(monthIso || "").slice(5, 7));
      if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return "";
      const d = new Date(Date.UTC(y, m - 1 + delta, 1));
      return d.toISOString().slice(0, 7);
    }
    function pathFromSeries(values, xAt, yAt) {
      let path = "";
      let started = false;
      for (let i = 0; i < values.length; i += 1) {
        const value = values[i];
        if (!Number.isFinite(Number(value))) {
          started = false;
          continue;
        }
        const cmd = started ? "L " : "M ";
        path += cmd + xAt(i) + " " + yAt(Number(value)) + " ";
        started = true;
      }
      return path.trim();
    }
    function refreshOrdersMonthlyLegend() {
      if (legendRevenueForecastEl) legendRevenueForecastEl.classList.toggle("active", !!showRevenueForecast);
      if (legendRevenueForecastEl) legendRevenueForecastEl.classList.toggle("off", !showRevenueForecast);
      if (legendRevenuePrevEl) legendRevenuePrevEl.classList.toggle("active", !!showRevenuePrev);
      if (legendRevenuePrevEl) legendRevenuePrevEl.classList.toggle("off", !showRevenuePrev);
      if (legendRevenueCurrentYearEl) legendRevenueCurrentYearEl.classList.toggle("active", !!showRevenueCurrentYear);
      if (legendRevenueCurrentYearEl) legendRevenueCurrentYearEl.classList.toggle("off", !showRevenueCurrentYear);
    }
    function refreshOrdersMonthlyControls() {
      if (horizon7El) horizon7El.classList.toggle("active", selectedHorizonDays === 7);
      if (horizon30El) horizon30El.classList.toggle("active", selectedHorizonDays === 30);
      if (horizon90El) horizon90El.classList.toggle("active", selectedHorizonDays === 90);
      if (horizon365El) horizon365El.classList.toggle("active", selectedHorizonDays === 365);
      if (scenarioConservativeEl) scenarioConservativeEl.classList.toggle("active", selectedScenario === "conservative");
      if (scenarioRealisticEl) scenarioRealisticEl.classList.toggle("active", selectedScenario === "realistic");
      if (scenarioAggressiveEl) scenarioAggressiveEl.classList.toggle("active", selectedScenario === "aggressive");
      if (toggleRealEl) toggleRealEl.classList.toggle("active", !!(showRevenuePrev || showRevenueCurrentYear));
      if (toggleForecastEl) toggleForecastEl.classList.toggle("active", !!showRevenueForecast);
      if (toggleSignalEl) toggleSignalEl.classList.toggle("active", !!showSignal);
      if (ordersSignalPanelEl) ordersSignalPanelEl.classList.toggle("show", !!showSignal);
    }
    function enforceMobileVisibleLines(lastKey) {
      if (!window.matchMedia || !window.matchMedia("(max-width: 760px)").matches) return;
      const keys = ["forecast", "prev", "current"];
      const enabled = keys.filter((k) =>
        (k === "forecast" && showRevenueForecast) ||
        (k === "prev" && showRevenuePrev) ||
        (k === "current" && showRevenueCurrentYear)
      );
      if (enabled.length <= 2) return;
      const candidates = enabled.filter((k) => k !== lastKey);
      const toDisable = candidates.includes("prev") ? "prev" : candidates[candidates.length - 1];
      if (toDisable === "forecast") showRevenueForecast = false;
      if (toDisable === "prev") showRevenuePrev = false;
      if (toDisable === "current") showRevenueCurrentYear = false;
    }
    function aggregateSeriesByMonth(seriesRows, monthStartIso, count) {
      const months = [];
      for (let i = 0; i < count; i += 1) months.push(addMonthsIsoMonth(monthStartIso, i));
      const map = new Map(months.map((month) => [month, { month, orders: 0, revenueMad: 0 }]));
      (Array.isArray(seriesRows) ? seriesRows : []).forEach((row) => {
        const day = toIsoDaySafe(row && row.date ? row.date : "");
        if (!day) return;
        const month = day.slice(0, 7);
        const agg = map.get(month);
        if (!agg) return;
        agg.orders += Number(row && row.orders ? row.orders : 0);
        agg.revenueMad += Number(row && row.revenueMad ? row.revenueMad : 0);
      });
      return months.map((month) => {
        const agg = map.get(month) || { month, orders: 0, revenueMad: 0 };
        return {
          month,
          orders: Math.max(0, Math.round(Number(agg.orders || 0))),
          revenueMad: Number(Number(agg.revenueMad || 0).toFixed(2))
        };
      });
    }
    async function loadPreviousPeriodMonthlyRowsForForecast(forecastMonthlyRows) {
      const sortedForecast = (Array.isArray(forecastMonthlyRows) ? forecastMonthlyRows : [])
        .slice()
        .sort((a, b) => String(a.month || "").localeCompare(String(b.month || "")));
      if (!sortedForecast.length) return [];
      const count = sortedForecast.length;
      const firstMonth = String(sortedForecast[0].month || "").slice(0, 7);
      if (!firstMonth) return [];

      const previousStartMonth = addMonthsIsoMonth(firstMonth, -count);
      const previousEndMonth = addMonthsIsoMonth(firstMonth, -1);
      if (!previousStartMonth || !previousEndMonth) return [];

      const from = previousStartMonth + "-01";
      const endDateObj = new Date(previousEndMonth + "-01T00:00:00.000Z");
      endDateObj.setUTCMonth(endDateObj.getUTCMonth() + 1);
      endDateObj.setUTCDate(0);
      const to = endDateObj.toISOString().slice(0, 10);
      const query = new URLSearchParams({ from, to });
      const res = await fetch("/admin/api/insights/series?" + query.toString());
      const parsed = await readJsonSafe(res);
      if (!res.ok || !parsed.ok || !parsed.data || !parsed.data.ok || !Array.isArray(parsed.data.series)) {
        return [];
      }
      return aggregateSeriesByMonth(parsed.data.series, previousStartMonth, count);
    }
    async function loadPreviousYearSameMonthsRows(endCurrentMonthIso) {
      const now = new Date();
      const currentYear = now.getUTCFullYear();
      const prevYear = currentYear - 1;
      const safeEndMonth = String(endCurrentMonthIso || "").slice(0, 7);
      if (!safeEndMonth) return [];

      const endMonthPart = Number(safeEndMonth.slice(5, 7));
      if (!Number.isFinite(endMonthPart) || endMonthPart < 1 || endMonthPart > 12) return [];

      const from = String(prevYear) + "-01-01";
      const endPrevMonthIso = String(prevYear) + "-" + String(endMonthPart).padStart(2, "0");
      const endDateObj = new Date(endPrevMonthIso + "-01T00:00:00.000Z");
      endDateObj.setUTCMonth(endDateObj.getUTCMonth() + 1);
      endDateObj.setUTCDate(0);
      const to = endDateObj.toISOString().slice(0, 10);
      const query = new URLSearchParams({ from, to });
      const res = await fetch("/admin/api/insights/series?" + query.toString());
      const parsed = await readJsonSafe(res);
      if (!res.ok || !parsed.ok || !parsed.data || !parsed.data.ok || !Array.isArray(parsed.data.series)) {
        return [];
      }
      const count = endMonthPart;
      const rows = aggregateSeriesByMonth(parsed.data.series, String(prevYear) + "-01", count);
      return rows.map((row) => ({
        month: String(currentYear) + "-" + String(row.month || "").slice(5, 7),
        orders: Math.max(0, Math.round(Number(row.orders || 0))),
        revenueMad: Number(Number(row.revenueMad || 0).toFixed(2))
      }));
    }
    function renderForecastExplain(dataUsage, data) {
      if (!forecastExplainEl) return;
      if (!dataUsage) {
        forecastExplainEl.innerHTML =
          "<div class='explain-item'><div class='k'>État</div><div class='v'>Métadonnées indisponibles.</div></div>";
        if (forecastExplainNoteEl) forecastExplainNoteEl.textContent = "";
        return;
      }
      const sourceLabel = dataUsage.source === "db" ? "Base locale synchronisée Shopify" : "Fallback snapshots en mémoire";
      const signals = dataUsage.externalSignals || null;
      const scRecent = Number(signals && signals.searchConsole ? signals.searchConsole.recentAvg : 0);
      const scPrevious = Number(signals && signals.searchConsole ? signals.searchConsole.previousAvg : 0);
      const scFactor = Number(signals && signals.searchConsole ? signals.searchConsole.factor : 1);
      const trRecent = Number(signals && signals.trends ? signals.trends.recentAvg : 0);
      const trPrevious = Number(signals && signals.trends ? signals.trends.previousAvg : 0);
      const trFactor = Number(signals && signals.trends ? signals.trends.factor : 1);
      const gaRecent = Number(signals && signals.ga4 ? signals.ga4.recentAvg : 0);
      const gaPrevious = Number(signals && signals.ga4 ? signals.ga4.previousAvg : 0);
      const gaFactor = Number(signals && signals.ga4 ? signals.ga4.factor : 1);
      const appliedFactor = Number(signals ? signals.appliedFactor : 1);
      const signalsSummary = signals
        ? "SC x" + scFactor.toFixed(2) + " · Trends x" + trFactor.toFixed(2) + " · GA4 x" + gaFactor.toFixed(2) + " · appliqué x" + appliedFactor.toFixed(2)
        : "Aucun signal externe";
      const scUsageText =
        "Récente: " + scRecent.toFixed(1) + " clics/j · Précédente: " + scPrevious.toFixed(1) + " clics/j · Facteur: x" + scFactor.toFixed(2);
      const trendsUsageText =
        "Récente: " + trRecent.toFixed(1) + " · Précédente: " + trPrevious.toFixed(1) + " · Facteur: x" + trFactor.toFixed(2);
      const ga4UsageText =
        "Récente: " + gaRecent.toFixed(1) + " sessions/j · Précédente: " + gaPrevious.toFixed(1) + " · Facteur: x" + gaFactor.toFixed(2);
      const formulaText =
        "CA forecast final = CA modèle (BigQuery) × facteur signaux externes appliqué (x" + appliedFactor.toFixed(2) + ").";
      forecastExplainEl.innerHTML =
        "<div class='explain-item'><div class='k'>Source</div><div class='v'>" + escapeHtml(sourceLabel) + "</div></div>" +
        "<div class='explain-item'><div class='k'>Période historique</div><div class='v'>" + escapeHtml(dataUsage.historyFrom || "-") + " → " + escapeHtml(dataUsage.historyTo || "-") + "</div></div>" +
        "<div class='explain-item'><div class='k'>Jours agrégés</div><div class='v'>" + String(Number(dataUsage.historyPoints || 0)) + "</div></div>" +
        "<div class='explain-item'><div class='k'>Commandes utilisées</div><div class='v'>" + String(Number(dataUsage.historyOrders || 0)) + "</div></div>" +
        "<div class='explain-item'><div class='k'>Table de training</div><div class='v'>" + escapeHtml(dataUsage.trainingTable || "-") + "</div></div>" +
        "<div class='explain-item'><div class='k'>Modèle</div><div class='v'>" + escapeHtml((dataUsage.modelType || "-") + " · mode " + (data && data.mode ? data.mode : "robust")) + "</div></div>" +
        "<div class='explain-item'><div class='k'>Variables</div><div class='v'>" + escapeHtml(Array.isArray(dataUsage.features) ? dataUsage.features.join(", ") : "-") + "</div></div>" +
        "<div class='explain-item'><div class='k'>Normalisation</div><div class='v'>" + escapeHtml(dataUsage.currencyNormalization || "-") + "</div></div>" +
        "<div class='explain-item'><div class='k'>Commandes prévues</div><div class='v'>" + escapeHtml(dataUsage.ordersForecastMethod || "-") + "</div></div>" +
        "<div class='explain-item'><div class='k'>Calibration</div><div class='v'>" + escapeHtml(dataUsage.calibration || "-") + "</div></div>" +
        "<div class='explain-item'><div class='k'>Mois exceptionnels</div><div class='v'>" + escapeHtml(dataUsage.rareMonthAdjustment || "-") + "</div></div>" +
        "<div class='explain-item'><div class='k'>Signaux externes</div><div class='v'>" + escapeHtml(signalsSummary) + "</div></div>" +
        "<div class='explain-item'><div class='k'>Usage Search Console</div><div class='v'>" + escapeHtml(scUsageText) + "</div></div>" +
        "<div class='explain-item'><div class='k'>Usage Trends</div><div class='v'>" + escapeHtml(trendsUsageText) + "</div></div>" +
        "<div class='explain-item'><div class='k'>Usage GA4</div><div class='v'>" + escapeHtml(ga4UsageText) + "</div></div>" +
        "<div class='explain-item'><div class='k'>Formule appliquée</div><div class='v'>" + escapeHtml(formulaText) + "</div></div>";

      if (forecastExplainNoteEl) {
        const extraNotes = signals && Array.isArray(signals.notes) && signals.notes.length > 0
          ? " Notes: " + signals.notes.join(" | ")
          : "";
        forecastExplainNoteEl.textContent =
          "Pipeline: commandes Shopify + signaux Search Console/Trends/GA4 → agrégation journalière → BigQuery ML → projection future." + extraNotes;
      }
    }

    function renderHorizonTable(rows) {
      if (!horizonTableBodyEl) return;
      if (!Array.isArray(rows) || rows.length === 0) {
        horizonTableBodyEl.innerHTML = "<tr><td colspan='6' class='forecast-status'>Aucune donnée horizon.</td></tr>";
        return;
      }
      horizonTableBodyEl.innerHTML = rows.map((row) => {
        return "<tr>" +
          "<td>" + String(Number(row.horizonDays || 0)) + " jours</td>" +
          "<td>" + formatMad(row.realisticMad || 0) + "</td>" +
          "<td>" + String(Number(row.orders || 0)) + "</td>" +
          "<td>" + String(Number(row.previousPeriodOrders || 0)) + " (" + formatPct(row.deltaPct || 0) + ")</td>" +
          "<td>" + formatMad(row.pessimisticMad || 0) + "</td>" +
          "<td>" + formatMad(row.optimisticMad || 0) + "</td>" +
        "</tr>";
      }).join("");
    }

    function renderMonthlyForecastTable(rows) {
      if (!monthlyForecastBodyEl) return;
      if (!Array.isArray(rows) || rows.length === 0) {
        monthlyForecastBodyEl.innerHTML = "<tr><td colspan='3' class='forecast-status'>Aucune projection mensuelle.</td></tr>";
        return;
      }
      const safeRows = rows.slice().sort((a, b) => String(a.month || "").localeCompare(String(b.month || "")));
      const currentMonth = new Date().toISOString().slice(0, 7);
      monthlyForecastBodyEl.innerHTML = safeRows.map((row, index) => {
        const month = String(row.month || "");
        const label = month ? month.slice(5, 7) + "/" + month.slice(0, 4) : "-";
        const hasActual = row && row.actualRevenueMad !== null && row.actualRevenueMad !== undefined;
        const hasForecast = row && row.forecastRevenueMad !== null && row.forecastRevenueMad !== undefined;
        const isPast = !!hasActual && month < currentMonth;
        const isCurrent = !isPast && month === currentMonth;
        const statusKey = isPast ? "past" : (isCurrent ? "current" : "future");
        const statusLabel = isPast ? "Réel" : (isCurrent ? "En cours" : "Prévu");
        const actualRevenue = Number(hasActual ? row.actualRevenueMad : 0);
        const forecastRevenue = Number(hasForecast ? row.forecastRevenueMad : 0);
        const actualOrders = Number(hasActual ? row.actualOrders : 0);
        const forecastOrders = Number(hasForecast ? row.forecastOrders : 0);
        let trendClass = "flat";
        let trendText = "• n/a";
        let trendTitle = "Comparaison réel vs prévu indisponible";
        if (hasActual && hasForecast) {
          const pct = forecastRevenue > 0 ? ((actualRevenue - forecastRevenue) / forecastRevenue) * 100 : (actualRevenue > 0 ? 100 : 0);
          const signedPct = (pct > 0 ? "+" : "") + pct.toFixed(1) + "%";
          trendTitle = "Écart réel vs prévu";
          if (pct > 0.1) {
            trendClass = "up";
            trendText = "▲ " + signedPct;
          } else if (pct < -0.1) {
            trendClass = "down";
            trendText = "▼ " + signedPct;
          } else {
            trendClass = "flat";
            trendText = "• " + signedPct;
          }
        } else if (index === 0) {
          trendText = "• n/a";
          trendTitle = "Pas de base de comparaison";
        }
        return "<tr>" +
          "<td><span class='month-cell'><span class='month-label'>" + label + "</span><span class='month-chip month-chip-" + statusKey + "'>" + statusLabel + "</span></span></td>" +
          "<td><span class='month-dual'><span class='month-real'>" + (hasActual ? formatMad(actualRevenue) : "-") + "</span><span class='month-sep'>/</span><span class='month-forecast'>" + (hasForecast ? formatMad(forecastRevenue) : "-") + "</span></span></td>" +
          "<td><span class='month-orders'><span class='month-dual'><span class='month-real'>" + (hasActual ? String(actualOrders) : "-") + "</span><span class='month-sep'>/</span><span class='month-forecast'>" + (hasForecast ? String(forecastOrders) : "-") + "</span></span> <span class='trend-signal trend-" + trendClass + "' title='" + trendTitle + "'>" + trendText + "</span></span></td>" +
        "</tr>";
      }).join("");
    }

    function renderSignalMiniChart(months, signalSeries) {
      if (!ordersSignalChartEl) return;
      if (!Array.isArray(months) || !months.length || !Array.isArray(signalSeries) || !signalSeries.length) {
        ordersSignalChartEl.innerHTML = "";
        return;
      }
      const width = 980;
      const height = 56;
      const margin = { top: 6, right: 8, bottom: 14, left: 8 };
      const plotWidth = width - margin.left - margin.right;
      const plotHeight = height - margin.top - margin.bottom;
      const stepX = months.length > 1 ? plotWidth / (months.length - 1) : plotWidth;
      const xAt = (index) => margin.left + stepX * index;
      const yAt = (v) => margin.top + (1 - (Math.max(0, Math.min(100, Number(v || 0))) / 100)) * plotHeight;
      const path = pathFromSeries(signalSeries, xAt, yAt);
      const tickIndices = [0, Math.floor((months.length - 1) / 2), months.length - 1];
      const labels = Array.from(new Set(tickIndices))
        .filter((idx) => idx >= 0 && idx < months.length)
        .map((idx) => {
          const label = String(months[idx] || "").slice(5, 7);
          return "<text x='" + xAt(idx) + "' y='" + (height - 2) + "' text-anchor='middle' fill='#94a3b8' font-size='9'>" + label + "</text>";
        }).join("");
      ordersSignalChartEl.innerHTML =
        "<svg viewBox='0 0 " + width + " " + height + "' preserveAspectRatio='none'>" +
          "<line x1='" + margin.left + "' y1='" + yAt(50) + "' x2='" + (width - margin.right) + "' y2='" + yAt(50) + "' stroke='rgba(100,116,139,0.24)' stroke-dasharray='3 4'/>" +
          (path ? "<path d='" + path + "' fill='none' stroke='rgba(71,85,105,0.86)' stroke-width='1.35' stroke-linecap='round' stroke-linejoin='round'/>" : "") +
          labels +
        "</svg>";
    }

    function renderOrdersMonthlyChart(rows, previousRows) {
      if (!ordersMonthlyChartEl) return;
      if (!Array.isArray(rows) || rows.length === 0) {
        ordersMonthlyChartEl.innerHTML = "<svg viewBox='0 0 980 240' preserveAspectRatio='none'><text x='490' y='124' text-anchor='middle' fill='#9aa0a6' font-size='13'>Aucune projection mensuelle</text></svg>";
        renderSignalMiniChart([], []);
        return;
      }

      const sortedForecast = rows.slice().sort((a, b) => String(a.month || "").localeCompare(String(b.month || "")));
      const firstForecastMonth = String(sortedForecast[0].month || "");
      if (!firstForecastMonth) return;

      const now = new Date();
      const currentYearStart = String(now.getUTCFullYear()) + "-01";
      const currentMonth = now.toISOString().slice(0, 7);
      const horizonMonths = Math.max(1, Math.ceil(Number(selectedHorizonDays || 365) / 30));
      const forecastEndByHorizon = addMonthsIsoMonth(currentMonth, horizonMonths - 1) || currentMonth;
      const lastForecastMonth = String(sortedForecast[sortedForecast.length - 1].month || currentMonth);
      let endMonth = forecastEndByHorizon < lastForecastMonth ? forecastEndByHorizon : lastForecastMonth;
      if (endMonth < currentMonth) endMonth = currentMonth;
      if (endMonth < currentYearStart) endMonth = currentYearStart;

      const months = [];
      for (let m = currentYearStart; m && m <= endMonth; m = addMonthsIsoMonth(m, 1)) months.push(m);

      const scenarioKey = selectedScenario === "conservative" ? "pessimisticMad" : selectedScenario === "aggressive" ? "optimisticMad" : "realisticMad";
      const realistic = Number(latestForecastData && latestForecastData.scenarios ? latestForecastData.scenarios.realisticMad : 0);
      const scenarioTotal = Number(latestForecastData && latestForecastData.scenarios ? latestForecastData.scenarios[scenarioKey] : realistic);
      const scenarioFactor = realistic > 0 && Number.isFinite(scenarioTotal) ? Math.max(0.7, Math.min(1.4, scenarioTotal / realistic)) : 1;

      const forecastMap = new Map(sortedForecast.map((r) => [String(r.month || ""), Number(r.revenueMad || 0)]));
      const currentYearMap = new Map((Array.isArray(currentYearActualMonthlyRows) ? currentYearActualMonthlyRows : []).map((r) => [String(r.month || ""), Number(r.revenueMad || 0)]));

      const safePreviousRows = Array.isArray(previousRows) ? previousRows : [];
      const previousAligned = safePreviousRows.length === sortedForecast.length ? safePreviousRows : [];
      const previousForForecastMonth = new Map();
      if (previousAligned.length === sortedForecast.length) {
        sortedForecast.forEach((row, i) => {
          previousForForecastMonth.set(String(row.month || ""), Number(previousAligned[i] && previousAligned[i].revenueMad ? previousAligned[i].revenueMad : 0));
        });
      }
      const previousYearMap = new Map((Array.isArray(previousYearSameMonthsRows) ? previousYearSameMonthsRows : []).map((r) => [String(r.month || ""), Number(r.revenueMad || 0)]));

      const revenueForecastSeries = months.map((month) => {
        if (forecastMap.has(month)) return Math.max(0, Number(forecastMap.get(month)) * scenarioFactor);
        if (month <= currentMonth && currentYearMap.has(month)) return Number(currentYearMap.get(month));
        return NaN;
      });
      const revenuePrevSeries = months.map((month) => {
        if (previousYearMap.has(month)) return Number(previousYearMap.get(month));
        if (previousForForecastMonth.has(month)) return Number(previousForForecastMonth.get(month));
        return NaN;
      });
      const revenueCurrentYearSeries = months.map((month) => (currentYearMap.has(month) ? Number(currentYearMap.get(month)) : NaN));

      const signalSeries = months.map((month, idx) => {
        const cy = Number(revenueCurrentYearSeries[idx]);
        const prev = Number(revenuePrevSeries[idx]);
        if (!Number.isFinite(cy) || !Number.isFinite(prev) || prev <= 0) return 50;
        return normalizeSignalIndex(((cy - prev) / prev) * 100);
      });
      renderSignalMiniChart(months, signalSeries);

      const monthsPassed = months.filter((m) => m <= currentMonth);
      const sumForecastPassed = monthsPassed.reduce((s, m) => s + (Number.isFinite(Number(forecastMap.get(m))) ? Number(forecastMap.get(m)) : 0), 0);
      const sumCurrentYearPassed = monthsPassed.reduce((s, m) => s + (Number.isFinite(Number(currentYearMap.get(m))) ? Number(currentYearMap.get(m)) : 0), 0);
      const growthPct = sumCurrentYearPassed > 0 ? ((sumForecastPassed - sumCurrentYearPassed) / sumCurrentYearPassed) * 100 : 0;
      const gapMad = sumForecastPassed - sumCurrentYearPassed;
      const forecastPoints = Array.isArray(latestForecastData && latestForecastData.points) ? latestForecastData.points.slice(0, 365) : [];
      const pointAvg = forecastPoints.length ? forecastPoints.reduce((s, p) => s + Number(p.value || 0), 0) / forecastPoints.length : 0;
      const widthAvg = forecastPoints.length
        ? forecastPoints.reduce((s, p) => s + Math.max(0, Number(p.upper || 0) - Number(p.lower || 0)), 0) / forecastPoints.length
        : 0;
      const confidenceScore = pointAvg > 0 ? Math.max(45, Math.min(98, 100 - (widthAvg / pointAvg) * 42)) : 60;
      if (stripGrowthEl) stripGrowthEl.textContent = (growthPct > 0 ? "+" : "") + growthPct.toFixed(1) + "%";
      if (stripGapEl) stripGapEl.textContent = (gapMad >= 0 ? "+" : "") + formatMadLabel(gapMad);
      if (stripConfidenceEl) stripConfidenceEl.textContent = confidenceScore.toFixed(0) + "/100";

      const maxRevenue = Math.max(
        showRevenueForecast ? Math.max(...revenueForecastSeries.filter((v) => Number.isFinite(v)), 0) : 0,
        showRevenuePrev ? Math.max(...revenuePrevSeries.filter((v) => Number.isFinite(v)), 0) : 0,
        showRevenueCurrentYear ? Math.max(...revenueCurrentYearSeries.filter((v) => Number.isFinite(v)), 0) : 0,
        1
      );

      const width = 980;
      const height = 240;
      const margin = { top: 20, right: 20, bottom: 34, left: 50 };
      const plotWidth = width - margin.left - margin.right;
      const plotHeight = height - margin.top - margin.bottom;
      const stepX = months.length > 1 ? plotWidth / (months.length - 1) : plotWidth;
      const xAt = (index) => margin.left + stepX * index;
      const yRevenueAt = (value) => margin.top + (1 - Math.max(0, Number(value || 0)) / maxRevenue) * plotHeight;

      const revenueForecastPath = pathFromSeries(revenueForecastSeries, xAt, yRevenueAt);
      const revenuePrevPath = pathFromSeries(revenuePrevSeries, xAt, yRevenueAt);
      const revenueCurrentYearPath = pathFromSeries(revenueCurrentYearSeries, xAt, yRevenueAt);

      function buildCurrentYearContinuationSeries(actualSeries, forecastSeries, monthSeries, currentMonthIso) {
        if (!Array.isArray(actualSeries) || !Array.isArray(forecastSeries) || !Array.isArray(monthSeries)) return [];
        const continuation = monthSeries.map(() => NaN);
        let lastActualIndex = -1;
        for (let i = monthSeries.length - 1; i >= 0; i -= 1) {
          const month = String(monthSeries[i] || "");
          if (month && month <= currentMonthIso && Number.isFinite(actualSeries[i])) {
            lastActualIndex = i;
            break;
          }
        }
        if (lastActualIndex < 0) return continuation;
        continuation[lastActualIndex] = Number(actualSeries[lastActualIndex]);
        for (let i = lastActualIndex + 1; i < monthSeries.length; i += 1) {
          if (Number.isFinite(forecastSeries[i])) continuation[i] = Number(forecastSeries[i]);
        }
        return continuation;
      }

      function buildDirectionArrow(series, color) {
        if (!Array.isArray(series) || series.length < 2) return "";
        let lastIndex = -1;
        for (let i = series.length - 1; i >= 0; i -= 1) {
          if (Number.isFinite(series[i])) { lastIndex = i; break; }
        }
        if (lastIndex <= 0) return "";
        let prevIndex = -1;
        for (let i = lastIndex - 1; i >= 0; i -= 1) {
          if (Number.isFinite(series[i])) { prevIndex = i; break; }
        }
        if (prevIndex < 0) return "";
        const x2 = xAt(lastIndex);
        const y2 = yRevenueAt(series[lastIndex]);
        const x1 = xAt(prevIndex);
        const y1 = yRevenueAt(series[prevIndex]);
        const dx = x2 - x1;
        const dy = y2 - y1;
        const len = Math.max(1, Math.sqrt((dx * dx) + (dy * dy)));
        const ux = dx / len;
        const uy = dy / len;
        const size = 8;
        const backX = x2 - (ux * size);
        const backY = y2 - (uy * size);
        const nx = -uy;
        const ny = ux;
        const wing = 4.8;
        const p1 = x2 + "," + y2;
        const p2 = (backX + (nx * wing)) + "," + (backY + (ny * wing));
        const p3 = (backX - (nx * wing)) + "," + (backY - (ny * wing));
        return "<polygon points='" + p1 + " " + p2 + " " + p3 + "' fill='" + color + "' opacity='0.95'/>";
      }

      const currentYearDirectionArrow = buildDirectionArrow(revenueCurrentYearSeries, "#065F46");
      const revenueCurrentYearContinuationSeries = buildCurrentYearContinuationSeries(revenueCurrentYearSeries, revenueForecastSeries, months, currentMonth);
      const revenueCurrentYearContinuationPath = pathFromSeries(revenueCurrentYearContinuationSeries, xAt, yRevenueAt);

      const tickIndices = [];
      if (months.length > 0) {
        tickIndices.push(0);
        tickIndices.push(Math.floor((months.length - 1) / 3));
        tickIndices.push(Math.floor(((months.length - 1) * 2) / 3));
        tickIndices.push(months.length - 1);
      }
      const uniqueTicks = Array.from(new Set(tickIndices)).filter((i) => i >= 0 && i < months.length);
      const xLabels = uniqueTicks.map((i) => {
        const x = xAt(i);
        const m = String(months[i] || "");
        const label = m ? m.slice(5, 7) + "/" + m.slice(2, 4) : "-";
        return "<text x='" + x + "' y='" + (height - 10) + "' text-anchor='middle' fill='#8a8f95' font-size='10'>" + label + "</text>";
      }).join("");

      ordersMonthlyChartEl.innerHTML =
        "<svg viewBox='0 0 " + width + " " + height + "' preserveAspectRatio='none'>" +
          [0, 0.25, 0.5, 0.75, 1].map((r) => {
            const y = margin.top + plotHeight * r;
            return "<line x1='" + margin.left + "' y1='" + y + "' x2='" + (width - margin.right) + "' y2='" + y + "' stroke='rgba(15,23,42,0.12)' stroke-width='1'/>";
          }).join("") +
          "<text x='" + (width - margin.right + 8) + "' y='" + (margin.top - 4) + "' text-anchor='start' fill='#7b8592' font-size='10'>MAD</text>" +
          (showRevenueForecast && revenueForecastPath ? "<path class='chart-line' d='" + revenueForecastPath + "' fill='none' stroke='#1E3A8A' stroke-width='2.8' stroke-linecap='round' stroke-linejoin='round'/>" : "") +
          (showRevenuePrev && revenuePrevPath ? "<path class='chart-line delay-2' d='" + revenuePrevPath + "' fill='none' stroke='rgba(73,109,109,0.65)' stroke-width='1.5' stroke-dasharray='5 4' stroke-linecap='round' stroke-linejoin='round'/>" : "") +
          (showRevenueCurrentYear && revenueCurrentYearPath ? "<path class='chart-line delay-1' d='" + revenueCurrentYearPath + "' fill='none' stroke='#065F46' stroke-width='2.1' stroke-linecap='round' stroke-linejoin='round'/>" : "") +
          (showRevenueCurrentYear && revenueCurrentYearContinuationPath ? "<path class='chart-line delay-1' d='" + revenueCurrentYearContinuationPath + "' fill='none' stroke='rgba(255,255,255,0.95)' stroke-width='4.8' stroke-dasharray='7 6' stroke-linecap='round' stroke-linejoin='round'/>" : "") +
          (showRevenueCurrentYear && revenueCurrentYearContinuationPath ? "<path class='chart-line delay-1' d='" + revenueCurrentYearContinuationPath + "' fill='none' stroke='#16A34A' stroke-width='2.6' stroke-dasharray='7 6' stroke-linecap='round' stroke-linejoin='round'/>" : "") +
          (showRevenueCurrentYear ? currentYearDirectionArrow : "") +
          "<line id='ordersHoverLine' x1='0' y1='" + margin.top + "' x2='0' y2='" + (height - margin.bottom) + "' stroke='#8f96a0' stroke-dasharray='3 3' stroke-width='1' visibility='hidden'/>" +
          "<circle id='ordersDotRev' cx='0' cy='0' r='3.6' fill='#1E3A8A' stroke='#fff' stroke-width='2' visibility='hidden'/>" +
          "<circle id='ordersDotRevPrev' cx='0' cy='0' r='3.2' fill='rgba(73,109,109,0.8)' stroke='#fff' stroke-width='2' visibility='hidden'/>" +
          "<circle id='ordersDotRevCY' cx='0' cy='0' r='3.4' fill='#065F46' stroke='#fff' stroke-width='2' visibility='hidden'/>" +
          xLabels +
        "</svg>" +
        "<div id='ordersTip' class='orders-tip'>" +
          "<div id='ordersTipDate' class='d'></div>" +
          "<div class='divider'></div>" +
          "<div id='tipRowRevenueForecast' class='r'><span class='sw' style='background:#2f80ed;'></span><span class='k'>CA prévu</span><span class='v' id='ordersTipRevenue'></span></div>" +
          "<div id='tipRowRevenuePrev' class='r'><span class='sw' style='background:#1f9d8f;'></span><span class='k'>CA réel période précédente</span><span class='v' id='ordersTipRevenuePrev'></span></div>" +
          "<div id='tipRowRevenueCY' class='r'><span class='sw' style='background:#16a34a;'></span><span class='k'>CA réel année en cours</span><span class='v' id='ordersTipRevenueCY'></span></div>" +
          "<div id='tipRowRevenueSignal' class='r' style='margin-top:3px;'><span class='sw' style='background:#6b7280;'></span><span class='k'>Signal période</span><span class='v' id='ordersTipRevenueSignal'>-</span></div>" +
          "<div id='tipRowRevenueDelta' class='r'><span class='sw' style='background:#334155;'></span><span class='k'>Écart vs prévu</span><span class='v' id='ordersTipRevenueDelta'>-</span></div>" +
        "</div>";

      const svg = ordersMonthlyChartEl.querySelector("svg");
      const hoverLine = ordersMonthlyChartEl.querySelector("#ordersHoverLine");
      const dotRev = ordersMonthlyChartEl.querySelector("#ordersDotRev");
      const dotRevPrev = ordersMonthlyChartEl.querySelector("#ordersDotRevPrev");
      const dotRevCY = ordersMonthlyChartEl.querySelector("#ordersDotRevCY");
      const tip = ordersMonthlyChartEl.querySelector("#ordersTip");
      const tipDate = ordersMonthlyChartEl.querySelector("#ordersTipDate");
      const tipRevenue = ordersMonthlyChartEl.querySelector("#ordersTipRevenue");
      const tipRevenuePrev = ordersMonthlyChartEl.querySelector("#ordersTipRevenuePrev");
      const tipRevenueCY = ordersMonthlyChartEl.querySelector("#ordersTipRevenueCY");
      const tipRevenueSignal = ordersMonthlyChartEl.querySelector("#ordersTipRevenueSignal");
      const tipRevenueDelta = ordersMonthlyChartEl.querySelector("#ordersTipRevenueDelta");
      const tipRowRevenueForecast = ordersMonthlyChartEl.querySelector("#tipRowRevenueForecast");
      const tipRowRevenuePrev = ordersMonthlyChartEl.querySelector("#tipRowRevenuePrev");
      const tipRowRevenueCY = ordersMonthlyChartEl.querySelector("#tipRowRevenueCY");
      const tipRowRevenueSignal = ordersMonthlyChartEl.querySelector("#tipRowRevenueSignal");
      const tipRowRevenueDelta = ordersMonthlyChartEl.querySelector("#tipRowRevenueDelta");

      function hideHover() {
        if (hoverLine) hoverLine.setAttribute("visibility", "hidden");
        if (dotRev) dotRev.setAttribute("visibility", "hidden");
        if (dotRevPrev) dotRevPrev.setAttribute("visibility", "hidden");
        if (dotRevCY) dotRevCY.setAttribute("visibility", "hidden");
        if (tip) tip.style.display = "none";
      }

      function showAt(clientX) {
        if (!svg || !hoverLine || !tip) return;
        const rect = svg.getBoundingClientRect();
        if (rect.width <= 0) return;
        const localX = Math.max(margin.left, Math.min(margin.left + plotWidth, ((clientX - rect.left) / rect.width) * width));
        const index = Math.max(0, Math.min(months.length - 1, Math.round((localX - margin.left) / stepX)));
        const x = xAt(index);

        hoverLine.setAttribute("x1", String(x));
        hoverLine.setAttribute("x2", String(x));
        hoverLine.setAttribute("visibility", "visible");

        const month = String(months[index] || "");
        const fv = Number(revenueForecastSeries[index]);
        const pv = Number(revenuePrevSeries[index]);
        const cv = Number(revenueCurrentYearSeries[index]);

        if (dotRev && showRevenueForecast && Number.isFinite(fv)) {
          dotRev.setAttribute("cx", String(x));
          dotRev.setAttribute("cy", String(yRevenueAt(fv)));
          dotRev.setAttribute("visibility", "visible");
        }
        if (dotRevPrev && showRevenuePrev && Number.isFinite(pv)) {
          dotRevPrev.setAttribute("cx", String(x));
          dotRevPrev.setAttribute("cy", String(yRevenueAt(pv)));
          dotRevPrev.setAttribute("visibility", "visible");
        }
        if (dotRevCY && showRevenueCurrentYear && Number.isFinite(cv)) {
          dotRevCY.setAttribute("cx", String(x));
          dotRevCY.setAttribute("cy", String(yRevenueAt(cv)));
          dotRevCY.setAttribute("visibility", "visible");
        }

        if (tipDate) tipDate.textContent = month ? month.slice(5, 7) + "/" + month.slice(0, 4) : "-";
        if (tipRevenue) tipRevenue.textContent = Number.isFinite(fv) ? formatMadLabel(fv) : "-";
        if (tipRevenuePrev) tipRevenuePrev.textContent = Number.isFinite(pv) ? formatMadLabel(pv) : "-";
        if (tipRevenueCY) tipRevenueCY.textContent = Number.isFinite(cv) ? formatMadLabel(cv) : "-";

        const signalPct = Number.isFinite(cv) && Number.isFinite(pv) && pv > 0 ? ((cv - pv) / pv) * 100 : NaN;
        if (tipRevenueSignal) {
          if (Number.isFinite(signalPct)) {
            const signed = (signalPct > 0 ? "+" : "") + signalPct.toFixed(1) + "%";
            const signalLabel = computeSignalLabel(signalPct);
            tipRevenueSignal.textContent = signalLabel + " (" + signed + ")";
            tipRevenueSignal.style.color = signalLabel === "Meilleur" ? "#166534" : signalLabel === "Pire" ? "#b91c1c" : "#475569";
          } else {
            tipRevenueSignal.textContent = "-";
            tipRevenueSignal.style.color = "#475569";
          }
        }

        if (tipRevenueDelta) {
          if (Number.isFinite(cv) && Number.isFinite(fv) && fv > 0) {
            const deltaMad = cv - fv;
            const deltaPct = (deltaMad / fv) * 100;
            tipRevenueDelta.textContent = (deltaMad >= 0 ? "+" : "") + formatMadLabel(deltaMad) + " (" + (deltaPct > 0 ? "+" : "") + deltaPct.toFixed(1) + "%)";
          } else {
            tipRevenueDelta.textContent = "-";
          }
        }

        if (tipRowRevenueForecast) tipRowRevenueForecast.style.display = showRevenueForecast ? "grid" : "none";
        if (tipRowRevenuePrev) tipRowRevenuePrev.style.display = showRevenuePrev ? "grid" : "none";
        if (tipRowRevenueCY) tipRowRevenueCY.style.display = showRevenueCurrentYear ? "grid" : "none";
        if (tipRowRevenueSignal) tipRowRevenueSignal.style.display = showSignal ? "grid" : "none";
        if (tipRowRevenueDelta) tipRowRevenueDelta.style.display = showRevenueCurrentYear && showRevenueForecast ? "grid" : "none";

        tip.style.display = "block";
        let leftPx = (x / width) * rect.width + 8;
        if (leftPx > rect.width - 300) leftPx = rect.width - 300;
        if (leftPx < 8) leftPx = 8;
        tip.style.left = leftPx + "px";
        tip.style.top = "10px";
      }

      if (svg) {
        svg.addEventListener("mousemove", (event) => showAt(event.clientX));
        svg.addEventListener("mouseleave", hideHover);
        svg.addEventListener("touchstart", (event) => {
          if (!event.touches || event.touches.length === 0) return;
          showAt(event.touches[0].clientX);
        }, { passive: true });
        svg.addEventListener("touchmove", (event) => {
          if (!event.touches || event.touches.length === 0) return;
          showAt(event.touches[0].clientX);
        }, { passive: true });
        svg.addEventListener("touchend", hideHover, { passive: true });
      }
    }


    async function runForecast() {
      if (!runForecastBtnEl) return;
      runForecastBtnEl.disabled = true;
      if (forecastStatusEl) forecastStatusEl.textContent = "Forecast en cours...";
      try {
        const res = await fetch("/admin/api/forecast/revenue?horizon=365&mode=robust");
        const parsed = await readJsonSafe(res);
        if (!res.ok || !parsed.ok || !parsed.data || !parsed.data.ok) {
          const msg = parsed.ok && parsed.data && parsed.data.error ? parsed.data.error : "Erreur forecast";
          if (forecastStatusEl) forecastStatusEl.textContent = "Forecast échoué: " + msg;
          return;
        }
        const data = parsed.data.forecast;
        applyForecastData(data);
        if (forecastStatusEl) {
          forecastStatusEl.textContent =
            "Modèle: " + data.modelName + " · Mode " + (data.mode || "robust") + " · Horizons 30/90/180/365";
        }
      } catch (error) {
        if (forecastStatusEl) {
          forecastStatusEl.textContent =
            "Forecast échoué: " + (error instanceof Error ? error.message : "Erreur inconnue");
        }
        renderHorizonTable([]);
        renderForecastExplain(null, null);
        renderOrdersMonthlyChart([], []);
        renderMonthlyForecastTable([]);
      } finally {
        runForecastBtnEl.disabled = false;
      }
    }

    async function loadLatestForecast() {
      try {
        const res = await fetch("/admin/api/forecast/revenue/latest");
        const parsed = await readJsonSafe(res);
        if (!res.ok || !parsed.ok || !parsed.data || !parsed.data.ok || !parsed.data.forecast) {
          const mock = buildMockForecastData();
          applyForecastData(mock);
          if (forecastStatusEl) forecastStatusEl.textContent = "Mode aperçu: données mock (aucun forecast sauvegardé).";
          return;
        }
        const data = parsed.data.forecast;
        applyForecastData(data);
        if (forecastStatusEl) {
          forecastStatusEl.textContent =
            "Dernier forecast chargé (" + String(data.mode || "robust") + ", " + String(data.horizon || 365) + "j).";
        }
      } catch {
        const mock = buildMockForecastData();
        applyForecastData(mock);
        if (forecastStatusEl) forecastStatusEl.textContent = "Mode aperçu: données mock (API indisponible).";
      }
    }

    renderOrdersMonthlyChart([], []);
    renderMonthlyForecastTable([]);
    void loadCurrentYearActualMonthlyRows().then((rows) => {
      currentYearActualMonthlyRows = rows;
      if (latestForecastData) {
        const monthlyRows = Array.isArray(latestForecastData.monthlyOrdersForecast) ? latestForecastData.monthlyOrdersForecast : [];
        renderOrdersMonthlyChart(monthlyRows, previousPeriodMonthlyRows);
        renderMonthlyForecastTable(mergeMonthlyRowsWithActuals(monthlyRows, currentYearActualMonthlyRows));
      }
    }).catch(() => {
      // Keep forecast table fallback if actuals endpoint is unavailable.
    });
    if (runForecastBtnEl) runForecastBtnEl.addEventListener("click", runForecast);
    if (legendRevenueForecastEl) {
      legendRevenueForecastEl.addEventListener("click", () => {
        showRevenueForecast = !showRevenueForecast;
        enforceMobileVisibleLines("forecast");
        refreshOrdersMonthlyLegend();
        refreshOrdersMonthlyControls();
        const monthlyRows = latestForecastData && Array.isArray(latestForecastData.monthlyOrdersForecast) ? latestForecastData.monthlyOrdersForecast : [];
        renderOrdersMonthlyChart(monthlyRows, previousPeriodMonthlyRows);
      });
    }
    if (legendRevenuePrevEl) {
      legendRevenuePrevEl.addEventListener("click", () => {
        showRevenuePrev = !showRevenuePrev;
        enforceMobileVisibleLines("prev");
        refreshOrdersMonthlyLegend();
        refreshOrdersMonthlyControls();
        const monthlyRows = latestForecastData && Array.isArray(latestForecastData.monthlyOrdersForecast) ? latestForecastData.monthlyOrdersForecast : [];
        renderOrdersMonthlyChart(monthlyRows, previousPeriodMonthlyRows);
      });
    }
    if (legendRevenueCurrentYearEl) {
      legendRevenueCurrentYearEl.addEventListener("click", () => {
        showRevenueCurrentYear = !showRevenueCurrentYear;
        enforceMobileVisibleLines("current");
        refreshOrdersMonthlyLegend();
        refreshOrdersMonthlyControls();
        const monthlyRows = latestForecastData && Array.isArray(latestForecastData.monthlyOrdersForecast) ? latestForecastData.monthlyOrdersForecast : [];
        renderOrdersMonthlyChart(monthlyRows, previousPeriodMonthlyRows);
      });
    }
    if (horizon7El) {
      horizon7El.addEventListener("click", () => {
        selectedHorizonDays = 7;
        refreshOrdersMonthlyControls();
        const monthlyRows = latestForecastData && Array.isArray(latestForecastData.monthlyOrdersForecast) ? latestForecastData.monthlyOrdersForecast : [];
        renderOrdersMonthlyChart(monthlyRows, previousPeriodMonthlyRows);
      });
    }
    if (horizon30El) {
      horizon30El.addEventListener("click", () => {
        selectedHorizonDays = 30;
        refreshOrdersMonthlyControls();
        const monthlyRows = latestForecastData && Array.isArray(latestForecastData.monthlyOrdersForecast) ? latestForecastData.monthlyOrdersForecast : [];
        renderOrdersMonthlyChart(monthlyRows, previousPeriodMonthlyRows);
      });
    }
    if (horizon90El) {
      horizon90El.addEventListener("click", () => {
        selectedHorizonDays = 90;
        refreshOrdersMonthlyControls();
        const monthlyRows = latestForecastData && Array.isArray(latestForecastData.monthlyOrdersForecast) ? latestForecastData.monthlyOrdersForecast : [];
        renderOrdersMonthlyChart(monthlyRows, previousPeriodMonthlyRows);
      });
    }
    if (horizon365El) {
      horizon365El.addEventListener("click", () => {
        selectedHorizonDays = 365;
        refreshOrdersMonthlyControls();
        const monthlyRows = latestForecastData && Array.isArray(latestForecastData.monthlyOrdersForecast) ? latestForecastData.monthlyOrdersForecast : [];
        renderOrdersMonthlyChart(monthlyRows, previousPeriodMonthlyRows);
      });
    }
    if (scenarioConservativeEl) {
      scenarioConservativeEl.addEventListener("click", () => {
        selectedScenario = "conservative";
        refreshOrdersMonthlyControls();
        const monthlyRows = latestForecastData && Array.isArray(latestForecastData.monthlyOrdersForecast) ? latestForecastData.monthlyOrdersForecast : [];
        renderOrdersMonthlyChart(monthlyRows, previousPeriodMonthlyRows);
      });
    }
    if (scenarioRealisticEl) {
      scenarioRealisticEl.addEventListener("click", () => {
        selectedScenario = "realistic";
        refreshOrdersMonthlyControls();
        const monthlyRows = latestForecastData && Array.isArray(latestForecastData.monthlyOrdersForecast) ? latestForecastData.monthlyOrdersForecast : [];
        renderOrdersMonthlyChart(monthlyRows, previousPeriodMonthlyRows);
      });
    }
    if (scenarioAggressiveEl) {
      scenarioAggressiveEl.addEventListener("click", () => {
        selectedScenario = "aggressive";
        refreshOrdersMonthlyControls();
        const monthlyRows = latestForecastData && Array.isArray(latestForecastData.monthlyOrdersForecast) ? latestForecastData.monthlyOrdersForecast : [];
        renderOrdersMonthlyChart(monthlyRows, previousPeriodMonthlyRows);
      });
    }
    if (toggleRealEl) {
      toggleRealEl.addEventListener("click", () => {
        const next = !(showRevenuePrev || showRevenueCurrentYear);
        showRevenuePrev = next;
        showRevenueCurrentYear = next;
        refreshOrdersMonthlyLegend();
        refreshOrdersMonthlyControls();
        const monthlyRows = latestForecastData && Array.isArray(latestForecastData.monthlyOrdersForecast) ? latestForecastData.monthlyOrdersForecast : [];
        renderOrdersMonthlyChart(monthlyRows, previousPeriodMonthlyRows);
      });
    }
    if (toggleForecastEl) {
      toggleForecastEl.addEventListener("click", () => {
        showRevenueForecast = !showRevenueForecast;
        refreshOrdersMonthlyLegend();
        refreshOrdersMonthlyControls();
        const monthlyRows = latestForecastData && Array.isArray(latestForecastData.monthlyOrdersForecast) ? latestForecastData.monthlyOrdersForecast : [];
        renderOrdersMonthlyChart(monthlyRows, previousPeriodMonthlyRows);
      });
    }
    if (toggleSignalEl) {
      toggleSignalEl.addEventListener("click", () => {
        showSignal = !showSignal;
        refreshOrdersMonthlyControls();
        const monthlyRows = latestForecastData && Array.isArray(latestForecastData.monthlyOrdersForecast) ? latestForecastData.monthlyOrdersForecast : [];
        renderOrdersMonthlyChart(monthlyRows, previousPeriodMonthlyRows);
      });
    }
    if (window.matchMedia && window.matchMedia("(max-width: 760px)").matches) {
      showRevenuePrev = false;
    }
    refreshOrdersMonthlyLegend();
    refreshOrdersMonthlyControls();
    loadLatestForecast();
  </script>
</body>
</html>`);
});

adminRouter.get("/forecast-v2", (req, res) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query || {})) {
    if (Array.isArray(value)) {
      value.forEach((v) => {
        if (typeof v === "string") params.append(key, v);
      });
      continue;
    }
    if (typeof value === "string") params.set(key, value);
  }
  const suffix = params.toString();
  return res.redirect(302, `/admin/forecast${suffix ? `?${suffix}` : ""}`);

  /*
  const host = typeof req.query.host === "string" ? req.query.host : String(req.query.host ?? "");
  const shop = typeof req.query.shop === "string" ? req.query.shop : String(req.query.shop ?? "");
  const embedded =
    typeof req.query.embedded === "string" ? req.query.embedded : String(req.query.embedded ?? "");
  const navParams = new URLSearchParams();
  if (host) navParams.set("host", host);
  if (shop) navParams.set("shop", shop);
  if (embedded) navParams.set("embedded", embedded);
  const navSuffix = navParams.toString() ? `?${navParams.toString()}` : "";

  res.type("html").send(`<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="shopify-api-key" content="${env.SHOPIFY_API_KEY}" />
  <title>Forecast V2 · Executive Engine</title>
  <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
  <style>
    :root {
      --bg: #f5f8fc;
      --card: #ffffff;
      --text: #0f172a;
      --muted: #64748b;
      --line: rgba(15, 23, 42, 0.08);
      --shadow: 0 10px 30px rgba(15, 23, 42, 0.08);
      --radius: 16px;
      --ok: #166534;
      --warn: #a16207;
      --bad: #b91c1c;
      --accent: #1d4ed8;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: linear-gradient(180deg, #f7f9fc 0%, #eef3fa 100%);
      color: var(--text);
    }
    .wrap { max-width: 1520px; margin: 20px auto; padding: 0 16px 30px; }
    h1 { margin: 0; font-size: 34px; font-weight: 820; letter-spacing: -0.02em; }
    .intro { margin: 6px 0 14px; color: var(--muted); font-size: 14px; }
    .card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      padding: 20px;
      margin-bottom: 14px;
    }
    .exec-grid {
      display: grid;
      grid-template-columns: 1.45fr 1fr;
      gap: 14px;
      align-items: stretch;
    }
    .kicker {
      font-size: 11px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--muted);
      font-weight: 700;
    }
    .hero-value {
      margin-top: 8px;
      font-size: 52px;
      line-height: 1;
      font-weight: 850;
      letter-spacing: -0.025em;
    }
    .hero-sub {
      margin-top: 10px;
      color: #334155;
      font-size: 14px;
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      align-items: center;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 4px 10px;
      font-size: 12px;
      font-weight: 700;
      border: 1px solid transparent;
      white-space: nowrap;
    }
    .b-ok { background: #e8f7ef; border-color: #c9ebd8; color: var(--ok); }
    .b-warn { background: #fff4e0; border-color: #f3ddb0; color: var(--warn); }
    .b-bad { background: #feecec; border-color: #f7cece; color: var(--bad); }
    .scenario-strip {
      margin-top: 12px;
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
    }
    .scenario {
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 10px;
      background: #f8fbff;
    }
    .scenario .k { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; }
    .scenario .v { margin-top: 4px; font-size: 22px; font-weight: 750; letter-spacing: -0.01em; }
    .mini-band {
      margin-top: 14px;
      border: 1px solid var(--line);
      border-radius: 999px;
      height: 14px;
      overflow: hidden;
      background: #edf2fb;
      position: relative;
    }
    .mini-band-95, .mini-band-80 {
      position: absolute;
      top: 0;
      bottom: 0;
      border-radius: 999px;
    }
    .mini-band-95 { background: rgba(29, 78, 216, 0.18); }
    .mini-band-80 { background: rgba(29, 78, 216, 0.33); }
    .exec-note {
      margin-top: 12px;
      color: #1e293b;
      font-size: 13px;
      line-height: 1.4;
    }
    .insights-grid {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 10px;
    }
    .insight {
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 12px;
      background: #fff;
    }
    .insight .title { font-size: 12px; color: #334155; font-weight: 700; }
    .insight .score { margin-top: 6px; font-size: 30px; font-weight: 820; letter-spacing: -0.02em; }
    .insight .text { margin-top: 5px; font-size: 12px; color: #475569; min-height: 30px; }
    .insight .action { margin-top: 8px; font-size: 12px; color: #0f172a; font-weight: 600; }
    .lab-toolbar {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 10px;
      align-items: center;
    }
    .refresh-cost {
      margin: 8px 0 12px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: #f8fbff;
      padding: 10px 12px;
    }
    .refresh-cost-title {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: .08em;
      color: var(--muted);
      font-weight: 700;
      margin-bottom: 6px;
    }
    .refresh-cost table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .refresh-cost th, .refresh-cost td { padding: 6px 4px; border-bottom: 1px solid #e7edf7; text-align: left; }
    .refresh-cost th { color: #64748b; font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; }
    .refresh-cost tr:last-child td { border-bottom: 0; }
    .toggle, .btn {
      border: 1px solid var(--line);
      background: #fff;
      color: #1e293b;
      border-radius: 999px;
      padding: 6px 10px;
      font-size: 12px;
      cursor: pointer;
      font-weight: 600;
    }
    .toggle.active { background: #1d4ed8; color: #fff; border-color: #1d4ed8; }
    .btn { border-radius: 10px; }
    .chart {
      border: 1px solid var(--line);
      border-radius: 12px;
      background: #fff;
      height: 330px;
      position: relative;
      overflow: hidden;
    }
    .chart svg { width: 100%; height: 100%; display: block; }
    .tip {
      position: absolute;
      top: 10px;
      left: 10px;
      min-width: 220px;
      background: rgba(255,255,255,0.97);
      border: 1px solid #d7deea;
      border-radius: 10px;
      box-shadow: 0 10px 22px rgba(0,0,0,0.12);
      padding: 10px;
      font-size: 12px;
      display: none;
      pointer-events: none;
    }
    .monthly {
      margin-top: 10px;
      border: 1px solid var(--line);
      border-radius: 12px;
      overflow: hidden;
    }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 9px 10px; border-bottom: 1px solid #edf1f7; text-align: left; }
    th { background: #f7f9fc; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
    tr:last-child td { border-bottom: 0; }
    .delta-up { color: var(--ok); font-weight: 700; }
    .delta-down { color: var(--bad); font-weight: 700; }
    .delta-flat { color: #475569; font-weight: 700; }
    .anomaly { color: var(--bad); font-weight: 700; }
    .method-summary {
      display: grid;
      grid-template-columns: repeat(4, minmax(0,1fr));
      gap: 8px;
      margin-bottom: 10px;
    }
    .method-pill {
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 8px;
      background: #f8fbff;
      font-size: 12px;
    }
    details summary {
      cursor: pointer;
      font-weight: 700;
      color: #1e293b;
      font-size: 13px;
    }
    .tech {
      margin-top: 8px;
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 12px;
      background: #fbfdff;
      font-size: 12px;
      color: #334155;
      line-height: 1.45;
    }
    @media (max-width: 1100px) {
      .exec-grid { grid-template-columns: 1fr; }
      .insights-grid { grid-template-columns: 1fr 1fr; }
      .method-summary { grid-template-columns: 1fr 1fr; }
    }
    @media (max-width: 760px) {
      .insights-grid { grid-template-columns: 1fr; }
      .scenario-strip { grid-template-columns: 1fr; }
      .method-summary { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Forecast V2</h1>
    <ui-nav-menu>
      <a href="/admin${navSuffix}">Commandes</a>
      <a href="/admin/invoices${navSuffix}">Factures</a>
      <a href="/admin/insights${navSuffix}">Insights</a>
      <a href="/admin/appointments${navSuffix}">Rendez-vous</a>
      <a href="/admin/forecast${navSuffix}">Forecast</a>
      <a href="/admin/forecast-v2${navSuffix}">Forecast V2</a>
      <a href="/admin/ml${navSuffix}">ML Dashboard</a>
      <a href="/admin/priority${navSuffix}">Priority</a>
      <a href="/blueprint${navSuffix}">Blueprint</a>
      <a href="/admin/spline${navSuffix}">Spline</a>
      <a href="/admin/whatsapp-intelligence${navSuffix}">WhatsApp Intelligence</a>
    </ui-nav-menu>
    <p class="intro">Moteur de décision exécutif pour pilotage CA, charge atelier et risque d'encaissement.</p>

    <section class="card exec-grid">
      <div>
        <div class="kicker">Executive Summary</div>
        <div id="execRevenue365" class="hero-value">-</div>
        <div class="hero-sub">
          <span id="execGrowth" class="badge b-ok">-</span>
          <span id="execConfidence" class="badge b-warn">Confiance -</span>
          <span id="execRisk" class="badge b-ok">Risque stable</span>
        </div>
        <div class="mini-band">
          <div id="band95" class="mini-band-95" style="left:0%; width:0%;"></div>
          <div id="band80" class="mini-band-80" style="left:0%; width:0%;"></div>
        </div>
        <div id="execInterpretation" class="exec-note">Chargement des signaux stratégiques...</div>
      </div>
      <div>
        <div class="kicker">Scénarios 365 jours</div>
        <div class="scenario-strip">
          <div class="scenario"><div class="k">Pessimiste</div><div id="scPess" class="v">-</div></div>
          <div class="scenario"><div class="k">Réaliste</div><div id="scReal" class="v">-</div></div>
          <div class="scenario"><div class="k">Optimiste</div><div id="scOpt" class="v">-</div></div>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="kicker" style="margin-bottom:10px;">Strategic Insights</div>
      <div id="insightsGrid" class="insights-grid"></div>
    </section>

    <section class="card">
      <div class="kicker" style="margin-bottom:10px;">Forecast Lab</div>
      <div class="lab-toolbar">
        <button id="runForecastV2Btn" class="btn" type="button">Actualiser forecast (payant)</button>
        <span id="v2Status" class="kicker" style="margin-left:4px;">Chargement du dernier forecast sauvegardé...</span>
        <button id="metricRevenueBtn" class="toggle active" type="button">CA</button>
        <button id="metricOrdersBtn" class="toggle" type="button">Orders</button>
        <button id="scenarioRealBtn" class="toggle active" type="button">Réaliste</button>
        <button id="scenarioPessBtn" class="toggle" type="button">Pessimiste</button>
        <button id="scenarioOptBtn" class="toggle" type="button">Optimiste</button>
        <button id="ci80Btn" class="toggle active" type="button">CI 80%</button>
        <button id="ci95Btn" class="toggle active" type="button">CI 95%</button>
        <button id="simTrafficBtn" class="btn" type="button">Traffic +20%</button>
        <button id="simConversionBtn" class="btn" type="button">Conversion +5%</button>
        <button id="simShowroomBtn" class="btn" type="button">New Showroom</button>
        <button id="exportCsvBtn" class="btn" type="button">Export CSV</button>
        <button id="exportPdfBtn" class="btn" type="button">Export PDF</button>
      </div>
      <div class="refresh-cost">
        <div class="refresh-cost-title">Estimation prix des actualisations</div>
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Horizon</th>
              <th>Points</th>
              <th>Est. coût</th>
            </tr>
          </thead>
          <tbody id="refreshCostBody">
            <tr><td colspan="4" class="kicker">Aucune actualisation enregistrée.</td></tr>
          </tbody>
        </table>
      </div>
      <div id="labChart" class="chart"></div>
      <div class="monthly">
        <table>
          <thead>
            <tr>
              <th>Mois</th>
              <th>Réel</th>
              <th>Forecast</th>
              <th>Delta %</th>
              <th>Confidence %</th>
              <th>Anomalie</th>
            </tr>
          </thead>
          <tbody id="labMonthlyBody">
            <tr><td colspan="6" class="kicker">Chargement...</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="card">
      <div class="kicker" style="margin-bottom:10px;">Methodology</div>
      <div class="method-summary">
        <div id="mPeriod" class="method-pill">Période: -</div>
        <div id="mOrders" class="method-pill">Commandes analysées: -</div>
        <div id="mModel" class="method-pill">Modèle: -</div>
        <div id="mExt" class="method-pill">Ajustements externes: -</div>
      </div>
      <details>
        <summary>View Technical Details</summary>
        <div id="methodTech" class="tech"></div>
      </details>
    </section>
  </div>

  <script>
    (() => {
      const apiKey = document.querySelector('meta[name="shopify-api-key"]')?.content || "";
      const host = new URLSearchParams(window.location.search).get("host") || "";
      const appBridge = window["app-bridge"];
      if (!apiKey || !host || !appBridge?.default) return;
      try { appBridge.default({ apiKey, host, forceRedirect: true }); } catch {}
    })();

    const state = {
      metric: "revenue",
      scenario: "real",
      showCi80: true,
      showCi95: true,
      simTraffic: false,
      simConversion: false,
      simShowroom: false,
      forecast: null,
      insightsSeries: []
    };

    const els = {
      execRevenue365: document.getElementById("execRevenue365"),
      execGrowth: document.getElementById("execGrowth"),
      execConfidence: document.getElementById("execConfidence"),
      execRisk: document.getElementById("execRisk"),
      execInterpretation: document.getElementById("execInterpretation"),
      band80: document.getElementById("band80"),
      band95: document.getElementById("band95"),
      scPess: document.getElementById("scPess"),
      scReal: document.getElementById("scReal"),
      scOpt: document.getElementById("scOpt"),
      insightsGrid: document.getElementById("insightsGrid"),
      labChart: document.getElementById("labChart"),
      labMonthlyBody: document.getElementById("labMonthlyBody"),
      mPeriod: document.getElementById("mPeriod"),
      mOrders: document.getElementById("mOrders"),
      mModel: document.getElementById("mModel"),
      mExt: document.getElementById("mExt"),
      methodTech: document.getElementById("methodTech"),
      metricRevenueBtn: document.getElementById("metricRevenueBtn"),
      metricOrdersBtn: document.getElementById("metricOrdersBtn"),
      scenarioRealBtn: document.getElementById("scenarioRealBtn"),
      scenarioPessBtn: document.getElementById("scenarioPessBtn"),
      scenarioOptBtn: document.getElementById("scenarioOptBtn"),
      ci80Btn: document.getElementById("ci80Btn"),
      ci95Btn: document.getElementById("ci95Btn"),
      simTrafficBtn: document.getElementById("simTrafficBtn"),
      simConversionBtn: document.getElementById("simConversionBtn"),
      simShowroomBtn: document.getElementById("simShowroomBtn"),
      exportCsvBtn: document.getElementById("exportCsvBtn"),
      exportPdfBtn: document.getElementById("exportPdfBtn")
      ,runForecastV2Btn: document.getElementById("runForecastV2Btn")
      ,v2Status: document.getElementById("v2Status")
      ,refreshCostBody: document.getElementById("refreshCostBody")
    };
    const REFRESH_COST_KEY = "forecast_v2_refresh_cost_history_v1";

    function formatMad(v) {
      return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "MAD", maximumFractionDigits: 0 }).format(Number(v || 0));
    }
    function fmtPct(v) {
      const n = Number(v || 0);
      if (!Number.isFinite(n)) return "0.0%";
      return (n > 0 ? "+" : "") + n.toFixed(1) + "%";
    }
    async function readJsonSafe(res) {
      const raw = await res.text();
      try { return { ok: true, data: JSON.parse(raw) }; } catch { return { ok: false, raw }; }
    }
    function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
    function avg(arr) {
      if (!Array.isArray(arr) || arr.length === 0) return 0;
      return arr.reduce((s, x) => s + Number(x || 0), 0) / arr.length;
    }
    function stddev(arr) {
      if (!Array.isArray(arr) || arr.length === 0) return 0;
      const m = avg(arr);
      const v = avg(arr.map((x) => Math.pow(Number(x || 0) - m, 2)));
      return Math.sqrt(v);
    }
    function simulationMultiplier() {
      let m = 1;
      if (state.simTraffic) m *= 1.2;
      if (state.simConversion) m *= 1.05;
      if (state.simShowroom) m *= 1.12;
      return m;
    }
    function scenarioRatio(data) {
      const s = data && data.scenarios ? data.scenarios : null;
      const base = Number(s && s.realisticMad ? s.realisticMad : 0);
      if (!base) return 1;
      if (state.scenario === "pess") return Number(s.pessimisticMad || base) / base;
      if (state.scenario === "opt") return Number(s.optimisticMad || base) / base;
      return 1;
    }
    function confidenceLevel(total, low, high) {
      const t = Math.max(1, Number(total || 0));
      const width = Math.max(0, Number(high || 0) - Number(low || 0)) / t;
      if (width < 0.28) return "high";
      if (width < 0.5) return "medium";
      return "low";
    }
    function levelBadgeClass(level) {
      if (level === "high") return "b-ok";
      if (level === "medium") return "b-warn";
      return "b-bad";
    }
    function statusClass(score) {
      if (score >= 70) return "b-ok";
      if (score >= 45) return "b-warn";
      return "b-bad";
    }
    function buildInsights(data, historyRevenue, prevRevenue) {
      const summary365 = Array.isArray(data.horizonSummaries)
        ? data.horizonSummaries.find((x) => Number(x.horizonDays) === 365) || data.horizonSummaries[data.horizonSummaries.length - 1]
        : null;
      const forecastOrders = Number(summary365 ? summary365.orders : 0);
      const histOrdersDaily = state.insightsSeries.length > 0 ? avg(state.insightsSeries.map((p) => Number(p.orders || 0))) : 0;
      const capMonthly = Math.max(1, histOrdersDaily * 30 * 1.1);
      const productionLoad = clamp((forecastOrders / 12) / Math.max(1, capMonthly) * 100, 0, 100);
      const outstanding = Number(data && data.dataUsage ? data.dataUsage.historyOrders : 0);
      const next30 = Number(data.next30RevenueMad || 0);
      const cashPressure = clamp((outstanding / Math.max(1, next30)) * 100, 0, 100);
      const growthPct = prevRevenue > 0 ? ((historyRevenue - prevRevenue) / prevRevenue) * 100 : 0;
      const momentum = clamp(50 + growthPct * 0.8, 0, 100);
      const first90 = (Array.isArray(data.points) ? data.points : []).slice(0, 90).map((p) => Number(p.value || 0));
      const accel = clamp(50 + ((avg(first90.slice(0,45)) - avg(first90.slice(45,90))) / Math.max(1, avg(first90))) * 100, 0, 100);
      const monthly = Array.isArray(data.monthlyOrdersForecast) ? data.monthlyOrdersForecast : [];
      const peak = monthly.length ? clamp((Math.max(...monthly.map((m) => Number(m.revenueMad || 0))) / Math.max(1, avg(monthly.map((m) => Number(m.revenueMad || 0))))) * 45, 0, 100) : 50;
      return [
        { title: "Production Load Index", score: productionLoad, text: productionLoad > 70 ? "Charge atelier élevée." : "Charge atelier soutenable.", action: "Ajuster capacité coupe/essayage." },
        { title: "Cash Flow Pressure", score: cashPressure, text: cashPressure > 65 ? "Pression encaissement notable." : "Pression encaissement maîtrisée.", action: "Prioriser relances règlement." },
        { title: "Growth Momentum", score: momentum, text: momentum > 60 ? "Momentum positif." : "Momentum à renforcer.", action: "Renforcer acquisition premium." },
        { title: "Demand Acceleration", score: accel, text: accel > 55 ? "Demande en accélération." : "Demande stable à lente.", action: "Adapter allocation équipe vente." },
        { title: "Seasonality Peak", score: peak, text: peak > 70 ? "Pic saisonnier détecté." : "Saisonnalité modérée.", action: "Sécuriser stock matières." }
      ];
    }
    function renderExecutive() {
      const data = state.forecast;
      if (!data) return;
      const points365 = (Array.isArray(data.points) ? data.points : []).slice(0, 365);
      const simMul = simulationMultiplier();
      const scRatio = scenarioRatio(data);
      const total = points365.reduce((s,p)=>s + Number(p.value || 0) * scRatio * simMul, 0);
      const low = points365.reduce((s,p)=>s + Number(p.lower || 0) * scRatio * simMul, 0);
      const high = points365.reduce((s,p)=>s + Number(p.upper || 0) * scRatio * simMul, 0);
      const lvl = confidenceLevel(total, low, high);
      const hist = state.insightsSeries;
      const sorted = hist.slice().sort((a,b)=>String(a.date||"").localeCompare(String(b.date||"")));
      const cur = sorted.slice(-365).reduce((s,p)=>s + Number(p.revenueMad || 0), 0);
      const prev = sorted.slice(-730,-365).reduce((s,p)=>s + Number(p.revenueMad || 0), 0);
      const growth = prev > 0 ? ((total - prev) / prev) * 100 : 0;
      const volatility = avg(points365.map((p)=>Number(p.value||0))) > 0
        ? stddev(points365.map((p)=>Number(p.value||0))) / avg(points365.map((p)=>Number(p.value||0)))
        : 0;
      const risk = volatility > 0.32;

      if (els.execRevenue365) els.execRevenue365.textContent = formatMad(total);
      if (els.execGrowth) {
        els.execGrowth.className = "badge " + (growth >= 0 ? "b-ok" : "b-bad");
        els.execGrowth.textContent = "Croissance vs période précédente: " + fmtPct(growth);
      }
      if (els.execConfidence) {
        els.execConfidence.className = "badge " + levelBadgeClass(lvl);
        els.execConfidence.textContent = "Confiance " + (lvl === "high" ? "Haute" : lvl === "medium" ? "Moyenne" : "Faible");
      }
      if (els.execRisk) {
        els.execRisk.className = "badge " + (risk ? "b-bad" : "b-ok");
        els.execRisk.textContent = risk ? "Risque volatilité détecté" : "Volatilité maîtrisée";
      }
      if (els.execInterpretation) {
        els.execInterpretation.textContent =
          growth >= 0
            ? "Trajectoire positive sur 365 jours avec " + (lvl === "high" ? "bonne" : "prudente") + " fiabilité statistique."
            : "Projection en repli: arbitrage production/encaissement recommandé pour préserver la marge.";
      }
      const left95 = clamp(((low / Math.max(1, high)) * 100), 0, 96);
      const width95 = clamp((((high - low) / Math.max(1, high)) * 100), 2, 100 - left95);
      const low80 = low + (high - low) * 0.1;
      const high80 = high - (high - low) * 0.1;
      const left80 = clamp(((low80 / Math.max(1, high)) * 100), 0, 96);
      const width80 = clamp((((high80 - low80) / Math.max(1, high)) * 100), 2, 100 - left80);
      if (els.band95) {
        els.band95.style.left = left95 + "%";
        els.band95.style.width = width95 + "%";
      }
      if (els.band80) {
        els.band80.style.left = left80 + "%";
        els.band80.style.width = width80 + "%";
      }
      if (els.scPess && data.scenarios) els.scPess.textContent = formatMad(Number(data.scenarios.pessimisticMad || 0) * simMul);
      if (els.scReal && data.scenarios) els.scReal.textContent = formatMad(Number(data.scenarios.realisticMad || 0) * simMul);
      if (els.scOpt && data.scenarios) els.scOpt.textContent = formatMad(Number(data.scenarios.optimisticMad || 0) * simMul);

      const cards = buildInsights(data, cur, prev);
      if (els.insightsGrid) {
        els.insightsGrid.innerHTML = cards.map((c) =>
          "<article class='insight'>" +
            "<div class='title'>" + c.title + "</div>" +
            "<div class='score'>" + String(Math.round(c.score)) + "<span class='badge " + statusClass(c.score) + "' style='margin-left:8px; vertical-align:middle;'>" + (c.score >= 70 ? "Vert" : c.score >= 45 ? "Ambre" : "Rouge") + "</span></div>" +
            "<div class='text'>" + c.text + "</div>" +
            "<div class='action'>Action: " + c.action + "</div>" +
          "</article>"
        ).join("");
      }
    }
    function renderMethodology() {
      const data = state.forecast;
      if (!data || !data.dataUsage) return;
      const d = data.dataUsage;
      if (els.mPeriod) els.mPeriod.textContent = "Période: " + String(d.historyFrom || "-") + " → " + String(d.historyTo || "-");
      if (els.mOrders) els.mOrders.textContent = "Commandes analysées: " + String(Number(d.historyOrders || 0));
      if (els.mModel) els.mModel.textContent = "Modèle: Hybrid ARIMA+Prophet (base " + String(d.modelType || "ARIMA_PLUS") + ")";
      if (els.mExt) {
        const scOn = Boolean(d.externalSignals && d.externalSignals.searchConsole && d.externalSignals.searchConsole.configured);
        const trOn = Boolean(d.externalSignals && d.externalSignals.trends && d.externalSignals.trends.configured);
        const gaOn = Boolean(d.externalSignals && d.externalSignals.ga4 && d.externalSignals.ga4.configured);
        els.mExt.textContent = "Ajustements externes: SC " + (scOn ? "actif" : "off") + " · Trends " + (trOn ? "actif" : "off") + " · GA4 " + (gaOn ? "actif" : "off");
      }
      if (els.methodTech) {
        const signals = d.externalSignals || {};
        const notes = Array.isArray(signals.notes) ? signals.notes : [];
        els.methodTech.innerHTML =
          "<strong>Architecture statistique</strong><br/>" +
          "ARIMA + Prophet combinés (pondération par erreur historique), backtesting roulant et calibration robuste.<br/><br/>" +
          "<strong>Backtesting & qualité</strong><br/>" +
          "MAPE estimée sur fenêtres glissantes, intervalle de confiance 80/95%, détection d'anomalies mensuelles.<br/><br/>" +
          "<strong>Features</strong><br/>" +
          String(Array.isArray(d.features) ? d.features.join(", ") : "-") + "<br/><br/>" +
          "<strong>Signaux externes</strong><br/>" +
          "Search Console facteur x" + Number(signals.searchConsole && signals.searchConsole.factor ? signals.searchConsole.factor : 1).toFixed(2) +
          " · Trends x" + Number(signals.trends && signals.trends.factor ? signals.trends.factor : 1).toFixed(2) +
          " · GA4 x" + Number(signals.ga4 && signals.ga4.factor ? signals.ga4.factor : 1).toFixed(2) +
          "<br/>Notes: " + (notes.length ? notes.join(" | ") : "aucune") +
          "<br/><br/><strong>Version modèle</strong><br/>v2.0.0";
      }
    }
    function renderLabChart() {
      const data = state.forecast;
      if (!data || !els.labChart) return;
      const points = (Array.isArray(data.points) ? data.points : []).slice(0, 365);
      if (points.length === 0) {
        els.labChart.innerHTML = "<svg viewBox='0 0 980 320' preserveAspectRatio='none'><text x='490' y='160' text-anchor='middle' fill='#94a3b8'>Aucune donnée</text></svg>";
        return;
      }
      const ratio = scenarioRatio(data);
      const simMul = simulationMultiplier();
      const refAov = Number(data.dataUsage && data.dataUsage.referenceAovMad ? data.dataUsage.referenceAovMad : 35000);
      const values = points.map((p) => {
        const rev = Number(p.value || 0) * ratio * simMul;
        if (state.metric === "orders") return rev / Math.max(1, refAov);
        return rev;
      });
      const lowValues = points.map((p) => {
        const rev = Number(p.lower || 0) * ratio * simMul;
        if (state.metric === "orders") return rev / Math.max(1, refAov);
        return rev;
      });
      const highValues = points.map((p) => {
        const rev = Number(p.upper || 0) * ratio * simMul;
        if (state.metric === "orders") return rev / Math.max(1, refAov);
        return rev;
      });
      const width = 980, height = 320;
      const margin = { top: 20, right: 20, bottom: 36, left: 60 };
      const plotW = width - margin.left - margin.right;
      const plotH = height - margin.top - margin.bottom;
      const maxY = Math.max(...highValues, ...values, 1);
      const xAt = (i) => margin.left + (i / Math.max(1, values.length - 1)) * plotW;
      const yAt = (v) => margin.top + (1 - (Number(v || 0) / maxY)) * plotH;
      const linePath = values.map((v,i)=>(i===0?"M ":"L ")+xAt(i)+" "+yAt(v)).join(" ");
      const lowPath = lowValues.map((v,i)=>(i===0?"M ":"L ")+xAt(i)+" "+yAt(v)).join(" ");
      const highPath = highValues.map((v,i)=>(i===0?"M ":"L ")+xAt(i)+" "+yAt(v)).join(" ");
      const bandPath = highPath + " " + lowValues.slice().reverse().map((v,ri)=> {
        const i = lowValues.length - 1 - ri;
        return "L " + xAt(i) + " " + yAt(v);
      }).join(" ") + " Z";
      const ticks = [0, 90, 180, 270, values.length - 1].filter((v, i, a) => v >= 0 && v < values.length && a.indexOf(v) === i);
      const labels = ticks.map((i)=> {
        const d = String(points[i].date || "");
        return "<text x='" + xAt(i) + "' y='" + (height - 10) + "' text-anchor='middle' fill='#8a94a6' font-size='10'>" + (d ? d.slice(5,7)+"/"+d.slice(2,4) : "-") + "</text>";
      }).join("");
      els.labChart.innerHTML =
        "<svg viewBox='0 0 " + width + " " + height + "' preserveAspectRatio='none'>" +
          (state.showCi95 ? "<path d='" + bandPath + "' fill='rgba(29,78,216,0.10)'/>" : "") +
          (state.showCi80 ? "<path d='" + linePath + "' fill='none' stroke='rgba(29,78,216,0.2)' stroke-width='6' stroke-linecap='round' stroke-linejoin='round'/>" : "") +
          "<path d='" + linePath + "' fill='none' stroke='#1d4ed8' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'/>" +
          "<line id='labHoverLine' x1='0' y1='" + margin.top + "' x2='0' y2='" + (height - margin.bottom) + "' stroke='#94a3b8' stroke-dasharray='3 3' stroke-width='1' visibility='hidden'/>" +
          "<circle id='labDot' cx='0' cy='0' r='4' fill='#1d4ed8' stroke='#fff' stroke-width='2' visibility='hidden'/>" +
          labels +
        "</svg>" +
        "<div id='labTip' class='tip'><div id='labTipDate' style='font-weight:700;margin-bottom:6px;'></div><div id='labTipValue'></div><div id='labTipBand' style='margin-top:5px;color:#64748b;'></div></div>";
      const svg = els.labChart.querySelector("svg");
      const hoverLine = els.labChart.querySelector("#labHoverLine");
      const dot = els.labChart.querySelector("#labDot");
      const tip = els.labChart.querySelector("#labTip");
      const tipDate = els.labChart.querySelector("#labTipDate");
      const tipValue = els.labChart.querySelector("#labTipValue");
      const tipBand = els.labChart.querySelector("#labTipBand");
      function hide() {
        if (hoverLine) hoverLine.setAttribute("visibility", "hidden");
        if (dot) dot.setAttribute("visibility", "hidden");
        if (tip) tip.style.display = "none";
      }
      function showAt(clientX) {
        if (!svg || !hoverLine || !dot || !tip) return;
        const rect = svg.getBoundingClientRect();
        if (rect.width <= 0) return;
        const localX = Math.max(margin.left, Math.min(margin.left + plotW, ((clientX - rect.left) / rect.width) * width));
        const index = Math.max(0, Math.min(values.length - 1, Math.round(((localX - margin.left) / plotW) * (values.length - 1))));
        const x = xAt(index), y = yAt(values[index]);
        hoverLine.setAttribute("x1", String(x));
        hoverLine.setAttribute("x2", String(x));
        hoverLine.setAttribute("visibility", "visible");
        dot.setAttribute("cx", String(x));
        dot.setAttribute("cy", String(y));
        dot.setAttribute("visibility", "visible");
        if (tipDate) tipDate.textContent = String(points[index].date || "-");
        if (tipValue) tipValue.textContent = (state.metric === "orders" ? "Orders: " + Math.round(values[index]) : "CA: " + formatMad(values[index]));
        if (tipBand) tipBand.textContent = "IC: " + (state.metric === "orders" ? (Math.round(lowValues[index]) + " - " + Math.round(highValues[index])) : (formatMad(lowValues[index]) + " - " + formatMad(highValues[index])));
        tip.style.display = "block";
      }
      if (svg) {
        svg.addEventListener("mousemove", (e) => showAt(e.clientX));
        svg.addEventListener("mouseleave", hide);
        svg.addEventListener("touchmove", (e) => {
          if (!e.touches || e.touches.length === 0) return;
          showAt(e.touches[0].clientX);
        }, { passive: true });
        svg.addEventListener("touchend", hide, { passive: true });
      }
    }
    function renderMonthlyLabTable() {
      const data = state.forecast;
      if (!data || !els.labMonthlyBody) return;
      const forecast = Array.isArray(data.monthlyOrdersForecast) ? data.monthlyOrdersForecast : [];
      const actual = state.insightsSeries;
      const actualByMonth = new Map();
      actual.forEach((r) => {
        const d = String(r.date || "").slice(0, 7);
        if (!d) return;
        const cur = actualByMonth.get(d) || { revenue: 0, orders: 0 };
        cur.revenue += Number(r.revenueMad || 0);
        cur.orders += Number(r.orders || 0);
        actualByMonth.set(d, cur);
      });
      const simMul = simulationMultiplier();
      const scRatio = scenarioRatio(data);
      const refAov = Number(data.dataUsage && data.dataUsage.referenceAovMad ? data.dataUsage.referenceAovMad : 35000);
      const rows = forecast.map((f, idx) => {
        const month = String(f.month || "");
        const monthLabel = month ? month.slice(5, 7) + "/" + month.slice(0, 4) : "-";
        const foreRev = Number(f.revenueMad || 0) * scRatio * simMul;
        const foreOrders = Math.max(0, Math.round(Number(f.orders || 0) * scRatio * simMul));
        const act = actualByMonth.get(month);
        const actRev = act ? Number(act.revenue || 0) : null;
        const actOrd = act ? Number(act.orders || 0) : null;
        const delta = actRev !== null && foreRev > 0 ? ((actRev - foreRev) / foreRev) * 100 : null;
        const isAnomaly = delta !== null ? Math.abs(delta) > 18 : false;
        const dStart = idx * 30;
        const slice = (Array.isArray(data.points) ? data.points : []).slice(dStart, dStart + 30);
        const v = slice.reduce((s,p)=>s + Number(p.value || 0), 0) || foreRev;
        const l = slice.reduce((s,p)=>s + Number(p.lower || 0), 0);
        const u = slice.reduce((s,p)=>s + Number(p.upper || 0), 0);
        const conf = v > 0 ? clamp(100 - ((Math.max(0, u - l) / v) * 50), 45, 98) : 60;
        return { monthLabel, actRev, actOrd, foreRev, foreOrders, delta, conf, isAnomaly };
      });
      els.labMonthlyBody.innerHTML = rows.map((r) => {
        const deltaCls = r.delta === null ? "delta-flat" : (r.delta >= 0 ? "delta-up" : "delta-down");
        const deltaText = r.delta === null ? "n/a" : fmtPct(r.delta);
        const realText = state.metric === "orders" ? (r.actOrd === null ? "-" : String(Math.round(r.actOrd))) : (r.actRev === null ? "-" : formatMad(r.actRev));
        const foreText = state.metric === "orders" ? String(Math.round(r.foreOrders)) : formatMad(r.foreRev);
        return "<tr>" +
          "<td>" + r.monthLabel + "</td>" +
          "<td>" + realText + "</td>" +
          "<td>" + foreText + "</td>" +
          "<td class='" + deltaCls + "'>" + deltaText + "</td>" +
          "<td>" + r.conf.toFixed(0) + "%</td>" +
          "<td>" + (r.isAnomaly ? "<span class='anomaly'>Oui</span>" : "Non") + "</td>" +
        "</tr>";
      }).join("");
    }
    function refreshAll() {
      renderExecutive();
      renderMethodology();
      renderLabChart();
      renderMonthlyLabTable();
      syncToggleStates();
    }
    function syncToggleStates() {
      const map = [
        [els.metricRevenueBtn, state.metric === "revenue"],
        [els.metricOrdersBtn, state.metric === "orders"],
        [els.scenarioRealBtn, state.scenario === "real"],
        [els.scenarioPessBtn, state.scenario === "pess"],
        [els.scenarioOptBtn, state.scenario === "opt"],
        [els.ci80Btn, state.showCi80],
        [els.ci95Btn, state.showCi95],
        [els.simTrafficBtn, state.simTraffic],
        [els.simConversionBtn, state.simConversion],
        [els.simShowroomBtn, state.simShowroom]
      ];
      map.forEach(([el, active]) => {
        if (!el) return;
        el.classList.toggle("active", !!active);
        if (!el.classList.contains("toggle")) el.style.background = active ? "#eaf1ff" : "#fff";
      });
    }
    function exportCsv() {
      const data = state.forecast;
      if (!data) return;
      const rows = [];
      rows.push(["month", "actual_revenue_mad", "forecast_revenue_mad", "actual_orders", "forecast_orders", "delta_pct", "confidence_pct"]);
      const body = els.labMonthlyBody;
      if (body) {
        Array.from(body.querySelectorAll("tr")).forEach((tr) => {
          const cells = Array.from(tr.querySelectorAll("td")).map((td) => String(td.textContent || "").trim());
          if (cells.length === 6) rows.push([cells[0], cells[1], cells[2], "", "", cells[3], cells[4]]);
        });
      }
      const csv = rows.map((r)=>r.map((v)=>'"' + String(v).replace(/"/g,'""') + '"').join(",")).join("\\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "forecast_v2_executive.csv";
      a.click();
      URL.revokeObjectURL(a.href);
    }
    function exportPdf() {
      window.print();
    }
    function estimateRefreshCostMad(forecast) {
      // Estimation informative (non contractuelle): coût BigQuery approx selon volume traité.
      const points = Math.max(0, Number(forecast && forecast.dataUsage ? forecast.dataUsage.historyPoints : 0));
      const baseUsd = 0.004; // minimum run overhead
      const variableUsd = (points / 1000) * 0.0009;
      const usd = baseUsd + variableUsd;
      const madRate = 10;
      return Number((usd * madRate).toFixed(3));
    }
    function readRefreshHistory() {
      try {
        const raw = localStorage.getItem(REFRESH_COST_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    function writeRefreshHistory(rows) {
      try {
        localStorage.setItem(REFRESH_COST_KEY, JSON.stringify(Array.isArray(rows) ? rows.slice(0, 20) : []));
      } catch {}
    }
    function recordRefreshCost(forecast) {
      const nowIso = new Date().toISOString();
      const points = Math.max(0, Number(forecast && forecast.dataUsage ? forecast.dataUsage.historyPoints : 0));
      const horizon = Math.max(1, Math.floor(Number(forecast && forecast.horizon ? forecast.horizon : 365)));
      const estimatedMad = estimateRefreshCostMad(forecast);
      const rows = readRefreshHistory();
      rows.unshift({ at: nowIso, horizon, points, estimatedMad });
      writeRefreshHistory(rows);
      return { at: nowIso, horizon, points, estimatedMad };
    }
    function renderRefreshCostHistory() {
      if (!els.refreshCostBody) return;
      const rows = readRefreshHistory();
      if (!rows.length) {
        els.refreshCostBody.innerHTML = "<tr><td colspan='4' class='kicker'>Aucune actualisation enregistrée.</td></tr>";
        return;
      }
      els.refreshCostBody.innerHTML = rows.map((row) => {
        const d = new Date(String(row.at || ""));
        const dateLabel = Number.isNaN(d.getTime())
          ? String(row.at || "-")
          : d.toLocaleString("fr-FR", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
        const costLabel = Number(row.estimatedMad || 0).toFixed(3) + " MAD";
        return "<tr>" +
          "<td>" + dateLabel + "</td>" +
          "<td>" + String(Number(row.horizon || 0)) + "j</td>" +
          "<td>" + String(Number(row.points || 0)) + "</td>" +
          "<td>" + costLabel + "</td>" +
        "</tr>";
      }).join("");
    }
    async function loadData() {
      const [forecastRes, seriesRes] = await Promise.all([
        fetch("/admin/api/forecast/revenue/latest"),
        fetch("/admin/api/insights/series?" + new URLSearchParams({ from: new Date(Date.now() - 730 * 86400000).toISOString().slice(0,10), to: new Date().toISOString().slice(0,10) }).toString())
      ]);
      const forecastParsed = await readJsonSafe(forecastRes);
      const seriesParsed = await readJsonSafe(seriesRes);
      if (forecastParsed.ok && forecastParsed.data && forecastParsed.data.ok && forecastParsed.data.forecast) {
        state.forecast = forecastParsed.data.forecast;
        if (els.v2Status) {
          els.v2Status.textContent =
            "Dernier forecast chargé (" +
            String(state.forecast.mode || "robust") +
            ", " +
            String(state.forecast.horizon || 365) +
            "j).";
        }
      } else {
        if (els.v2Status) {
          els.v2Status.textContent = "Aucun forecast sauvegardé. Cliquez sur “Actualiser forecast (payant)”.";
        }
      }
      if (seriesParsed.ok && seriesParsed.data && seriesParsed.data.ok && Array.isArray(seriesParsed.data.series)) {
        state.insightsSeries = seriesParsed.data.series;
      }
      refreshAll();
      renderRefreshCostHistory();
    }
    async function runForecastNow() {
      if (!els.runForecastV2Btn) return;
      els.runForecastV2Btn.disabled = true;
      if (els.v2Status) els.v2Status.textContent = "Forecast en cours...";
      try {
        const runRes = await fetch("/admin/api/forecast/revenue?horizon=365&mode=robust");
        const runParsed = await readJsonSafe(runRes);
        if (!runRes.ok || !runParsed.ok || !runParsed.data || !runParsed.data.ok || !runParsed.data.forecast) {
          const msg = runParsed.ok && runParsed.data && runParsed.data.error ? runParsed.data.error : "Erreur forecast";
          if (els.v2Status) els.v2Status.textContent = "Forecast échoué: " + msg;
          return;
        }
        state.forecast = runParsed.data.forecast;
        const cost = recordRefreshCost(state.forecast);
        if (els.v2Status) {
          els.v2Status.textContent =
            "Forecast recalculé (" +
            String(state.forecast.mode || "robust") +
            ", " +
            String(state.forecast.horizon || 365) +
            "j) · Est. coût " + Number(cost.estimatedMad || 0).toFixed(3) + " MAD.";
        }
        refreshAll();
        renderRefreshCostHistory();
      } catch (error) {
        if (els.v2Status) {
          els.v2Status.textContent =
            "Forecast échoué: " + (error instanceof Error ? error.message : "erreur inconnue");
        }
      } finally {
        els.runForecastV2Btn.disabled = false;
      }
    }

    if (els.metricRevenueBtn) els.metricRevenueBtn.addEventListener("click", () => { state.metric = "revenue"; refreshAll(); });
    if (els.metricOrdersBtn) els.metricOrdersBtn.addEventListener("click", () => { state.metric = "orders"; refreshAll(); });
    if (els.scenarioRealBtn) els.scenarioRealBtn.addEventListener("click", () => { state.scenario = "real"; refreshAll(); });
    if (els.scenarioPessBtn) els.scenarioPessBtn.addEventListener("click", () => { state.scenario = "pess"; refreshAll(); });
    if (els.scenarioOptBtn) els.scenarioOptBtn.addEventListener("click", () => { state.scenario = "opt"; refreshAll(); });
    if (els.ci80Btn) els.ci80Btn.addEventListener("click", () => { state.showCi80 = !state.showCi80; refreshAll(); });
    if (els.ci95Btn) els.ci95Btn.addEventListener("click", () => { state.showCi95 = !state.showCi95; refreshAll(); });
    if (els.simTrafficBtn) els.simTrafficBtn.addEventListener("click", () => { state.simTraffic = !state.simTraffic; refreshAll(); });
    if (els.simConversionBtn) els.simConversionBtn.addEventListener("click", () => { state.simConversion = !state.simConversion; refreshAll(); });
    if (els.simShowroomBtn) els.simShowroomBtn.addEventListener("click", () => { state.simShowroom = !state.simShowroom; refreshAll(); });
    if (els.exportCsvBtn) els.exportCsvBtn.addEventListener("click", exportCsv);
    if (els.exportPdfBtn) els.exportPdfBtn.addEventListener("click", exportPdf);
    if (els.runForecastV2Btn) els.runForecastV2Btn.addEventListener("click", runForecastNow);
    syncToggleStates();
    loadData();
  </script>
</body>
</html>`);
  */
});

adminRouter.get("/forecast-v3", (req, res) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query || {})) {
    if (Array.isArray(value)) {
      value.forEach((v) => {
        if (typeof v === "string") params.append(key, v);
      });
      continue;
    }
    if (typeof value === "string") params.set(key, value);
  }
  params.delete("version");
  const suffix = params.toString();
  return res.redirect(302, `/admin/forecast${suffix ? `?${suffix}` : ""}`);
});

adminRouter.get("/forecast-v4", (req, res) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query || {})) {
    if (Array.isArray(value)) {
      value.forEach((v) => {
        if (typeof v === "string") params.append(key, v);
      });
      continue;
    }
    if (typeof value === "string") params.set(key, value);
  }
  params.delete("version");
  const suffix = params.toString();
  return res.redirect(302, `/admin/forecast${suffix ? `?${suffix}` : ""}`);
});

adminRouter.get("/priority", (req, res) => {
  const host = typeof req.query.host === "string" ? req.query.host : "";
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  const embedded = typeof req.query.embedded === "string" ? req.query.embedded : "";
  const navParams = new URLSearchParams();
  if (host) navParams.set("host", host);
  if (shop) navParams.set("shop", shop);
  if (embedded) navParams.set("embedded", embedded);
  const navSuffix = navParams.toString() ? `?${navParams.toString()}` : "";

  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="shopify-api-key" content="${env.SHOPIFY_API_KEY}" />
  <title>Priority Inbox</title>
  <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
  <style>
    :root {
      --bg-0: #060b14;
      --bg-1: #0b1324;
      --panel: rgba(15, 24, 42, 0.86);
      --panel-border: rgba(132, 154, 196, 0.22);
      --text: #ecf2ff;
      --muted: #9fb0cf;
      --line: rgba(132, 154, 196, 0.18);
      --green: #18c783;
      --yellow: #f5bb39;
      --red: #f55d6e;
      --chip: rgba(16, 24, 42, 0.72);
      --shadow: 0 30px 60px rgba(2, 8, 25, 0.55);
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; }
    body {
      font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      color: var(--text);
      background:
        radial-gradient(1000px 540px at 12% -10%, rgba(43, 114, 255, 0.25), transparent 65%),
        radial-gradient(900px 500px at 90% -8%, rgba(35, 212, 177, 0.16), transparent 62%),
        linear-gradient(180deg, var(--bg-0), var(--bg-1));
    }
    .page {
      min-height: 100vh;
      max-width: 1400px;
      margin: 0 auto;
      padding: 20px 22px 28px;
      display: grid;
      grid-template-rows: auto auto 1fr;
      gap: 14px;
    }
    .nav {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      padding: 10px;
      border: 1px solid var(--panel-border);
      border-radius: 14px;
      background: rgba(9, 16, 31, 0.7);
      backdrop-filter: blur(8px);
    }
    .nav a {
      text-decoration: none;
      color: #b9c7e2;
      padding: 7px 11px;
      border-radius: 10px;
      border: 1px solid transparent;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: .01em;
    }
    .nav a:hover { background: rgba(105, 139, 199, 0.16); border-color: var(--line); }
    .nav a.active { color: #fff; background: rgba(57, 122, 246, 0.27); border-color: rgba(120, 159, 223, 0.45); }
    .hero {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      padding: 16px 18px;
      border-radius: 16px;
      border: 1px solid var(--panel-border);
      background: linear-gradient(135deg, rgba(21, 35, 64, 0.88), rgba(14, 24, 46, 0.82));
      box-shadow: var(--shadow);
    }
    .title { margin: 0; font-size: 24px; letter-spacing: -0.02em; }
    .subtitle { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
    .refresh-btn {
      background: rgba(56, 127, 255, 0.24);
      border: 1px solid rgba(139, 180, 255, 0.42);
      color: #f5f8ff;
      border-radius: 12px;
      padding: 10px 14px;
      font-weight: 700;
      cursor: pointer;
    }
    .refresh-btn:disabled { opacity: .55; cursor: default; }
    .backfill-btn {
      background: rgba(88, 201, 157, 0.20);
      border: 1px solid rgba(125, 224, 187, 0.42);
      color: #f5fffa;
      border-radius: 12px;
      padding: 10px 14px;
      font-weight: 700;
      cursor: pointer;
    }
    .backfill-btn:disabled { opacity: .55; cursor: default; }
    .grid {
      min-height: 0;
      border: 1px solid var(--panel-border);
      border-radius: 16px;
      background: var(--panel);
      box-shadow: var(--shadow);
      overflow: hidden;
      display: grid;
      grid-template-rows: auto 1fr;
    }
    .head {
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      display: flex;
      justify-content: space-between;
      align-items: center;
      color: var(--muted);
      font-size: 12px;
      letter-spacing: .05em;
      text-transform: uppercase;
      position: sticky;
      top: 0;
      background: rgba(15, 24, 42, 0.95);
      z-index: 2;
    }
    .table-wrap { overflow: auto; min-height: 0; }
    table { width: 100%; border-collapse: collapse; min-width: 1000px; }
    th, td {
      text-align: left;
      padding: 11px 12px;
      border-bottom: 1px solid rgba(132, 154, 196, 0.12);
      font-size: 13px;
    }
    th { color: #9fb0cf; font-weight: 700; position: sticky; top: 0; background: rgba(15, 24, 42, 0.98); z-index: 1; }
    tr:hover { background: rgba(102, 129, 179, 0.10); }
    .chip {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 3px 10px;
      font-size: 12px;
      font-weight: 700;
      background: var(--chip);
      border: 1px solid rgba(132, 154, 196, 0.25);
    }
    .score-green { color: #d5ffe8; border-color: rgba(24, 199, 131, 0.58); background: rgba(24, 199, 131, 0.18); }
    .score-yellow { color: #fff3cd; border-color: rgba(245, 187, 57, 0.56); background: rgba(245, 187, 57, 0.18); }
    .score-red { color: #ffe1e6; border-color: rgba(245, 93, 110, 0.56); background: rgba(245, 93, 110, 0.16); }
    .risk-yes { color: #ffe5ea; background: rgba(245, 93, 110, 0.16); border-color: rgba(245, 93, 110, 0.56); }
    .risk-no { color: #d8e7ff; background: rgba(117, 161, 233, 0.14); border-color: rgba(117, 161, 233, 0.44); }
    .sla-ok { color: #d8e7ff; background: rgba(117, 161, 233, 0.14); border-color: rgba(117, 161, 233, 0.44); }
    .sla-due { color: #fff3cd; border-color: rgba(245, 187, 57, 0.56); background: rgba(245, 187, 57, 0.18); }
    .sla-breached { color: #ffe1e6; border-color: rgba(245, 93, 110, 0.56); background: rgba(245, 93, 110, 0.16); }
    .muted { color: var(--muted); }
    .empty {
      padding: 32px;
      color: var(--muted);
      text-align: center;
      font-size: 14px;
    }
    @media (max-width: 1000px) {
      .page { padding: 14px; }
      .title { font-size: 20px; }
    }
  </style>
</head>
<body>
  <div class="page">
    <nav class="nav">
      <a href="/admin${navSuffix}">Operations</a>
      <a href="/admin/insights${navSuffix}">Insights</a>
      <a href="/admin/forecast${navSuffix}">Forecast</a>
      <a href="/admin/priority${navSuffix}" class="active">Priority</a>
      <a href="/admin/appointments${navSuffix}">Appointments</a>
    </nav>
    <section class="hero">
      <div>
        <h1 class="title">Priority Inbox</h1>
        <p class="subtitle">Sorted by Conversion Score, Event Date, then Ticket Value.</p>
      </div>
      <button id="refreshBtn" class="refresh-btn">Refresh</button>
      <button id="backfillPricesBtn" class="backfill-btn">Backfill prices</button>
      <span id="backfillStatus" class="muted" style="font-size:12px;"></span>
      <label class="muted" style="display:inline-flex;align-items:center;gap:8px;font-size:12px;">
        SLA
        <select id="slaFilter" style="background:rgba(15,24,42,.75);color:#ecf2ff;border:1px solid var(--line);border-radius:10px;padding:6px 10px;">
          <option value="all">All</option>
          <option value="alerts">Due soon + breached</option>
        </select>
      </label>
    </section>
    <section class="grid">
      <div class="head">
        <span>Live Lead Ranking</span>
        <span id="statsLabel">Loading…</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Lead name</th>
              <th>Country</th>
              <th>Stage</th>
              <th>Conversion Score</th>
              <th>Event date</th>
              <th>Days since last message</th>
              <th>Ticket value</th>
              <th>SLA</th>
              <th>Risk flag</th>
            </tr>
          </thead>
          <tbody id="rows"></tbody>
        </table>
        <div id="emptyState" class="empty" style="display:none;">No leads available.</div>
      </div>
    </section>
  </div>

  <script>
    const rowsEl = document.getElementById("rows");
    const emptyEl = document.getElementById("emptyState");
    const statsLabelEl = document.getElementById("statsLabel");
    const refreshBtn = document.getElementById("refreshBtn");
    const backfillPricesBtn = document.getElementById("backfillPricesBtn");
    const backfillStatusEl = document.getElementById("backfillStatus");
    const slaFilterEl = document.getElementById("slaFilter");
    const initialParams = new URLSearchParams(location.search || "");
    if (slaFilterEl && initialParams.get("sla") === "alerts") {
      slaFilterEl.value = "alerts";
    }

    function esc(v) {
      return String(v == null ? "" : v)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }
    function scoreClass(score) {
      if (score >= 80) return "score-green";
      if (score >= 50) return "score-yellow";
      return "score-red";
    }
    function fmtDate(value) {
      const d = value ? new Date(value) : null;
      if (!d || Number.isNaN(d.getTime())) return "—";
      return d.toISOString().slice(0, 10);
    }
    function fmtTicket(value, currency) {
      const n = Number(value);
      if (!Number.isFinite(n)) return "—";
      const c = String(currency || "").toUpperCase();
      if (c === "USD") return "$" + new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);
      if (c === "EUR") return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(n).replace(/\\u202f/g, " ") + "€";
      if (c === "MAD") return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(n).replace(/\\u202f/g, " ") + " MAD";
      return "—";
    }
    function slaClass(status) {
      const s = String(status || "").toUpperCase();
      if (s === "BREACHED") return "sla-breached";
      if (s === "DUE_SOON") return "sla-due";
      return "sla-ok";
    }
    function buildApiUrl() {
      const params = new URLSearchParams(location.search || "");
      const mode = slaFilterEl && slaFilterEl.value === "alerts" ? "alerts" : "all";
      params.set("sla", mode);
      const query = params.toString();
      return "/admin/api/priority/leads" + (query ? "?" + query : "");
    }
    async function load() {
      refreshBtn.disabled = true;
      statsLabelEl.textContent = "Loading…";
      try {
        const apiUrl = buildApiUrl();
        const res = await fetch(apiUrl, { headers: { "accept": "application/json" } });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(payload && payload.error ? payload.error : "priority_load_failed");
        const items = Array.isArray(payload.items) ? payload.items : [];
        rowsEl.innerHTML = items.map((item) => {
          const score = Number(item.conversion_score || 0);
          return "<tr>" +
            "<td>" + esc(item.lead_name || "Unknown") + "</td>" +
            "<td>" + esc(item.country || "—") + "</td>" +
            "<td><span class='chip'>" + esc(item.stage || "NEW") + "</span></td>" +
            "<td><span class='chip " + scoreClass(score) + "'>" + esc(score) + "</span></td>" +
            "<td>" + esc(fmtDate(item.event_date)) + "</td>" +
            "<td>" + esc(item.days_since_last_message == null ? "—" : String(item.days_since_last_message)) + "</td>" +
            "<td>" + esc(fmtTicket(item.ticket_value, item.ticket_currency)) + "</td>" +
            "<td><span class='chip " + slaClass(item.sla_status) + "'>" + esc(item.sla_status || "OK") + "</span></td>" +
            "<td><span class='chip " + (item.risk_flag ? "risk-yes" : "risk-no") + "'>" + (item.risk_flag ? "AT RISK" : "OK") + "</span></td>" +
          "</tr>";
        }).join("");
        emptyEl.style.display = items.length ? "none" : "block";
        statsLabelEl.textContent = String(items.length) + " leads";
      } catch (error) {
        rowsEl.innerHTML = "";
        emptyEl.style.display = "block";
        emptyEl.textContent = "Failed to load priority leads.";
        statsLabelEl.textContent = "Error";
      } finally {
        refreshBtn.disabled = false;
      }
    }
    async function runBackfillPrices() {
      if (!backfillPricesBtn) return;
      backfillPricesBtn.disabled = true;
      if (backfillStatusEl) backfillStatusEl.textContent = "Running backfill…";
      try {
        const res = await fetch("/api/ml/backfill/prices", {
          method: "POST",
          headers: { "content-type": "application/json", "accept": "application/json" },
          body: JSON.stringify({ leadLimit: 500, messageLimit: 100 })
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(payload?.message || payload?.error || "price_backfill_failed");
        if (backfillStatusEl) {
          backfillStatusEl.textContent =
            "Done: leads=" + Number(payload?.leadsProcessed || 0) +
            ", quotes=" + Number(payload?.quotesInserted || 0) +
            ", updated=" + Number(payload?.leadsUpdated || 0);
        }
        await load();
      } catch (error) {
        if (backfillStatusEl) {
          backfillStatusEl.textContent = "Backfill failed: " + String(error?.message || "unknown_error");
        }
      } finally {
        backfillPricesBtn.disabled = false;
      }
    }
    refreshBtn.addEventListener("click", load);
    if (backfillPricesBtn) backfillPricesBtn.addEventListener("click", runBackfillPrices);
    if (slaFilterEl) slaFilterEl.addEventListener("change", load);
    load();
  </script>
</body>
</html>`);
});

adminRouter.get("/appointments", (req, res) => {
  const host = typeof req.query.host === "string" ? req.query.host : "";
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  const embedded = typeof req.query.embedded === "string" ? req.query.embedded : "";
  const isV2 = String(req.query.v || "").trim() === "2";
  const navParams = new URLSearchParams();
  if (host) navParams.set("host", host);
  if (shop) navParams.set("shop", shop);
  if (embedded) navParams.set("embedded", embedded);
  if (isV2) navParams.set("v", "2");
  const navSuffix = navParams.toString() ? `?${navParams.toString()}` : "";
  const defaultShop = shop || env.SHOPIFY_SHOP || "";

  res.type("html").send(`<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="shopify-api-key" content="${env.SHOPIFY_API_KEY}" />
  <title>${isV2 ? "Rendez-vous V2" : "Rendez-vous"}</title>
  <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
  <script>
    (function() {
      try {
        var stored = localStorage.getItem("appointmentsThemeMode") || "";
        if (stored === "dark") {
          document.documentElement.classList.add("night-dark");
          return;
        }
        if (stored === "light") {
          document.documentElement.classList.remove("night-dark");
          return;
        }
        var prefersDark = !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
        var h = new Date().getHours();
        var isNight = h >= 19 || h < 7;
        if (prefersDark || isNight) document.documentElement.classList.add("night-dark");
      } catch (_e) {}
    })();
  </script>
  <style>
    :root {
      --bg: #f0f2f5;
      --panel: #ffffff;
      --line: #d7dce4;
      --text: #1c1e21;
      --muted: #65676b;
      --gold: #1877f2;
      --ink: #1877f2;
      --shadow-soft: 0 1px 3px rgba(16, 24, 40, 0.12);
      --shadow-lift: 0 8px 18px rgba(16, 24, 40, 0.12);
      --radius-xl: 18px;
      --radius-lg: 14px;
      --radius-md: 10px;
      --t: 180ms ease;
    }
    html.night-dark {
      --bg: #0b0f16;
      --panel: #161b25;
      --line: #273142;
      --text: #eef3fb;
      --muted: #9eabbe;
      --shadow-soft: 0 1px 3px rgba(0, 0, 0, 0.4);
      --shadow-lift: 0 12px 26px rgba(0, 0, 0, 0.45);
      color-scheme: dark;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    html.night-dark .nav { background: rgba(26, 31, 40, 0.82); }
    html.night-dark .nav a { color: #d7dee9; }
    html.night-dark .nav a:hover { background: #242c38; }
    html.night-dark #viewToggle { background: #1f2631 !important; border-color: #323c4b !important; }
    html.night-dark #typeFilterSelect,
    html.night-dark #shopInput {
      background: #1f2631 !important;
      border-color: #323c4b !important;
      color: #e7ecf2 !important;
    }
    html.night-dark select option {
      background: #1f2631;
      color: #e7ecf2;
    }
    html.night-dark .shop-tag { background: #1f2631; color: #d5dbe6; }
    html.night-dark th, html.night-dark td { border-bottom-color: #2a3240; }
    html.night-dark th { color: #aeb8c6; }
    html.night-dark tr[data-row-id]:hover { background: #1f2734; }
    html.night-dark tr[data-selected="true"] { background: #1d2531; }
    html.night-dark .menu-btn,
    html.night-dark .menu,
    html.night-dark .menu button,
    html.night-dark .context-empty,
    html.night-dark .context-select,
    html.night-dark .context-notes-input,
    html.night-dark .bubble,
    html.night-dark .act,
    html.night-dark .drawer-close,
    html.night-dark .field input,
    html.night-dark .field select,
    html.night-dark .field textarea,
    html.night-dark .btn-ghost,
    html.night-dark .quick-datetime button {
      background: #1f2631;
      border-color: #323c4b;
      color: #e7ecf2;
    }
    html.night-dark .menu button:hover { background: #273140; }
    html.night-dark .kpi-top,
    html.night-dark .table-title,
    html.night-dark .toggle-row,
    html.night-dark .field label,
    html.night-dark .divider,
    html.night-dark .reschedule-helper,
    html.night-dark .context-k,
    html.night-dark .bubble .t {
      color: #c4cfdd;
    }
    html.night-dark .kpi-num,
    html.night-dark .table-title,
    html.night-dark .client-name,
    html.night-dark .timeline,
    html.night-dark .act,
    html.night-dark .context-notes-foot .count {
      color: #e8edf3;
    }
    html.night-dark .msg-cell,
    html.night-dark .table-sub,
    html.night-dark .subtitle,
    html.night-dark .count { color: #a7b2c2; }
    html.night-dark .act.primary {
      background: #0f1115;
      border-color: #0f1115;
      color: #fff;
    }
    html.night-dark .btn {
      color: #edf4ff;
      border-color: #34445c;
    }
    html.night-dark .btn-ghost {
      background: #1f2734;
      border-color: #334258;
      color: #edf4ff;
      box-shadow: none;
    }
    html.night-dark .btn-primary {
      background: #2d5be3;
      border-color: #2d5be3;
      color: #ffffff;
      box-shadow: 0 10px 24px rgba(45, 91, 227, 0.38);
    }
    html.night-dark .btn-primary:hover {
      background: #3970ff;
      border-color: #3970ff;
    }
    html.night-dark .btn-ghost:hover,
    html.night-dark .act:hover {
      background: #2a3548;
      color: #ffffff;
    }
    html.night-dark #viewListBtn.btn-ghost,
    html.night-dark #viewCalendarBtn.btn-ghost {
      background: #1a2230;
      border-color: #334258;
      color: #dfe8f5;
    }
    html.night-dark #viewListBtn.btn-primary,
    html.night-dark #viewCalendarBtn.btn-primary {
      background: #ffffff;
      border-color: #ffffff;
      color: #131923;
      box-shadow: none;
    }
    html.night-dark .menu-btn {
      background: #1f2734;
      border-color: #334258;
      color: #edf4ff;
    }
    html.night-dark .act.primary {
      background: #2d5be3;
      border-color: #2d5be3;
      color: #fff;
    }
    html.night-dark .act.pay-cta {
      background: #1f56f0;
      border-color: #2e63f3;
      color: #ffffff;
      box-shadow: 0 14px 30px rgba(31, 86, 240, 0.42);
    }
    html.night-dark .act.pay-cta:hover {
      background: #2d63ff;
      border-color: #3a6dff;
      color: #fff;
    }
    .shell { max-width: 1700px; margin: 22px auto; padding: 0 16px 24px; }
    body.pseudo-fullscreen {
      overflow: hidden;
    }
    body.pseudo-fullscreen .shell {
      max-width: none;
      margin: 0;
      padding: 8px;
      width: 100vw;
      height: 100vh;
    }
    body.pseudo-fullscreen .table-scroll {
      max-height: calc(100vh - 255px);
    }
    .layout {
      display: block;
      min-height: 0;
    }
    .sidebar-nav {
      display: none !important;
    }
    .nav {
      display: grid;
      gap: 6px;
      background: rgba(255, 255, 255, 0.72);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 6px;
      backdrop-filter: blur(10px);
      width: 100%;
    }
    .nav a {
      text-decoration: none;
      color: #2b2b2b;
      font-size: 12px;
      font-weight: 700;
      padding: 10px 12px;
      border-radius: 10px;
      transition: var(--t);
      display: block;
    }
    .nav a:hover { background: #f6f8fb; box-shadow: 0 1px 4px rgba(0, 0, 0, .08); }
    .nav a.active {
      background: #1b74e4;
      color: #fff;
      box-shadow: 0 8px 16px rgba(24, 119, 242, 0.22);
    }

    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 14px;
      margin-bottom: 14px;
      position: relative;
      z-index: 8;
    }
    .title {
      margin: 0;
      font-size: clamp(34px, 4vw, 44px);
      line-height: 1.05;
      letter-spacing: -0.02em;
      font-weight: 750;
    }
    .subtitle { margin-top: 8px; color: var(--muted); font-size: 15px; }
    .shop-tag {
      margin-top: 10px;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border: 1px solid var(--line);
      border-radius: 999px;
      font-size: 12px;
      color: #4c4640;
      background: #fff;
    }
    .actions-top { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .actions-top .btn { position: relative; z-index: 9; }
    .btn {
      border: 1px solid transparent;
      border-radius: 12px;
      padding: 10px 14px;
      font-weight: 700;
      font-size: 13px;
      cursor: pointer;
      transition: transform var(--t), box-shadow var(--t), background var(--t), border-color var(--t);
    }
    .btn:hover { transform: translateY(-1px); }
    .btn-primary {
      color: #fff;
      background: linear-gradient(135deg, #121212, #000000);
      box-shadow: 0 10px 24px rgba(0, 0, 0, 0.26);
    }
    .btn-ghost {
      background: rgba(255,255,255,.86);
      border-color: var(--line);
      color: #2f2a25;
    }

    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 0;
    }
    .kpi-layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 390px;
      gap: 12px;
      align-items: start;
      margin-bottom: 8px;
    }
    .kpi-spacer { min-height: 1px; }
    .kpi-card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: var(--radius-xl);
      box-shadow: var(--shadow-soft);
      padding: 12px;
      transition: transform 200ms ease, box-shadow 200ms ease;
      min-height: 96px;
    }
    .kpi-card:hover { transform: translateY(-2px); box-shadow: var(--shadow-lift); }
    .kpi-top { display: flex; justify-content: space-between; align-items: center; color: #6a6258; font-size: 12px; font-weight: 700; }
    .kpi-num { margin-top: 14px; font-size: 34px; font-weight: 800; letter-spacing: -0.02em; }
    .kpi-card-split {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0;
      padding: 0;
      overflow: hidden;
    }
    .kpi-split-col {
      padding: 14px;
      min-height: 106px;
    }
    .kpi-split-col + .kpi-split-col {
      border-left: 1px solid var(--line);
    }

    .split {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 390px;
      gap: 12px;
      align-items: start;
    }
    .right-stack {
      display: grid;
      gap: 12px;
      align-content: start;
      margin-top: -220px;
    }

    .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: var(--radius-xl);
      box-shadow: var(--shadow-soft);
    }

    .table-wrap { overflow: hidden; }
    .table-toolbar {
      padding: 8px 12px;
      border-bottom: 1px solid var(--line);
      display: flex;
      gap: 8px;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
    }
    .toolbar-left, .toolbar-right {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    .table-toolbar .btn {
      padding: 8px 11px;
      font-size: 12px;
    }
    .table-toolbar #typeFilterSelect {
      padding: 7px 11px;
      min-width: 168px;
    }
    .table-head {
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .table-title { font-size: 14px; font-weight: 700; }
    .table-sub { font-size: 12px; color: var(--muted); }
    .table-scroll { overflow: auto; max-height: calc(100vh - 330px); }
    table { width: 100%; border-collapse: collapse; min-width: 950px; }
    th, td { padding: 12px 14px; text-align: left; border-bottom: 1px solid #eee7dd; }
    th { color: #7a7268; font-size: 11px; text-transform: uppercase; letter-spacing: .07em; font-weight: 700; }
    tr[data-row-id] { cursor: pointer; transition: background 160ms ease; }
    tr[data-row-id]:hover { background: #f5f8ff; }
    tr[data-selected="true"] { background: #edf3ff; }

    .status-pill {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 5px 10px;
      font-size: 11px;
      font-weight: 700;
      border: 1px solid transparent;
      white-space: nowrap;
    }
    .status-scheduled { background: #f0f2f5; border-color: #d7dce4; color: #4b4f56; }
    .status-confirmed { background: #e8f5ee; border-color: #cde8d7; color: #0f6b42; }
    .status-reminder_sent { background: #edf3ff; border-color: #cfddff; color: #1b5fd1; }
    .status-rescheduled { background: #fff4e5; border-color: #f4d6aa; color: #9a5c02; }
    .status-cancelled { background: #ffeceb; border-color: #f3c4c1; color: #af2f2f; }
    .status-completed { background: #3a3b3c; border-color: #3a3b3c; color: #fff; }
    .status-no_show { background: #7b1f2a; border-color: #7b1f2a; color: #fff; }

    .msg-cell { display: flex; align-items: center; gap: 6px; color: #5f5a53; font-size: 12px; }
    .wa { color: #199d59; font-size: 14px; }

    .menu-cell { text-align: right; position: relative; }
    .menu-btn {
      width: 32px; height: 32px;
      border-radius: 10px;
      border: 1px solid var(--line);
      background: #fff;
      cursor: pointer;
      font-weight: 800;
      color: #5f574f;
    }
    .menu {
      position: absolute;
      right: 14px;
      top: 42px;
      min-width: 180px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: #fff;
      box-shadow: 0 16px 34px rgba(26, 28, 33, .18);
      z-index: 12;
      display: none;
      overflow: hidden;
    }
    .menu button {
      width: 100%;
      border: 0;
      border-bottom: 1px solid #efebe5;
      background: #fff;
      text-align: left;
      padding: 10px 12px;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      color: #2d2a26;
    }
    .menu button:last-child { border-bottom: 0; }
    .menu button:hover { background: #f9f6f2; }

    .skeleton td { padding: 14px; }
    .sk {
      height: 12px;
      border-radius: 999px;
      background: linear-gradient(90deg,#ece7df 25%, #f7f4ef 50%, #ece7df 75%);
      background-size: 260% 100%;
      animation: pulse 1.2s linear infinite;
    }
    @keyframes pulse { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }

    .context {
      padding: 8px 14px 14px;
      min-height: 640px;
      position: sticky;
      top: 0;
      margin-top: 0;
    }
    .notes-card {
      padding: 12px 14px;
      position: sticky;
      top: 0;
    }
    .quick-actions-card {
      padding: 0;
      position: sticky;
      top: 0;
      background: transparent;
      border: 0;
      box-shadow: none;
    }
    .command-bar-card {
      padding: 10px 12px 12px;
      display: grid;
      gap: 8px;
    }
    .command-bar-top {
      display: block;
      padding-bottom: 8px;
    }
    .command-bar-text {
      min-width: 0;
      display: block;
    }
    .command-bar-client {
      font-size: 18px;
      font-weight: 700;
      color: #1f2b3d;
    }
    .command-bar-meta {
      margin-top: 2px;
      font-size: 14px;
      color: #6d7d97;
      white-space: normal;
      overflow: visible;
      text-overflow: unset;
    }
    .command-bar-top .status-pill {
      margin-top: 8px;
    }
    .quick-actions-row {
      display: flex;
      gap: 8px;
      flex-wrap: nowrap;
      align-items: center;
    }
    .quick-actions-row .act {
      flex: 1 1 0;
      min-width: 0;
      text-align: center;
      border-radius: 12px;
      padding: 8px 8px;
      font-size: 11px;
      font-weight: 800;
      white-space: nowrap;
      line-height: 1.1;
    }
    #ctxTopActionComplete {
      flex: 1.35 1 0;
      color: #0f172a;
      border-color: #cdd7e5;
      background: #f8fbff;
    }
    #ctxTopActionComplete:hover {
      background: #edf4ff;
      border-color: #9eb5d6;
    }
    #ctxTopActionComplete:disabled {
      color: #64748b;
      border-color: #d6deea;
      background: #f3f6fb;
      opacity: 1;
      cursor: not-allowed;
      box-shadow: none;
      transform: none;
    }
    .context-empty {
      color: var(--muted);
      font-size: 13px;
      border: 1px dashed #ddd6cb;
      border-radius: 14px;
      padding: 16px;
      margin-top: 10px;
      background: #fff;
    }
    .client-name { font-size: 24px; font-weight: 800; letter-spacing: -0.02em; }
    .client-phone { margin-top: 2px; display: inline-block; color: #2f5f9c; text-decoration: none; font-weight: 700; }
    .context-section { margin-top: 12px; }
    #contextContent .context-section:first-of-type { margin-top: 6px; }
    .context-k { font-size: 11px; color: #7e776d; text-transform: uppercase; letter-spacing: .08em; font-weight: 700; margin-bottom: 8px; }
    .context-select {
      width: 100%;
      border: 1px solid #dcd4c9;
      border-radius: 999px;
      padding: 8px 12px;
      font-weight: 700;
      background: #fff;
      color: #2a2520;
    }
    .context-notes-input {
      width: 100%;
      border: 1px solid #dcd4c9;
      border-radius: 12px;
      padding: 9px 11px;
      background: #fff;
      color: #2a2520;
      font: inherit;
      min-height: 88px;
      resize: vertical;
    }
    .context-notes-foot {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 8px;
      gap: 8px;
    }
    .timeline {
      display: grid;
      gap: 8px;
    }
    .bubble {
      border: 1px solid #eee5d9;
      border-radius: 12px;
      padding: 9px 10px;
      background: #fff;
      font-size: 12px;
      color: #3c362f;
    }
    .bubble .t { font-size: 11px; color: #7b7369; margin-bottom: 4px; }
    .context-actions { display: grid; gap: 8px; margin-top: 12px; }
    .is-hidden { display: none !important; }
    .act {
      border: 1px solid #ddd4c8;
      border-radius: 10px;
      background: #fff;
      padding: 9px 10px;
      text-align: left;
      font-weight: 700;
      font-size: 12px;
      cursor: pointer;
      transition: var(--t);
    }
    .act:hover { transform: translateY(-1px); box-shadow: 0 8px 16px rgba(31,30,28,.12); }
    .act.primary { background: #1f2734; color: #fff; border-color: #1f2734; }
    .act.pay-cta {
      width: 100%;
      min-height: 40px;
      border-radius: 8px;
      font-size: 18px;
      font-weight: 800;
      line-height: 1;
      letter-spacing: 0.01em;
      text-align: center;
      display: grid;
      place-items: center;
      padding: 10px 16px;
      background: #0f1115;
      border-color: #0f1115;
      color: #fff;
      box-shadow: 0 12px 24px rgba(15, 17, 21, 0.24);
    }
    .act.pay-cta:hover {
      background: #1a1f2a;
      border-color: #1a1f2a;
      color: #fff;
      box-shadow: 0 14px 26px rgba(15, 17, 21, 0.34);
    }

    .drawer-close {
      display: none;
      margin-left: auto;
      margin-bottom: 8px;
      border: 1px solid #ddd3c6;
      border-radius: 10px;
      background: #fff;
      padding: 8px 10px;
      font-weight: 700;
      cursor: pointer;
    }

    .modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(21, 22, 25, .38);
      backdrop-filter: blur(2px);
      display: none;
      pointer-events: none;
      align-items: center;
      justify-content: center;
      z-index: 40;
      padding: 16px;
    }
    .modal-overlay.open {
      display: flex !important;
      pointer-events: auto;
    }
    .modal-overlay[aria-hidden="true"] {
      display: none !important;
      pointer-events: none !important;
    }
    .modal-overlay[aria-hidden="false"] {
      display: flex !important;
      pointer-events: auto !important;
    }
    .modal {
      width: min(920px, 100%);
      background: var(--bg);
      border: 1px solid var(--line);
      border-radius: 20px;
      box-shadow: 0 30px 60px rgba(16, 18, 24, .25);
      overflow: hidden;
      transform: translateY(8px);
      opacity: 0;
      transition: all 220ms ease;
    }
    .modal-overlay.open .modal { transform: translateY(0); opacity: 1; }
    .modal-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 14px 16px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }
    .modal-title { font-size: 20px; font-weight: 800; }
    .modal-body { padding: 14px 16px; background: var(--bg); }
    .divider { margin: 8px 0 10px; font-size: 11px; color: #7d776f; text-transform: uppercase; letter-spacing: .08em; font-weight: 700; }
    .form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .field label { display: block; font-size: 12px; color: #6f685f; margin-bottom: 5px; }
    .field input, .field select, .field textarea {
      width: 100%;
      border: 1px solid #d8d0c4;
      border-radius: 10px;
      padding: 9px 11px;
      background: #fff;
      font: inherit;
      color: #26211d;
    }
    .field textarea { min-height: 92px; resize: vertical; }
    .count { text-align: right; font-size: 11px; color: #8a8278; margin-top: 4px; }
    .quick-datetime {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }
    .quick-datetime button {
      border: 1px solid #d8d0c4;
      background: #fff;
      color: #2d2721;
      border-radius: 999px;
      padding: 5px 10px;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
    }
    .quick-datetime button:hover { background: #f5f2ec; }
    .modal-foot {
      border-top: 1px solid var(--line);
      padding: 12px 16px;
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      background: var(--panel);
      flex-wrap: wrap;
    }
    .order-editor-modal {
      width: min(1040px, 100%);
      background: #090d13;
      border-color: #1b212b;
      color: #eef2f7;
    }
    .order-editor-modal .modal-body {
      background: #090d13;
      padding: 16px;
      --order-space-8: 8px;
      --order-space-12: 12px;
      --order-space-16: 16px;
      --order-space-24: 24px;
    }
    .order-editor-close {
      width: 36px;
      height: 36px;
      border-radius: 10px;
      border: 1px solid #2b3340;
      background: #171d27;
      color: #eef2f7;
      font-size: 24px;
      line-height: 1;
      cursor: pointer;
    }
    .order-wizard-head {
      display: grid;
      grid-template-columns: 36px 1fr auto;
      align-items: center;
      gap: var(--order-space-12);
      margin-bottom: var(--order-space-16);
      padding-bottom: var(--order-space-12);
      border-bottom: 1px solid #202734;
    }
    .order-wizard-head .modal-title {
      text-align: center;
      margin: 0;
      font-size: 22px;
      font-weight: 800;
      letter-spacing: 0.01em;
      color: #f4f7fd;
    }
    .order-step-meta {
      min-width: 118px;
      display: grid;
      justify-items: end;
      gap: 6px;
    }
    .order-step-label {
      font-size: 12px;
      font-weight: 700;
      color: #aab5c7;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }
    .order-step-progress {
      width: 100%;
      height: 5px;
      border-radius: 999px;
      background: #212838;
      overflow: hidden;
    }
    .order-step-progress > span {
      display: block;
      height: 100%;
      width: 50%;
      background: linear-gradient(90deg, #2f5fe4, #6f9dff);
      transition: width 180ms ease;
    }
    .order-wizard-step {
      position: relative;
      transition: opacity 200ms ease, transform 200ms ease;
    }
    .order-wizard-step.is-hidden {
      opacity: 0;
      transform: translateY(8px);
      pointer-events: none;
      position: absolute;
      inset: 74px 16px 16px 16px;
      visibility: hidden;
    }
    .order-wizard-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 310px;
      gap: var(--order-space-16);
      align-items: start;
    }
    .order-step2-right {
      position: relative;
      display: grid;
      align-content: start;
    }
    .order-step2-right > #orderFinancialBadge {
      position: absolute;
      top: -34px;
      left: 0;
    }
    .order-panel {
      border: 1px solid #252d39;
      border-radius: 16px;
      background: #171c24;
      padding: var(--order-space-16);
    }
    .order-panel-title {
      margin: 0 0 var(--order-space-12);
      font-size: 14px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #9da9be;
      font-weight: 700;
    }
    .order-panel-subtitle {
      margin: var(--order-space-16) 0 var(--order-space-8);
      font-size: 13px;
      color: #b7c3d8;
      font-weight: 700;
    }
    .order-client-context {
      margin-bottom: var(--order-space-12);
      padding: 10px 12px;
      border: 1px solid #2a3240;
      border-radius: 12px;
      background: #1a2029;
      display: grid;
      gap: 8px;
    }
    .order-client-main {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
    }
    .order-client-chip {
      border: 1px solid #313a4a;
      border-radius: 999px;
      background: #202632;
      color: #edf2fa;
      font-size: 12px;
      font-weight: 700;
      padding: 5px 10px;
      cursor: pointer;
    }
    .order-client-meta {
      font-size: 12px;
      color: #9ea9bb;
    }
    .order-form-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--order-space-12);
    }
    .order-form-field {
      display: grid;
      gap: 6px;
    }
    .order-form-field.full { grid-column: 1 / -1; }
    .order-form-label {
      font-size: 12px;
      color: #9da9be;
      font-weight: 700;
      letter-spacing: 0.03em;
    }
    .order-input, .order-select {
      width: 100%;
      height: 44px;
      border: 1px solid #2e3644;
      background: #1b212b;
      border-radius: 12px;
      color: #edf2fa;
      padding: 0 12px;
      font: inherit;
    }
    .order-input:focus, .order-select:focus {
      outline: none;
      border-color: #5078dd;
      box-shadow: 0 0 0 1px #5078dd inset;
    }
    .order-input.is-invalid {
      border-color: #b94a57;
      box-shadow: 0 0 0 1px #b94a57 inset;
    }
    .order-qty {
      display: grid;
      grid-template-columns: 44px 1fr 44px;
      gap: var(--order-space-8);
      align-items: center;
      min-width: 160px;
    }
    .order-qty-btn, .order-qty-value {
      height: 44px;
      border: 1px solid #2e3644;
      background: #1b212b;
      border-radius: 12px;
      color: #eef2f7;
      display: grid;
      place-items: center;
      font-size: 20px;
      font-weight: 700;
    }
    .order-qty-btn { cursor: pointer; }
    .order-qty-value { font-size: 16px; font-variant-numeric: tabular-nums; }
    .order-inline-error {
      margin-top: 8px;
      color: #ff8c98;
      font-size: 12px;
      min-height: 16px;
    }
    .order-pay-divider {
      display: none;
    }
    .order-financial-card {
      display: grid;
      gap: 12px;
      background: transparent;
      border: 0;
      border-radius: 16px;
      padding: 0;
    }
    .order-form-actions {
      margin-top: 6px;
      display: flex;
      justify-content: flex-end;
    }
    .order-cta-add {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      height: 44px;
      padding: 0 14px;
      border-radius: 11px;
      border: 1px solid #323b4b;
      background: #1b222e;
      color: #d8e1f0;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.01em;
      box-shadow: 0 8px 18px rgba(7, 10, 18, 0.24);
      cursor: pointer;
      transition: transform 160ms ease, border-color 160ms ease, box-shadow 160ms ease, color 160ms ease;
    }
    .order-cta-add-icon {
      width: 18px;
      height: 18px;
      border-radius: 999px;
      border: 1px solid #4a5870;
      display: inline-grid;
      place-items: center;
      color: #eef3ff;
      font-size: 13px;
      line-height: 1;
      font-weight: 700;
      transform: translateY(-0.5px);
    }
    .order-cta-add:hover:not(:disabled) {
      transform: translateY(-1px);
      border-color: #627794;
      color: #ecf2ff;
      box-shadow: 0 12px 22px rgba(7, 10, 18, 0.3);
    }
    .order-cta-add:active:not(:disabled) {
      transform: translateY(0);
      box-shadow: 0 7px 14px rgba(7, 10, 18, 0.22);
    }
    .order-cta-add:disabled {
      opacity: 0.46;
      box-shadow: none;
      border-color: #2e3747;
      color: #95a3b8;
      cursor: not-allowed;
      transform: none;
    }
    .order-cta-primary, .order-cta-secondary {
      border-radius: 12px;
      height: 46px;
      font-weight: 700;
      font-size: 14px;
      cursor: pointer;
    }
    .order-cta-primary {
      border: 1px solid #3968e8;
      background: #2d5ee1;
      color: #fff;
      transition: transform 170ms ease, box-shadow 170ms ease, background 170ms ease, border-color 170ms ease;
    }
    .order-cta-primary:hover:not(:disabled) {
      transform: translateY(-1px);
      box-shadow: 0 10px 22px rgba(45, 94, 225, 0.34);
    }
    .order-cta-primary:disabled {
      opacity: 0.45;
      cursor: not-allowed;
      box-shadow: none;
    }
    .order-cta-secondary {
      border: 1px solid #2d3543;
      background: #171e29;
      color: #dde6f6;
    }
    .order-actions-row {
      margin-top: var(--order-space-16);
      display: flex;
      gap: var(--order-space-8);
      justify-content: flex-end;
      flex-wrap: wrap;
    }
    .order-lines {
      margin-top: var(--order-space-12);
      display: grid;
      gap: var(--order-space-8);
    }
    .order-line-row {
      border: 1px solid #27303d;
      border-radius: 12px;
      background: #1a2029;
      padding: 10px 12px;
      display: grid;
      gap: 6px;
    }
    .order-line-row.compact {
      grid-template-columns: 1fr auto auto;
      align-items: center;
      gap: 10px;
    }
    .order-line-meta {
      font-size: 12px;
      color: #9ea9bb;
    }
    .order-line-subtotal {
      font-size: 13px;
      color: #dbe5f8;
      font-weight: 700;
      white-space: nowrap;
    }
    .order-line-remove {
      border: 1px solid #323b4b;
      background: #1b222e;
      color: #d4def0;
      border-radius: 9px;
      padding: 6px 10px;
      font-size: 12px;
      cursor: pointer;
    }
    .order-cart-row {
      border: 1px solid #27303d;
      border-radius: 12px;
      background: #1a2029;
      padding: 10px 12px;
      display: grid;
      grid-template-columns: 1fr auto;
      align-items: center;
      gap: 10px;
    }
    .order-cart-row-right {
      display: grid;
      justify-items: end;
      gap: 8px;
    }
    .order-side-card {
      position: sticky;
      top: 12px;
      border: 1px solid #242c38;
      border-radius: 16px;
      background: #151b24;
      padding: var(--order-space-16);
      display: grid;
      gap: var(--order-space-12);
    }
    #orderStep2Summary {
      border-color: #242c38;
      background: #151b24;
      box-shadow: 0 16px 30px rgba(0, 0, 0, 0.42);
      gap: 14px;
      padding: 18px;
    }
    #orderStep2Summary .order-panel-title {
      margin-bottom: 0;
      font-size: 18px;
      letter-spacing: 0.01em;
      color: #f3f7ff;
    }
    .order-pos-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .order-step-back-outside {
      margin-bottom: 10px;
    }
    .order-pos-back-arrow {
      appearance: none;
      border: 1px solid #2b3340;
      background: #171d27;
      color: #eaf0fb;
      width: 34px;
      height: 34px;
      border-radius: 10px;
      font-size: 20px;
      line-height: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      padding: 0;
    }
    .order-pos-back-arrow:hover {
      background: #1d2430;
    }
    .order-pos-unpaid-toggle {
      appearance: none;
      border: 0;
      background: transparent;
      color: #1d9bff;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      padding: 2px 0;
      line-height: 1.2;
    }
    .order-pos-unpaid-toggle.is-active {
      color: #93cfff;
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    #orderStep2Summary .order-form-label {
      color: #adbbd1;
      font-size: 11px;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }
    #orderStep2Summary .order-select,
    #orderStep2Summary .order-input {
      height: 42px;
      border-color: #2c3441;
      background: #1b212b;
      color: #f3f7ff;
    }
    .order-payment-select-hidden {
      display: none;
    }
    .order-pos-head {
      border-top: 1px solid #222a36;
      border-bottom: 1px solid #222a36;
      padding: 14px 0 12px;
      display: grid;
      gap: 4px;
    }
    .order-pos-amount {
      font-size: clamp(22px, 2.3vw, 30px);
      font-weight: 820;
      line-height: 1;
      color: #f2f6fd;
      letter-spacing: 0.01em;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .order-pos-subtitle {
      color: #96a2b7;
      font-size: 13px;
      font-weight: 600;
    }
    .order-pos-method-list {
      display: grid;
      margin-top: 2px;
      border-top: 1px solid #1f2733;
    }
    .order-pos-method {
      appearance: none;
      border: 0;
      background: transparent;
      color: #eff4fc;
      position: relative;
      display: grid;
      grid-template-columns: 34px 1fr auto;
      align-items: center;
      gap: 10px;
      text-align: left;
      width: 100%;
      min-height: 56px;
      padding: 0 2px;
      border-bottom: 1px solid #1f2733;
      cursor: pointer;
      transition: background-color 160ms ease, color 160ms ease;
    }
    .order-pos-method::before {
      content: "";
      position: absolute;
      left: 0;
      top: 10px;
      bottom: 10px;
      width: 3px;
      border-radius: 999px;
      background: transparent;
      transition: background-color 180ms ease;
    }
    .order-pos-method:hover {
      background: transparent;
    }
    .order-pos-method.is-active {
      background: transparent;
      color: #ffffff;
    }
    .order-pos-method.is-active::before {
      background: linear-gradient(180deg, #d6dce8 0%, #8d97ab 100%);
      box-shadow: 0 0 8px rgba(192, 201, 218, 0.45);
    }
    .order-pos-method-icon {
      width: 26px;
      height: 26px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: #e8eef9;
    }
    .order-pos-method-icon svg {
      width: 22px;
      height: 22px;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.9;
      stroke-linecap: round;
      stroke-linejoin: round;
      display: block;
      transition: transform 170ms ease, color 170ms ease, filter 170ms ease;
    }
    .order-pos-method.is-active .order-pos-method-icon {
      color: #dce3ef;
    }
    .order-pos-method.is-active .order-pos-method-icon svg {
      transform: scale(1.04);
      filter: drop-shadow(0 0 7px rgba(185, 196, 214, 0.36));
      animation: orderPosSelectFresh 220ms ease;
    }
    .order-pos-method-label {
      font-size: 16px;
      font-weight: 680;
      letter-spacing: -0.01em;
      color: #e7edf8;
      transition: color 160ms ease;
    }
    .order-pos-method.is-active .order-pos-method-label {
      color: #f5f9ff;
    }
    .order-pos-method-chevron {
      font-size: 28px;
      line-height: 1;
      color: #c3cedf;
      margin-top: -2px;
      padding-right: 4px;
      transition: color 160ms ease, transform 160ms ease;
    }
    .order-pos-method.is-active .order-pos-method-chevron {
      color: #c7d0df;
      transform: translateX(1px);
    }
    @keyframes orderPosSelectFresh {
      0% { transform: scale(0.98); filter: drop-shadow(0 0 0 rgba(185, 196, 214, 0)); }
      100% { transform: scale(1.04); filter: drop-shadow(0 0 7px rgba(185, 196, 214, 0.36)); }
    }
    #orderStep2Summary #orderPaymentSummary {
      display: grid;
      gap: 8px;
    }
    #orderStep2Summary .order-financial-card #orderPaymentSummary {
      gap: 9px;
    }
    #orderStep2Summary .order-summary-line {
      font-size: 12px;
      color: #b9c7dc;
    }
    #orderStep2Summary .order-summary-line strong {
      color: #e7effd;
      font-size: 13px;
      font-weight: 700;
    }
    #orderStep2Summary .order-summary-total {
      margin-top: 4px;
      padding-top: 12px;
      border-top-color: #334156;
    }
    .order-summary-line {
      display: flex;
      align-items: center;
      justify-content: space-between;
      color: #c7d1e3;
      font-size: 13px;
      font-weight: 600;
    }
    .order-summary-total {
      margin-top: 6px;
      padding-top: 10px;
      border-top: 1px solid #2d3748;
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
      color: #f5f8ff;
      font-weight: 700;
    }
    .order-summary-total strong {
      font-size: 22px;
      line-height: 1;
      font-variant-numeric: tabular-nums;
      letter-spacing: 0.01em;
      white-space: nowrap;
    }
    .order-created-actions {
      display: none;
      margin-top: 6px;
    }
    .order-final-recap {
      margin-top: 2px;
      margin-bottom: 2px;
      font-size: 12px;
      color: #a5b3c8;
      letter-spacing: 0.01em;
      line-height: 1.35;
    }
    .order-split-remaining-row {
      margin-top: 2px;
      color: #9fb0ca;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.01em;
      padding: 0;
      border: 0;
      background: transparent;
    }
    .order-financial-badge {
      margin-top: 0;
      margin-bottom: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 999px;
      padding: 0 12px;
      min-height: 26px;
      border: 1px solid rgba(255, 255, 255, 0.24);
      background: rgba(23, 33, 52, 0.9);
      color: #f8fafc;
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 0.03em;
      text-transform: uppercase;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 8px 18px rgba(4, 10, 22, 0.28);
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.28);
      justify-self: start;
    }
    .order-financial-badge.paid {
      background: linear-gradient(180deg, rgba(44, 181, 120, 0.92), rgba(26, 133, 86, 0.9));
      border-color: rgba(111, 242, 182, 0.68);
      color: #ecfff6;
    }
    .order-financial-badge.partial {
      background: linear-gradient(180deg, rgba(249, 174, 60, 0.94), rgba(203, 126, 24, 0.9));
      border-color: rgba(255, 211, 130, 0.7);
      color: #fff8ea;
    }
    .order-financial-badge.pending {
      background: linear-gradient(180deg, rgba(235, 90, 92, 0.94), rgba(180, 47, 59, 0.9));
      border-color: rgba(255, 154, 160, 0.72);
      color: #fff1f1;
    }
    .order-balance-action {
      display: none;
      margin-top: 2px;
    }
    #orderStep2Summary .order-actions-row {
      margin-top: 6px !important;
      gap: 10px;
      padding-top: 2px;
    }
    #orderStep2Summary .order-actions-row .order-cta-primary {
      width: 100%;
      min-width: 100%;
      height: 64px;
      border-radius: 18px;
      font-size: 18px;
      font-weight: 760;
      letter-spacing: 0.01em;
      box-shadow: 0 12px 24px rgba(37, 77, 221, 0.35);
    }
    .order-success-state {
      min-height: 520px;
      display: none;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 32px 22px;
    }
    .order-success-card {
      width: min(560px, 100%);
      border: 1px solid #324058;
      border-radius: 18px;
      background: linear-gradient(180deg, #182334, #141d2c);
      box-shadow: 0 18px 38px rgba(12, 16, 26, 0.48);
      padding: 24px;
      display: grid;
      gap: 14px;
    }
    .order-success-title {
      margin: 0;
      font-size: 24px;
      color: #f5f8ff;
      font-weight: 800;
    }
    .order-success-sub {
      color: #a7b5ca;
      font-size: 14px;
      font-weight: 600;
      margin-top: -8px;
    }
    .order-success-recap {
      display: grid;
      gap: 8px;
      text-align: left;
      border: 1px solid #2f3c53;
      border-radius: 12px;
      padding: 12px;
      background: #111a28;
    }
    .order-success-row {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      font-size: 13px;
      color: #c5d1e3;
    }
    .order-success-row strong {
      color: #f1f6ff;
      font-weight: 700;
    }
    .order-checkmark {
      margin: 0 auto 4px;
      width: 72px;
      height: 72px;
      display: block;
    }
    .order-checkmark-circle {
      stroke: #2e6d53;
      stroke-width: 3;
      fill: none;
      stroke-dasharray: 188;
      stroke-dashoffset: 188;
      animation: orderCheckStroke 400ms ease forwards;
    }
    .order-checkmark-path {
      stroke: #6de3a8;
      stroke-width: 4;
      fill: none;
      stroke-linecap: round;
      stroke-linejoin: round;
      stroke-dasharray: 64;
      stroke-dashoffset: 64;
      animation: orderCheckStroke 400ms 120ms ease forwards;
    }
    @keyframes orderCheckStroke {
      to { stroke-dashoffset: 0; }
    }
    .order-editor-modal.shake {
      animation: orderShake 320ms ease;
    }
    @keyframes orderShake {
      20% { transform: translateX(-2px); }
      40% { transform: translateX(2px); }
      60% { transform: translateX(-1px); }
      80% { transform: translateX(1px); }
      100% { transform: translateX(0); }
    }
    .order-split-wrap {
      display: grid;
      gap: var(--order-space-8);
      border: 1px solid #27303d;
      background: #1a2029;
      border-radius: 12px;
      padding: 10px;
    }
    .order-mobile-bar {
      display: none;
    }
    .order-spinner {
      width: 14px;
      height: 14px;
      border: 2px solid rgba(255,255,255,0.35);
      border-top-color: #fff;
      border-radius: 999px;
      animation: orderSpin .8s linear infinite;
      display: none;
    }
    .order-cta-primary.loading .order-spinner {
      display: inline-block;
      margin-right: 8px;
      vertical-align: -2px;
    }
    @keyframes orderSpin {
      to { transform: rotate(360deg); }
    }
    @media (max-width: 860px) {
      .order-wizard-grid {
        grid-template-columns: 1fr;
      }
      .order-side-card {
        position: static;
      }
      .order-step2-right {
        position: static;
        gap: 8px;
      }
      .order-step2-right > #orderFinancialBadge {
        position: static;
      }
      .order-mobile-bar {
        position: sticky;
        bottom: 0;
        margin-top: var(--order-space-12);
        display: grid;
        grid-template-columns: 1fr auto;
        gap: var(--order-space-12);
        align-items: center;
        border: 1px solid #27303d;
        background: rgba(15, 20, 28, 0.96);
        border-radius: 14px;
        padding: 10px 12px;
        backdrop-filter: blur(10px);
      }
      .order-mobile-total-label {
        font-size: 11px;
        color: #9ea9bb;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        margin-bottom: 2px;
      }
      .order-mobile-total-value {
        font-size: 20px;
        color: #f6f9ff;
        font-weight: 800;
        line-height: 1;
      }
      .order-pos-amount {
        font-size: clamp(20px, 6.2vw, 26px);
      }
      .order-pos-method-label {
        font-size: 15px;
      }
      .order-mobile-cta {
        min-width: 178px;
      }
      .order-actions-row {
        padding-bottom: 4px;
      }
    }
    .toggle-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 8px;
      font-size: 13px;
      color: #4b443d;
    }
    .toggle-row input[type="checkbox"] { width: 16px; height: 16px; accent-color: #111111; }
    .reschedule-helper {
      margin-top: 6px;
      color: #877e73;
      font-size: 12px;
    }

    .toast-stack {
      position: fixed;
      top: 18px;
      right: 18px;
      display: grid;
      gap: 8px;
      z-index: 1200;
      pointer-events: none;
      max-width: min(380px, calc(100vw - 24px));
    }
    .toast {
      background: #1b2332;
      color: #f6f8fd;
      border-radius: 12px;
      border: 1px solid #334056;
      padding: 11px 13px;
      min-width: 240px;
      box-shadow: 0 14px 28px rgba(12, 16, 24, 0.36);
      opacity: 0;
      transform: translateY(-4px);
      transition: opacity 180ms ease, transform 180ms ease;
      font-size: 12px;
      font-weight: 700;
    }
    .toast.show { opacity: 1; transform: translateY(0); }
    .toast.error { background: #3d1b24; border-color: #7f2d3d; }
    .toast.success { background: #16362b; border-color: #2f6b52; }
    .toast.neutral { background: #1b2332; border-color: #334056; }

    /* // V3 ELITE UI */
    .rv2 {
      --bg: linear-gradient(180deg, #f7f9fc 0%, #eef2f7 100%);
      --card: #ffffff;
      --border: rgba(15, 23, 42, 0.06);
      --text: #0f172a;
      --muted: #6b778c;
      --shadow: 0 1px 2px rgba(0,0,0,0.04), 0 8px 24px rgba(15,23,42,0.06);
      --radius: 14px;
      --focus: 0 0 0 3px rgba(37, 99, 235, 0.14);
    }
    body.rv2 {
      background: var(--bg);
      color: var(--text);
    }
    .rv2 .shell {
      max-width: 1640px;
      margin: 32px auto;
      padding: 0 22px 34px;
    }
    .rv2 .header {
      margin-bottom: 32px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--border);
    }
    .rv2 .title {
      font-size: clamp(42px, 5vw, 58px);
      font-weight: 820;
      letter-spacing: -0.035em;
    }
    .rv2 .subtitle {
      font-size: 13px;
      color: var(--muted);
      margin-top: 12px;
      opacity: 0.88;
    }
    .rv2 .shop-tag {
      margin-top: 14px;
      background: #f8fafd;
      border: 1px solid var(--border);
      color: #4f5f7a;
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      padding: 7px 12px;
      border-radius: 999px;
    }
    .rv2 .actions-top .btn {
      padding: 10px 14px;
      border-radius: 12px;
      font-weight: 700;
      transition: transform 180ms ease, background-color 180ms ease, border-color 180ms ease, box-shadow 180ms ease, color 180ms ease;
    }
    .rv2 #openModalBtn {
      padding: 11px 17px;
      font-weight: 800;
      border-radius: 13px;
      box-shadow: 0 12px 26px rgba(20, 28, 40, 0.24);
      background: linear-gradient(135deg, #0f172a, #1f2937);
      border-color: #0f172a;
    }
    .rv2 #openModalBtn:hover {
      transform: translateY(-1px);
      background: linear-gradient(135deg, #12203a, #27364d);
      box-shadow: 0 14px 28px rgba(20, 28, 40, 0.28);
    }

    .rv2 .kpi-layout { margin-bottom: 26px; gap: 18px; }
    /* // COUTURE TECH COMMAND BAR */
    .rv2 .kpi-spacer { min-height: 1px; }
    .rv2 .kpi-grid { gap: 16px; }
    .rv2 .kpi-card {
      position: relative;
      border-radius: var(--radius);
      padding: 20px;
      min-height: 122px;
      background: var(--card);
      border: 1px solid var(--border);
      box-shadow: var(--shadow);
      transition: transform 180ms ease, box-shadow 180ms ease, border-color 180ms ease;
    }
    .rv2 .kpi-card:hover {
      transform: translateY(-2px);
      box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 12px 28px rgba(15,23,42,0.09);
    }
    .rv2 .kpi-top {
      font-size: 11px;
      color: #7b879a;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      opacity: 0.8;
    }
    .rv2 .kpi-num {
      margin-top: 22px;
      font-size: 44px;
      font-weight: 840;
      letter-spacing: -0.03em;
    }
    .rv2 .kpi-top .kpi-icon {
      width: 28px;
      height: 28px;
      border-radius: 10px;
      border: 1px solid #e7ecf4;
      background: #f9fbfe;
      color: #8a97ac;
      display: inline-grid;
      place-items: center;
      font-size: 13px;
      line-height: 1;
    }
    .rv2 .kpi-card.accent-success { border-left: 4px solid #89c8a5; }
    .rv2 .kpi-card.accent-amber { border-left: 4px solid #d8b273; }
    .rv2 .kpi-card.accent-blue { border-left: 4px solid #7ea5f1; }

    .rv2 .split { gap: 18px; }
    .rv2 .card {
      border-radius: var(--radius);
      border: 1px solid var(--border);
      background: var(--card);
      box-shadow: var(--shadow);
    }

    .rv2 .table-wrap { overflow: hidden; }
    .rv2 .table-toolbar, .rv2 .table-head { padding-left: 18px; padding-right: 18px; }
    .rv2 .table-scroll thead th {
      position: sticky;
      top: 0;
      z-index: 2;
      background: #f8fafc;
      border-bottom: 1px solid #e8edf5;
    }
    .rv2 th, .rv2 td {
      padding: 18px 18px;
      border-bottom-color: #eef2f8;
    }
    .rv2 th {
      color: #7b8798;
      font-size: 10px;
      letter-spacing: 0.1em;
    }
    .rv2 tr[data-row-id] {
      transition: background-color 180ms ease, box-shadow 180ms ease;
    }
    .rv2 tr[data-row-id]:hover { background: #f8fafc; }
    .rv2 tr[data-selected="true"] {
      background: #eef2ff;
      box-shadow: inset 4px 0 0 #7ea5f1;
      animation: rv2RowFocus 180ms ease;
    }
    @keyframes rv2RowFocus {
      from { background-color: #f8fafc; }
      to { background-color: #eef2ff; }
    }
    .rv2 .status-pill {
      border-radius: 999px;
      padding: 6px 12px;
      font-size: 11px;
      border-width: 1px;
      transition: background-color 180ms ease, border-color 180ms ease, color 180ms ease;
    }
    .rv2 .menu-btn {
      border-radius: 10px;
      transition: background-color 180ms ease, border-color 180ms ease, box-shadow 180ms ease;
    }
    .rv2 .menu-btn:hover {
      background: #f7faff;
      border-color: #d9e4f5;
      box-shadow: 0 4px 10px rgba(20, 31, 49, 0.08);
    }

    .rv2 .right-stack { gap: 10px; margin-top: -220px; }
    .rv2 .command-bar-card {
      padding: 10px 12px 12px;
    }
    .rv2 .command-bar-top {
      display: block;
      padding-bottom: 8px;
    }
    .rv2 .command-bar-text {
      min-width: 0;
      display: block;
    }
    .rv2 .command-bar-client {
      font-size: 18px;
      font-weight: 700;
      color: inherit;
    }
    .rv2 .command-bar-meta {
      font-size: 14px;
      color: inherit;
      white-space: normal;
      overflow: visible;
      text-overflow: unset;
    }
    .rv2 .notes-card {
      padding: 14px 16px;
      background: #f9fbfe;
    }
    .rv2 .context-notes-foot .btn {
      border-radius: 10px;
      padding: 7px 11px;
    }
    .rv2 #ctxNotesSaveBtn {
      background: #0f1726;
      border-color: #0f1726;
      color: #fff;
      box-shadow: 0 8px 16px rgba(15, 23, 38, 0.16);
    }

    .rv2 .context {
      padding: 16px 18px 18px;
      background: #ffffff;
      border: 1px solid var(--border);
    }
    .rv2 .context-section {
      margin-top: 16px;
      padding-top: 13px;
      border-top: 1px solid #edf1f7;
    }
    .rv2 #contextContent .context-section:first-of-type {
      border-top: 0;
      margin-top: 10px;
      padding-top: 0;
    }
    .rv2 .context-k {
      font-size: 10px;
      letter-spacing: 0.13em;
      color: #8592a7;
      text-transform: uppercase;
    }
    .rv2 .timeline {
      max-height: 300px;
      overflow: auto;
      padding-right: 2px;
    }
    .rv2 .context-empty, .rv2 .bubble {
      border-radius: 12px;
      border-color: #e8edf5;
      background: #fbfcfe;
    }
    .rv2 .context-select,
    .rv2 .context-notes-input,
    .rv2 .field input,
    .rv2 .field select,
    .rv2 .field textarea {
      background: #f8fbff;
      border-color: #e2e9f3;
      padding: 10px 12px;
      border-radius: 11px;
      transition: border-color 180ms ease, box-shadow 180ms ease, background 180ms ease;
    }
    .rv2 .context-select:focus,
    .rv2 .context-notes-input:focus,
    .rv2 .field input:focus,
    .rv2 .field select:focus,
    .rv2 .field textarea:focus {
      outline: none;
      border-color: #95b8ef;
      box-shadow: var(--focus);
      background: #ffffff;
    }
    .rv2 #ctxOrderLinkWrap .act.order-link-btn {
      background: #f7f9fc;
      border-color: #dde4ef;
      color: #324662;
      text-align: center;
    }
    .rv2 #ctxOrderLinkWrap .act.order-link-btn:hover {
      background: #eef3fb;
      box-shadow: 0 8px 14px rgba(20, 31, 49, 0.08);
    }
    .rv2 .context-actions .act.primary {
      background: #0f1726;
      border-color: #0f1726;
      color: #fff;
      box-shadow: 0 14px 24px rgba(15, 23, 38, 0.2);
    }
    .rv2 .context-actions { gap: 11px; margin-top: 18px; }

    @media (max-width: 1080px) {
      .rv2 .kpi-spacer {
        display: block !important;
      }
      .rv2 .right-stack {
        margin-top: 0 !important;
      }
    }
    .rv2 .act, .rv2 .btn, .rv2 .nav {
      border-radius: 13px;
      transition: transform 180ms ease, background-color 180ms ease, border-color 180ms ease, box-shadow 180ms ease, color 180ms ease;
    }

    @media (max-width: 1260px) {
      .kpi-layout { grid-template-columns: 1fr 340px; }
      .split { grid-template-columns: 1fr 340px; }
    }
    @media (max-width: 1080px) {
      .kpi-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .kpi-layout { grid-template-columns: 1fr; }
      .kpi-spacer { display: none; }
      .split { grid-template-columns: 1fr; }
      .right-stack { margin-top: 0; }
      .context {
        margin-top: 0;
        position: fixed;
        top: 0;
        right: 0;
        width: min(100vw, 520px);
        height: 100dvh;
        z-index: 30;
        border-radius: 0;
        border-left: 1px solid var(--line);
        border-top: 0;
        border-bottom: 0;
        transform: translateX(100%);
        transition: transform 220ms ease;
        overflow: auto;
        background: #fffdf8;
      }
      .context.open { transform: translateX(0); }
      .drawer-close { display: inline-block; }
    }
    @media (max-width: 740px) {
      .header { flex-direction: column; }
      .actions-top { width: 100%; }
      .actions-top .btn { flex: 1; }
      .form-grid { grid-template-columns: 1fr; }
      .kpi-num { font-size: 28px; }
      .shell { padding: 0 10px 18px; }
      .table-toolbar { padding: 8px 10px; }
      .toolbar-left, .toolbar-right { width: 100%; }
    }
  </style>
</head>
<body class="${isV2 ? "rv2" : ""}">
  <div class="shell">
    <div class="layout">
    <div>
    <section class="header">
      <div>
        <h1 class="title">Rendez-vous${isV2 ? " V2" : ""}</h1>
        <div class="subtitle">Gestion des rendez-vous et confirmations WhatsApp</div>
        <div class="shop-tag"><span>Shop</span><strong id="shopLabel">${defaultShop || "-"}</strong></div>
      </div>
      <div class="actions-top">
        <button id="darkModeToggleBtn" class="btn btn-ghost" type="button">Activer mode sombre</button>
        <button id="fullscreenBtn" class="btn btn-ghost" type="button">Plein écran</button>
        <button id="refreshBtn" class="btn btn-ghost" type="button">Actualiser</button>
        <button
          id="openModalBtn"
          class="btn btn-primary"
          type="button"
          onclick="if(window.__openAppointmentsModal){window.__openAppointmentsModal();} return false;"
        >+ Nouveau rendez-vous</button>
      </div>
    </section>

    <section class="kpi-layout">
      <div>
        <section class="kpi-grid" id="kpiGrid">
          <article class="kpi-card"><div class="kpi-top"><span>RDV aujourd'hui</span><span class="kpi-icon">◴</span></div><div id="kpiToday" class="kpi-num">0</div></article>
          <article class="kpi-card"><div class="kpi-top"><span>RDV cette semaine</span><span class="kpi-icon">◷</span></div><div id="kpiWeek" class="kpi-num">0</div></article>
          <article class="kpi-card"><div class="kpi-top"><span>Confirmés</span><span class="kpi-icon">✓</span></div><div id="kpiConfirmed" class="kpi-num">0</div></article>
          <article id="kpiCardConfirmation" class="kpi-card"><div class="kpi-top"><span>Taux confirmation</span><span class="kpi-icon">%</span></div><div id="kpiConfirmationRate" class="kpi-num">0%</div></article>
          <article id="kpiCardNoShow" class="kpi-card kpi-card-split">
            <div class="kpi-split-col">
              <div class="kpi-top"><span>Absence</span><span class="kpi-icon">•</span></div>
              <div id="kpiAbsence" class="kpi-num">0</div>
            </div>
            <div class="kpi-split-col">
              <div class="kpi-top"><span>KPI no-show</span><span class="kpi-icon">%</span></div>
              <div id="kpiNoShowRate" class="kpi-num">0%</div>
            </div>
          </article>
          <article id="kpiCardConversion" class="kpi-card"><div class="kpi-top"><span>Conversion RDV → Commande</span><span class="kpi-icon">%</span></div><div id="kpiConversionRate" class="kpi-num">0%</div></article>
        </section>
      </div>
      <div class="kpi-spacer" aria-hidden="true"></div>
    </section>

    <section id="appointmentsListWrap" class="split">
      <article class="card table-wrap">
        <div class="table-toolbar">
          <div class="toolbar-left">
            <div id="viewToggle" style="display:inline-flex; border:1px solid var(--line); border-radius:999px; overflow:hidden; background:#fff;">
              <button id="viewListBtn" class="btn btn-ghost" type="button" style="border:0; border-radius:0;">Liste</button>
              <button id="viewCalendarBtn" class="btn btn-ghost" type="button" style="border:0; border-radius:0;">Calendrier</button>
            </div>
            <select id="typeFilterSelect" style="border:1px solid var(--line); border-radius:999px; background:#fff;">
              <option value="all">Tous types</option>
              <option value="fitting">Essayage</option>
              <option value="measurements">Prises de mesures</option>
              <option value="pickup">Retrait</option>
              <option value="alteration">Retouche</option>
              <option value="vip_consultation">Consultation VIP</option>
            </select>
          </div>
          <div class="toolbar-right">
            <button id="calendarPrevWeekBtn" class="btn btn-ghost" type="button">← Semaine -1</button>
            <button id="calendarNextWeekBtn" class="btn btn-ghost" type="button">Semaine +1 →</button>
          </div>
        </div>
        <div class="table-head">
          <div>
            <div class="table-title">Liste des rendez-vous</div>
            <div id="tableSub" class="table-sub">0 enregistrements</div>
          </div>
          <div style="display:flex; gap:8px; align-items:center;">
            <input id="shopInput" type="text" value="${defaultShop}" placeholder="store.myshopify.com" style="border:1px solid var(--line); border-radius:999px; padding:8px 11px; min-width:260px;" />
            <button id="syncMetaBtn" class="btn btn-ghost" type="button">Sync metafield</button>
          </div>
        </div>
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Client</th>
                <th>Téléphone</th>
                <th>Type</th>
                <th>Statut</th>
                <th>Lieu</th>
                <th>Dernier message</th>
                <th style="text-align:right;">Actions</th>
              </tr>
            </thead>
            <tbody id="appointmentsBody"></tbody>
          </table>
        </div>
      </article>

      <div class="right-stack">
        <aside id="quickActionsPanel" class="card command-bar-card">
          <div class="command-bar-top">
            <div class="command-bar-text">
              <div id="commandBarClient" class="command-bar-client">Aucun rendez-vous sélectionné</div>
              <div id="commandBarMeta" class="command-bar-meta">Sélectionnez un rendez-vous pour afficher le résumé rapide.</div>
            </div>
            <span id="commandBarStatus" class="status-pill status-scheduled">-</span>
          </div>
          <div class="quick-actions-row">
            <button id="ctxTopActionReminder" class="act" type="button">Envoyer rappel</button>
            <button id="ctxTopActionReschedule" class="act" type="button">Replanifier</button>
            <button id="ctxTopActionComplete" class="act" type="button">Marquer comme terminé</button>
          </div>
        </aside>
        <aside id="notesPanel" class="card notes-card">
          <div class="context-k">Notes client</div>
          <div id="notesPanelEmpty" class="context-empty" style="margin-top:0;">Sélectionnez un rendez-vous pour éditer les notes.</div>
          <div id="notesPanelContent" style="display:none;">
            <textarea id="ctxNotesInput" class="context-notes-input" maxlength="500" placeholder="Ajouter des notes client/rendez-vous..."></textarea>
            <div class="context-notes-foot">
              <span id="ctxNotesCount" class="count" style="margin-top:0;">0 / 500</span>
              <button id="ctxNotesSaveBtn" class="btn btn-ghost" type="button" style="padding:6px 10px; font-size:12px;">Enregistrer</button>
            </div>
          </div>
        </aside>

        <aside id="contextPanel" class="card context">
          <button id="closeDrawerBtn" class="drawer-close" type="button">Fermer</button>
          <div id="contextEmpty" class="context-empty">Sélectionnez un rendez-vous pour afficher les détails client, la timeline WhatsApp et les actions rapides.</div>
          <div id="contextContent" style="display:none;">
            <div class="client-name" id="ctxName">-</div>
            <a id="ctxPhone" class="client-phone" href="#">-</a>

            <div class="context-section">
              <div class="context-k">Statut</div>
              <select id="ctxStatus" class="context-select">
                <option value="scheduled">Demandé</option>
                <option value="confirmed">Confirmé</option>
                <option value="reminder_sent">Rappel envoyé</option>
                <option value="rescheduled">Replanifié</option>
                <option value="cancelled">Annulé</option>
                <option value="completed">Terminé</option>
                <option value="no_show">No-show</option>
              </select>
            </div>
            <div class="context-section">
              <div class="context-k">Type</div>
              <select id="ctxType" class="context-select">
                <option value="fitting">Essayage</option>
                <option value="measurements">Prises de mesures</option>
                <option value="pickup">Retrait</option>
                <option value="alteration">Retouche</option>
                <option value="vip_consultation">Consultation VIP</option>
              </select>
            </div>
            <div class="context-section">
              <div class="context-k">Durée et fin</div>
              <div id="ctxDurationMeta" class="bubble"></div>
            </div>
            <div class="context-section">
              <div class="context-k">Rappels automatiques</div>
              <label class="toggle-row"><input id="ctxReminderD1" type="checkbox" /> <span>Rappel J-1</span></label>
              <label class="toggle-row"><input id="ctxReminderH3" type="checkbox" /> <span>Rappel H-3</span></label>
              <div class="toggle-row" style="justify-content:space-between; gap:10px;">
                <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
                  <input id="ctxReminderDesigner" type="checkbox" />
                  <span>Rappel designer 08:30 (jour J)</span>
                </label>
                <button id="ctxReminderDesignerSendBtn" class="btn btn-ghost" type="button" style="padding:6px 10px; font-size:12px;">Relancer</button>
              </div>
            </div>
            <div class="context-section">
              <div class="context-k">Commande liée</div>
              <div id="ctxOrderLinkWrap" class="bubble"></div>
            </div>

            <div class="context-section">
              <div class="context-k">Timeline messages</div>
              <div id="ctxTimeline" class="timeline"></div>
            </div>

            <div class="context-actions">
              <button id="ctxActionConfirm" class="act primary" data-ctx-action="confirm" type="button">Envoyer confirmation</button>
              <button id="ctxActionReopen" class="act is-hidden" data-ctx-action="reopen" type="button">Relancer</button>
            </div>
          </div>
        </aside>
      </div>
    </section>
    <section id="appointmentsCalendarWrap" class="card" style="display:none; padding:12px 12px 8px; margin-top:12px;">
      <div id="calendarWeekLabel" style="font-weight:700; margin-bottom:10px;">Semaine</div>
      <div id="calendarGrid" style="overflow:auto;"></div>
    </section>
    </div>
    </div>
  </div>

  <div id="createModal" class="modal-overlay" aria-hidden="true">
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
      <div class="modal-head">
        <div id="modalTitle" class="modal-title">Nouveau rendez-vous</div>
        <button id="closeModalBtn" class="btn btn-ghost" type="button">Fermer</button>
      </div>
      <div class="modal-body">
        <div class="divider">Informations client</div>
        <div class="form-grid">
          <div class="field" style="position:relative;">
            <label>Nom client</label>
            <input id="customerNameInput" type="text" placeholder="Nom complet" />
            <div id="customerSuggestBox" style="position:absolute; left:0; right:0; top:calc(100% + 4px); z-index:55; border:1px solid #ddd2c5; border-radius:12px; background:#fff; box-shadow:0 18px 30px rgba(19,19,22,.16); display:none; max-height:220px; overflow:auto;"></div>
          </div>
          <div class="field">
            <label>Téléphone</label>
            <input id="phoneInput" type="text" placeholder="+212..." />
          </div>
          <div class="field">
            <label>Email</label>
            <input id="emailInput" type="email" placeholder="client@email.com" />
          </div>
          <div class="field">
            <label>Statut</label>
            <select id="statusInput">
              <option value="scheduled">Demandé</option>
              <option value="confirmed">Confirmé</option>
              <option value="reminder_sent">Rappel envoyé</option>
              <option value="rescheduled">Replanifié</option>
              <option value="cancelled">Annulé</option>
              <option value="completed">Terminé</option>
              <option value="no_show">No-show</option>
            </select>
          </div>
          <div class="field">
            <label>Type de rendez-vous</label>
            <select id="typeInput">
              <option value="fitting">Essayage</option>
              <option value="measurements">Prises de mesures</option>
              <option value="pickup">Retrait</option>
              <option value="alteration">Retouche</option>
              <option value="vip_consultation">Consultation VIP</option>
            </select>
          </div>
          <div class="field">
            <label>Durée (minutes)</label>
            <input id="durationInput" type="number" min="15" max="360" step="15" value="60" />
          </div>
          <div class="field" style="grid-column:1 / -1;">
            <label class="toggle-row" style="margin-top:0;">
              <input id="createNotesToggle" type="checkbox" />
              <span>Ajouter des notes pour ce rendez-vous</span>
            </label>
          </div>
          <div id="notesFieldWrap" class="field" style="grid-column:1 / -1; display:none;">
            <label>Notes</label>
            <textarea id="notesInput" maxlength="500" placeholder="Informations utiles pour le rendez-vous"></textarea>
            <div id="notesCount" class="count">0 / 500</div>
          </div>
        </div>

        <div class="divider" style="margin-top:14px;">Détails rendez-vous</div>
        <div class="form-grid">
          <div class="field">
            <label>Date et heure</label>
            <input id="atInput" type="datetime-local" />
            <div class="quick-datetime" id="quickDateTimeWrap">
              <button type="button" data-quick-date="0">Aujourd'hui</button>
              <button type="button" data-quick-date="1">Demain</button>
              <button type="button" data-quick-date="7">+7 jours</button>
              <button type="button" data-quick-time="10:00">10:00</button>
              <button type="button" data-quick-time="14:00">14:00</button>
              <button type="button" data-quick-time="18:00">18:00</button>
            </div>
            <div id="createConflictError" class="count" style="text-align:left; color:#af2f2f; display:none;"></div>
          </div>
          <div class="field">
            <label>Fin prévue</label>
            <input id="endAtInput" type="datetime-local" />
          </div>
          <div class="field">
            <label>Point de vente</label>
            <select id="locationSelect"><option value="">Chargement...</option></select>
          </div>
          <div class="field" style="grid-column:1 / -1;">
            <label style="margin-bottom:8px;">Automatisation rappels</label>
            <label class="toggle-row"><input id="createReminderD1Input" type="checkbox" checked /> <span>Rappel client J-1</span></label>
            <label class="toggle-row"><input id="createReminderH3Input" type="checkbox" checked /> <span>Rappel client H-3</span></label>
            <label class="toggle-row"><input id="createReminderDesignerInput" type="checkbox" checked /> <span>Rappel designer 08:30 (jour J)</span></label>
          </div>
        </div>
      </div>
      <div class="modal-foot">
        <button id="createOnlyBtn" class="btn btn-ghost" type="button">Créer sans envoyer</button>
        <button id="createAndSendBtn" class="btn btn-primary" type="button">Créer et envoyer confirmation</button>
      </div>
    </div>
  </div>

  <div id="rescheduleModal" class="modal-overlay" aria-hidden="true">
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="rescheduleModalTitle">
      <div class="modal-head">
        <div>
          <div id="rescheduleModalTitle" class="modal-title">Replanifier le rendez-vous</div>
          <div class="reschedule-helper">Modifier la date et l’heure du rendez-vous</div>
        </div>
        <button id="closeRescheduleModalBtn" class="btn btn-ghost" type="button">Annuler</button>
      </div>
      <div class="modal-body">
        <div class="divider">Nouveau créneau</div>
        <div class="form-grid">
          <div class="field">
            <label>Nouvelle date</label>
            <input id="rescheduleDateInput" type="date" />
          </div>
          <div class="field">
            <label>Nouvelle heure</label>
            <input id="rescheduleTimeInput" type="time" />
            <div id="rescheduleConflictError" class="count" style="text-align:left; color:#af2f2f; display:none;"></div>
          </div>
          <div class="field" style="grid-column:1 / -1;">
            <label>Lieu</label>
            <select id="rescheduleLocationSelect"><option value="">Choisir un point de vente</option></select>
          </div>
        </div>

        <div class="divider" style="margin-top:14px;">Communication</div>
        <label class="toggle-row">
          <input id="rescheduleSendToggle" type="checkbox" checked />
          <span>Envoyer message de replanification WhatsApp</span>
        </label>
        <label class="toggle-row">
          <input id="rescheduleCustomToggle" type="checkbox" />
          <span>Modifier le message avant envoi (optionnel)</span>
        </label>
        <div id="rescheduleCustomWrap" class="field" style="margin-top:8px; display:none;">
          <textarea id="rescheduleCustomMessageInput" maxlength="500" placeholder="Message personnalisé (optionnel)"></textarea>
          <div class="count" id="rescheduleCustomCount">0 / 500</div>
        </div>
      </div>
      <div class="modal-foot">
        <button id="rescheduleOnlyBtn" class="btn btn-ghost" type="button">Mettre à jour sans envoyer</button>
        <button id="rescheduleUpdateSendBtn" class="btn btn-primary" type="button">Mettre à jour et envoyer</button>
      </div>
    </div>
  </div>

  <div id="createOrderModal" class="modal-overlay" aria-hidden="true">
    <div class="modal order-editor-modal" role="dialog" aria-modal="true" aria-labelledby="createOrderModalTitle">
      <div class="modal-body">
        <div class="order-wizard-head">
          <button id="closeCreateOrderModalBtn" class="order-editor-close" type="button" aria-label="Fermer">×</button>
          <div id="createOrderModalTitle" class="modal-title">Créer commande</div>
          <div class="order-step-meta">
            <div id="orderWizardStepLabel" class="order-step-label">Étape 1/1</div>
            <div class="order-step-progress"><span id="orderWizardProgressFill"></span></div>
          </div>
        </div>
        <div id="orderStepEditor" class="order-wizard-step">
          <div class="order-wizard-grid">
            <section class="order-panel">
              <h3 class="order-panel-title">Étape 1 · Articles</h3>
              <div class="order-form-grid">
                <div class="order-form-field full">
                  <label class="order-form-label" for="orderCustomTitleInput">Titre</label>
                  <input id="orderCustomTitleInput" class="order-input" type="text" placeholder="Titre de l’article" />
                </div>
                <div class="order-form-field">
                  <label id="orderCustomPriceLabel" class="order-form-label" for="orderCustomPriceInput">Prix</label>
                  <input id="orderCustomPriceInput" class="order-input" type="text" inputmode="decimal" value="0,00" />
                </div>
                <div class="order-form-field">
                  <label class="order-form-label">Quantité</label>
                  <div class="order-qty">
                    <button id="orderQtyMinusBtn" class="order-qty-btn" type="button">−</button>
                    <div id="orderQtyValue" class="order-qty-value">1</div>
                    <button id="orderQtyPlusBtn" class="order-qty-btn" type="button">+</button>
                  </div>
                  <input id="orderCustomQtyInput" type="hidden" value="1" />
                </div>
              </div>
              <div class="order-form-actions">
                <button id="addCustomOrderLineBtn" class="order-cta-add" type="button">
                  <span class="order-cta-add-icon" aria-hidden="true">+</span>
                  <span>Ajouter l’article</span>
                </button>
              </div>
              <div id="orderEditorValidation" class="order-inline-error"></div>
              <h4 class="order-panel-subtitle">Articles ajoutés</h4>
              <div id="orderLinesWrap" class="order-lines"></div>
              <div class="order-actions-row">
                <button id="orderCancelWizardBtn" class="order-cta-secondary" type="button">Annuler</button>
                <button id="orderContinueToPaymentBtn" class="order-cta-primary" type="button">Confirmer commande</button>
              </div>
            </section>
            <aside id="orderStep1Summary" class="order-side-card"></aside>
          </div>
        </div>
        <div id="orderStepCart" class="order-wizard-step is-hidden">
          <div class="order-step-back-outside">
            <button id="orderBackTopBtn" type="button" class="order-pos-back-arrow" aria-label="Retour">←</button>
          </div>
          <div class="order-wizard-grid">
            <section class="order-panel">
              <h3 class="order-panel-title">Étape 2 · Paiement & Confirmation</h3>
              <div id="orderClientContext" class="order-client-context"></div>
              <h4 class="order-panel-subtitle" style="margin-top:0;">Panier</h4>
              <div id="orderCartItems" class="order-lines"></div>
            </section>
            <div class="order-step2-right">
              <div id="orderFinancialBadge" class="order-financial-badge pending">Non payé</div>
              <aside id="orderStep2Summary" class="order-side-card">
              <div class="order-pos-top">
                <h3 class="order-panel-title" style="margin-bottom:0;">Paiement</h3>
                <button id="orderMarkUnpaidBtn" type="button" class="order-pos-unpaid-toggle">Marquer comme non payé</button>
              </div>
              <div class="order-pos-head">
                <div id="orderPosAmount" class="order-pos-amount">0,00 MAD</div>
                <div class="order-pos-subtitle">Sélectionner une option de paiement</div>
              </div>
              <div id="orderPosMethodList" class="order-pos-method-list"></div>
              <div class="order-form-field order-payment-select-hidden">
                <label class="order-form-label" for="orderPaymentMethodSelect">Mode de paiement</label>
                <select id="orderPaymentMethodSelect" class="order-select"></select>
              </div>
              <div id="orderSplitPaymentWrap" class="order-split-wrap" style="display:none;">
                <label id="orderSplitFirstAmountLabel" class="order-form-label" for="orderSplitFirstAmountInput">Paiement 1</label>
                <input id="orderSplitFirstAmountInput" class="order-input" type="text" inputmode="decimal" placeholder="Paiement 1" />
                <label class="order-form-label" for="orderSplitFirstMethodSelect">Mode paiement 1</label>
                <select id="orderSplitFirstMethodSelect" class="order-select"></select>
                <div id="orderInstallmentError" class="order-inline-error" style="margin-top:2px;"></div>
                <label class="order-form-label" for="orderSplitRemainingAmountInput">Solde restant</label>
                <input id="orderSplitRemainingAmountInput" class="order-input" type="text" readonly value="0,00" />
              </div>
              <div class="order-pay-divider"></div>
              <div class="order-financial-card">
                <div class="order-pay-divider"></div>
                <div class="order-actions-row" style="margin-top:0;">
                  <button id="orderConfirmOrderBtn" class="order-cta-primary" type="button">
                    <span class="order-spinner" aria-hidden="true"></span><span>Paiement 0 MAD</span>
                  </button>
                </div>
              </div>
              </aside>
            </div>
          </div>
        </div>
        <div id="createOrderError" class="count" style="text-align:left; color:#af2f2f; margin-top:8px; display:none;"></div>
        <div id="orderMobileSummaryBar" class="order-mobile-bar">
          <div>
            <div class="order-mobile-total-label">Total</div>
            <div id="orderMobileTotalValue" class="order-mobile-total-value">0,00</div>
          </div>
          <button id="orderMobilePrimaryBtn" class="order-cta-primary order-mobile-cta" type="button">Confirmer commande</button>
        </div>
        <div id="orderSuccessState" class="order-success-state"></div>
      </div>
    </div>
  </div>

  <div id="toastStack" class="toast-stack"></div>

  <script>
    try {
      const appBridgeKey = document.querySelector('meta[name="shopify-api-key"]');
      const hostParam = new URLSearchParams(window.location.search).get("host") || undefined;
      if (
        window.shopify &&
        appBridgeKey &&
        appBridgeKey.content &&
        typeof window.shopify.createApp === "function"
      ) {
        window.shopify.createApp({
          apiKey: appBridgeKey.content,
          host: hostParam
        });
      }
    } catch (error) {
      console.warn("[appointments] App Bridge init skipped:", error);
    }

    const appointmentsBodyEl = document.getElementById("appointmentsBody");
    const tableSubEl = document.getElementById("tableSub");
    const shopInputEl = document.getElementById("shopInput");
    const shopLabelEl = document.getElementById("shopLabel");
    const syncMetaBtnEl = document.getElementById("syncMetaBtn");
    const darkModeToggleBtnEl = document.getElementById("darkModeToggleBtn");
    const fullscreenBtnEl = document.getElementById("fullscreenBtn");
    const refreshBtnEl = document.getElementById("refreshBtn");
    const openModalBtnEl = document.getElementById("openModalBtn");
    const closeModalBtnEl = document.getElementById("closeModalBtn");
    const modalEl = document.getElementById("createModal");
    const createOnlyBtnEl = document.getElementById("createOnlyBtn");
    const createAndSendBtnEl = document.getElementById("createAndSendBtn");
    const rescheduleModalEl = document.getElementById("rescheduleModal");
    const closeRescheduleModalBtnEl = document.getElementById("closeRescheduleModalBtn");
    const rescheduleDateInputEl = document.getElementById("rescheduleDateInput");
    const rescheduleTimeInputEl = document.getElementById("rescheduleTimeInput");
    const rescheduleLocationSelectEl = document.getElementById("rescheduleLocationSelect");
    const rescheduleSendToggleEl = document.getElementById("rescheduleSendToggle");
    const rescheduleCustomToggleEl = document.getElementById("rescheduleCustomToggle");
    const rescheduleCustomWrapEl = document.getElementById("rescheduleCustomWrap");
    const rescheduleCustomMessageInputEl = document.getElementById("rescheduleCustomMessageInput");
    const rescheduleCustomCountEl = document.getElementById("rescheduleCustomCount");
    const rescheduleOnlyBtnEl = document.getElementById("rescheduleOnlyBtn");
    const rescheduleUpdateSendBtnEl = document.getElementById("rescheduleUpdateSendBtn");
    const createOrderModalEl = document.getElementById("createOrderModal");
    const orderWizardHeadEl = createOrderModalEl ? createOrderModalEl.querySelector(".order-wizard-head") : null;
    const closeCreateOrderModalBtnEl = document.getElementById("closeCreateOrderModalBtn");
    const orderProductSearchInputEl = document.getElementById("orderProductSearchInput");
    const orderProductSuggestBoxEl = document.getElementById("orderProductSuggestBox");
    const orderWizardStepLabelEl = document.getElementById("orderWizardStepLabel");
    const orderWizardProgressFillEl = document.getElementById("orderWizardProgressFill");
    const orderContinueToPaymentBtnEl = document.getElementById("orderContinueToPaymentBtn");
    const orderCancelWizardBtnEl = document.getElementById("orderCancelWizardBtn");
    const orderConfirmOrderBtnEl = document.getElementById("orderConfirmOrderBtn");
    const orderMobilePrimaryBtnEl = document.getElementById("orderMobilePrimaryBtn");
    const orderMobileSummaryBarEl = document.getElementById("orderMobileSummaryBar");
    const orderMobileTotalValueEl = document.getElementById("orderMobileTotalValue");
    const orderEditorValidationEl = document.getElementById("orderEditorValidation");
    const orderClientContextEl = document.getElementById("orderClientContext");
    const orderFinalRecapEl = document.getElementById("orderFinalRecap");
    const orderSuccessStateEl = document.getElementById("orderSuccessState");
    const orderCustomTitleInputEl = document.getElementById("orderCustomTitleInput");
    const orderCustomQtyInputEl = document.getElementById("orderCustomQtyInput");
    const orderCustomPriceInputEl = document.getElementById("orderCustomPriceInput");
    const orderQtyMinusBtnEl = document.getElementById("orderQtyMinusBtn");
    const orderQtyPlusBtnEl = document.getElementById("orderQtyPlusBtn");
    const orderQtyValueEl = document.getElementById("orderQtyValue");
    const addCustomOrderLineBtnEl = document.getElementById("addCustomOrderLineBtn");
    const orderLinesWrapEl = document.getElementById("orderLinesWrap");
    const orderStepEditorEl = document.getElementById("orderStepEditor");
    const orderStepCartEl = document.getElementById("orderStepCart");
    const orderBackTopBtnEl = document.getElementById("orderBackTopBtn");
    const orderBackToEditorBtnEl = document.getElementById("orderBackToEditorBtn");
    const orderCartItemsEl = document.getElementById("orderCartItems");
    const orderPaymentMethodSelectEl = document.getElementById("orderPaymentMethodSelect");
    const orderMarkUnpaidBtnEl = document.getElementById("orderMarkUnpaidBtn");
    const orderPosAmountEl = document.getElementById("orderPosAmount");
    const orderPosMethodListEl = document.getElementById("orderPosMethodList");
    const orderSplitPaymentWrapEl = document.getElementById("orderSplitPaymentWrap");
    const orderSplitFirstAmountInputEl = document.getElementById("orderSplitFirstAmountInput");
    const orderSplitFirstMethodSelectEl = document.getElementById("orderSplitFirstMethodSelect");
    const orderSplitSecondMethodSelectEl = document.getElementById("orderSplitSecondMethodSelect");
    const orderSplitRemainingAmountInputEl = document.getElementById("orderSplitRemainingAmountInput");
    const orderSplitDueDateInputEl = document.getElementById("orderSplitDueDateInput");
    const orderSplitRemainderLabelEl = document.getElementById("orderSplitRemainderLabel");
    const orderInstallmentErrorEl = document.getElementById("orderInstallmentError");
    const orderPaymentSummaryEl = document.getElementById("orderPaymentSummary");
    const orderFinancialBadgeEl = document.getElementById("orderFinancialBadge");
    const orderBalanceActionWrapEl = document.getElementById("orderBalanceActionWrap");
    const orderCollectBalanceBtnEl = document.getElementById("orderCollectBalanceBtn");
    const createOrderErrorEl = document.getElementById("createOrderError");
    const orderConfirmOrderBtnTextEl = orderConfirmOrderBtnEl ? orderConfirmOrderBtnEl.querySelector("span:last-child") : null;

    const customerNameInputEl = document.getElementById("customerNameInput");
    const customerSuggestBoxEl = document.getElementById("customerSuggestBox");
    const phoneInputEl = document.getElementById("phoneInput");
    const emailInputEl = document.getElementById("emailInput");
    const statusInputEl = document.getElementById("statusInput");
    const typeInputEl = document.getElementById("typeInput");
    const durationInputEl = document.getElementById("durationInput");
    const atInputEl = document.getElementById("atInput");
    const quickDateTimeWrapEl = document.getElementById("quickDateTimeWrap");
    const endAtInputEl = document.getElementById("endAtInput");
    const createConflictErrorEl = document.getElementById("createConflictError");
    const locationSelectEl = document.getElementById("locationSelect");
    const createNotesToggleEl = document.getElementById("createNotesToggle");
    const notesFieldWrapEl = document.getElementById("notesFieldWrap");
    const notesInputEl = document.getElementById("notesInput");
    const notesCountEl = document.getElementById("notesCount");
    const createReminderD1InputEl = document.getElementById("createReminderD1Input");
    const createReminderH3InputEl = document.getElementById("createReminderH3Input");
    const createReminderDesignerInputEl = document.getElementById("createReminderDesignerInput");
    const rescheduleConflictErrorEl = document.getElementById("rescheduleConflictError");

    const kpiTodayEl = document.getElementById("kpiToday");
    const kpiWeekEl = document.getElementById("kpiWeek");
    const kpiConfirmedEl = document.getElementById("kpiConfirmed");
    const kpiAbsenceEl = document.getElementById("kpiAbsence");
    const kpiConfirmationRateEl = document.getElementById("kpiConfirmationRate");
    const kpiNoShowRateEl = document.getElementById("kpiNoShowRate");
    const kpiConversionRateEl = document.getElementById("kpiConversionRate");

    const contextPanelEl = document.getElementById("contextPanel");
    const closeDrawerBtnEl = document.getElementById("closeDrawerBtn");
    const contextEmptyEl = document.getElementById("contextEmpty");
    const contextContentEl = document.getElementById("contextContent");
    const notesPanelEmptyEl = document.getElementById("notesPanelEmpty");
    const notesPanelContentEl = document.getElementById("notesPanelContent");
    const ctxNameEl = document.getElementById("ctxName");
    const ctxPhoneEl = document.getElementById("ctxPhone");
    const ctxStatusEl = document.getElementById("ctxStatus");
    const ctxTypeEl = document.getElementById("ctxType");
    const ctxDurationMetaEl = document.getElementById("ctxDurationMeta");
    const ctxNotesInputEl = document.getElementById("ctxNotesInput");
    const ctxNotesCountEl = document.getElementById("ctxNotesCount");
    const ctxNotesSaveBtnEl = document.getElementById("ctxNotesSaveBtn");
    const ctxReminderD1El = document.getElementById("ctxReminderD1");
    const ctxReminderH3El = document.getElementById("ctxReminderH3");
    const ctxReminderDesignerEl = document.getElementById("ctxReminderDesigner");
    const ctxReminderDesignerSendBtnEl = document.getElementById("ctxReminderDesignerSendBtn");
    const commandBarClientEl = document.getElementById("commandBarClient");
    const commandBarMetaEl = document.getElementById("commandBarMeta");
    const commandBarStatusEl = document.getElementById("commandBarStatus");
    const ctxOrderLinkWrapEl = document.getElementById("ctxOrderLinkWrap");
    const ctxTimelineEl = document.getElementById("ctxTimeline");
    const toastStackEl = document.getElementById("toastStack");
    const ctxActionConfirmEl = document.getElementById("ctxActionConfirm");
    const ctxActionReminderEl = document.getElementById("ctxActionReminder");
    const ctxActionRescheduleEl = document.getElementById("ctxActionReschedule");
    const ctxActionCompleteEl = document.getElementById("ctxActionComplete");
    const ctxActionReopenEl = document.getElementById("ctxActionReopen");
    const ctxTopActionReminderEl = document.getElementById("ctxTopActionReminder");
    const ctxTopActionRescheduleEl = document.getElementById("ctxTopActionReschedule");
    const ctxTopActionCompleteEl = document.getElementById("ctxTopActionComplete");
    const typeFilterSelectEl = document.getElementById("typeFilterSelect");
    const viewListBtnEl = document.getElementById("viewListBtn");
    const viewCalendarBtnEl = document.getElementById("viewCalendarBtn");
    const appointmentsListWrapEl = document.getElementById("appointmentsListWrap");
    const appointmentsCalendarWrapEl = document.getElementById("appointmentsCalendarWrap");
    const calendarGridEl = document.getElementById("calendarGrid");
    const calendarWeekLabelEl = document.getElementById("calendarWeekLabel");
    const calendarPrevWeekBtnEl = document.getElementById("calendarPrevWeekBtn");
    const calendarNextWeekBtnEl = document.getElementById("calendarNextWeekBtn");

    let appointments = [];
    let locations = [];
    let selectedId = "";
    let rescheduleTargetId = "";
    let createOrderTargetId = "";
    let orderWizardStep = 1;
    const orderSingleStepFlow = true;
    let timelineByAppointment = {};
    let orderProductSuggestions = [];
    let orderProductSuggestDebounceId = null;
    let orderLines = [];
    let orderForceUnpaid = false;
    let shopifyPaymentMethods = [];
    let orderOutcomeByAppointment = {};
    let hasAttemptedAddItem = false;
    let customerSuggestions = [];
    let suggestDebounceId = null;
    let activeView = "list";
    let pseudoFullscreenActive = false;
    const defaultCreateLocationLabel = "Showroom Triangle d'or";
    let calendarWeekStart = (function () {
      const now = new Date();
      const mondayOffset = (now.getDay() + 6) % 7;
      const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - mondayOffset);
      monday.setHours(0, 0, 0, 0);
      return monday;
    })();

    function shopValue() {
      return String(shopInputEl && shopInputEl.value ? shopInputEl.value : "").trim();
    }

    function escapeHtml(value) {
      return String(value == null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function showToast(typeOrMessage, maybeMessage) {
      if (!toastStackEl) return;
      const known = { success: true, error: true, neutral: true };
      let type = "neutral";
      let message = "";
      if (maybeMessage === undefined) {
        message = String(typeOrMessage || "");
      } else if (known[String(typeOrMessage || "")]) {
        type = String(typeOrMessage || "neutral");
        message = String(maybeMessage || "");
      } else {
        message = String(typeOrMessage || "");
        type = known[String(maybeMessage || "")] ? String(maybeMessage || "neutral") : "neutral";
      }
      const toast = document.createElement("div");
      toast.className = "toast " + type;
      toast.textContent = message;
      toastStackEl.appendChild(toast);
      requestAnimationFrame(() => toast.classList.add("show"));
      setTimeout(() => {
        toast.classList.remove("show");
        setTimeout(() => toast.remove(), 180);
      }, 4000);
    }

    function defaultPaymentMethods() {
      return [
        { code: "cash", label: "Espèces" },
        { code: "cheque", label: "Chèque" },
        { code: "bank_transfer", label: "Virement bancaire" },
        { code: "card", label: "Carte bancaire" },
        { code: "installment", label: "Paiement divisé" }
      ];
    }

    function paymentMethodLabel(code) {
      const key = String(code || "").trim();
      if (!key) return "Espèces";
      const match = (Array.isArray(shopifyPaymentMethods) ? shopifyPaymentMethods : []).find((item) => String(item.code || "") === key);
      if (match && match.label) return String(match.label);
      const fallback = defaultPaymentMethods().find((item) => item.code === key);
      return fallback ? fallback.label : key;
    }

    function defaultSinglePaymentCode() {
      const methods = Array.isArray(shopifyPaymentMethods) && shopifyPaymentMethods.length ? shopifyPaymentMethods : defaultPaymentMethods();
      const single = methods.find((item) => item.code !== "installment");
      return String(single ? single.code : "cash");
    }

    function paymentMethodIconSvg(code) {
      const key = String(code || "");
      if (key === "cash") {
        return "<svg viewBox='0 0 24 24' aria-hidden='true'><rect x='3.5' y='6.5' width='17' height='11' rx='2.2'></rect><circle cx='12' cy='12' r='2'></circle></svg>";
      }
      if (key === "cheque") {
        return "<svg viewBox='0 0 24 24' aria-hidden='true'><rect x='3.5' y='6.5' width='17' height='11' rx='2.2'></rect><line x1='7' y1='10' x2='13' y2='10'></line><line x1='7' y1='13' x2='11' y2='13'></line></svg>";
      }
      if (key === "bank_transfer") {
        return "<svg viewBox='0 0 24 24' aria-hidden='true'><path d='M5 8h11'></path><path d='M13 5l3 3-3 3'></path><path d='M19 16H8'></path><path d='M11 13l-3 3 3 3'></path></svg>";
      }
      if (key === "card") {
        return "<svg viewBox='0 0 24 24' aria-hidden='true'><rect x='3.5' y='6.5' width='17' height='11' rx='2.2'></rect><line x1='3.5' y1='10' x2='20.5' y2='10'></line></svg>";
      }
      return "<svg viewBox='0 0 24 24' aria-hidden='true'><path d='M8 5v4a2 2 0 0 1-2 2H2'></path><path d='M16 19v-4a2 2 0 0 1 2-2h4'></path><path d='M16 5l4 4-4 4'></path><path d='M8 19l-4-4 4-4'></path></svg>";
    }

    function ensurePaymentMethodSelection() {
      const methods = Array.isArray(shopifyPaymentMethods) && shopifyPaymentMethods.length ? shopifyPaymentMethods : defaultPaymentMethods();
      if (orderPaymentMethodSelectEl) {
        const current = String(orderPaymentMethodSelectEl.value || "").trim();
        if (!methods.some((item) => item.code === current)) {
          orderPaymentMethodSelectEl.value = defaultSinglePaymentCode();
        }
      }
      if (orderSplitFirstMethodSelectEl) {
        const singleMethods = methods.filter((item) => item.code !== "installment");
        const current = String(orderSplitFirstMethodSelectEl.value || "").trim();
        if (!singleMethods.some((item) => item.code === current)) {
          orderSplitFirstMethodSelectEl.value = singleMethods.length ? String(singleMethods[0].code) : "cash";
        }
      }
    }

    function renderPaymentMethodsUi() {
      const methods = Array.isArray(shopifyPaymentMethods) && shopifyPaymentMethods.length ? shopifyPaymentMethods : defaultPaymentMethods();
      if (orderPaymentMethodSelectEl) {
        orderPaymentMethodSelectEl.innerHTML = methods.map((item) =>
          "<option value='" + escapeHtml(String(item.code || "")) + "'>" + escapeHtml(String(item.label || item.code || "")) + "</option>"
        ).join("");
      }
      if (orderSplitFirstMethodSelectEl) {
        const singleMethods = methods.filter((item) => item.code !== "installment");
        orderSplitFirstMethodSelectEl.innerHTML = singleMethods.map((item) =>
          "<option value='" + escapeHtml(String(item.code || "")) + "'>" + escapeHtml(String(item.label || item.code || "")) + "</option>"
        ).join("");
      }
      if (orderPosMethodListEl) {
        orderPosMethodListEl.innerHTML = methods.map((item) => {
          const code = String(item.code || "");
          const label = String(item.label || code);
          return "<button type='button' class='order-pos-method' data-order-payment-method='" + escapeHtml(code) + "'>" +
            "<span class='order-pos-method-icon'>" + paymentMethodIconSvg(code) + "</span>" +
            "<span class='order-pos-method-label'>" + escapeHtml(label) + "</span>" +
            "<span class='order-pos-method-chevron'>›</span>" +
          "</button>";
        }).join("");
      }
      ensurePaymentMethodSelection();
      syncOrderPaymentMethodVisual();
    }

    function isDarkModeActive() {
      return document.documentElement.classList.contains("night-dark");
    }

    function syncDarkModeButtonLabel() {
      if (!darkModeToggleBtnEl) return;
      darkModeToggleBtnEl.textContent = isDarkModeActive() ? "Désactiver mode sombre" : "Activer mode sombre";
    }

    function toggleDarkMode() {
      const nextDark = !isDarkModeActive();
      document.documentElement.classList.toggle("night-dark", nextDark);
      try {
        localStorage.setItem("appointmentsThemeMode", nextDark ? "dark" : "light");
      } catch (_e) {}
      syncDarkModeButtonLabel();
    }

    function isFullscreenActive() {
      return !!(
        document.fullscreenElement ||
        document.webkitFullscreenElement ||
        document.mozFullScreenElement ||
        document.msFullscreenElement
      );
    }

    function setPseudoFullscreen(active) {
      pseudoFullscreenActive = !!active;
      if (pseudoFullscreenActive) {
        document.body.classList.add("pseudo-fullscreen");
      } else {
        document.body.classList.remove("pseudo-fullscreen");
      }
    }

    function syncFullscreenButtonLabel() {
      if (!fullscreenBtnEl) return;
      fullscreenBtnEl.textContent = (isFullscreenActive() || pseudoFullscreenActive) ? "Quitter plein écran" : "Plein écran";
    }

    async function toggleFullscreenMode() {
      if (pseudoFullscreenActive) {
        setPseudoFullscreen(false);
        syncFullscreenButtonLabel();
        return;
      }
      try {
        if (isFullscreenActive()) {
          if (document.exitFullscreen) await document.exitFullscreen();
          else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
          else if (document.msExitFullscreen) document.msExitFullscreen();
          return;
        }
        if (document.documentElement && document.documentElement.requestFullscreen) {
          await document.documentElement.requestFullscreen();
          return;
        }
        if (document.documentElement && document.documentElement.webkitRequestFullscreen) {
          document.documentElement.webkitRequestFullscreen();
          return;
        }
        if (document.documentElement && document.documentElement.msRequestFullscreen) {
          document.documentElement.msRequestFullscreen();
          return;
        }
        setPseudoFullscreen(true);
        showToast("Mode étendu activé (fullscreen navigateur bloqué).", "success");
      } catch {
        setPseudoFullscreen(true);
        showToast("Mode étendu activé (fullscreen navigateur bloqué).", "success");
      } finally {
        syncFullscreenButtonLabel();
      }
    }

    async function readJsonSafe(res) {
      const raw = await res.text();
      try {
        return { ok: true, data: JSON.parse(raw) };
      } catch {
        return { ok: false, data: raw };
      }
    }

    function formatDateTime(iso) {
      if (!iso) return "-";
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return "-";
      return d.toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });
    }

    function toDateInputValue(iso) {
      const d = new Date(String(iso || ""));
      if (Number.isNaN(d.getTime())) return "";
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return y + "-" + m + "-" + day;
    }

    function toTimeInputValue(iso) {
      const d = new Date(String(iso || ""));
      if (Number.isNaN(d.getTime())) return "";
      const h = String(d.getHours()).padStart(2, "0");
      const min = String(d.getMinutes()).padStart(2, "0");
      return h + ":" + min;
    }

    function localDateTimeToIso(dateText, timeText) {
      const d = String(dateText || "").trim();
      const t = String(timeText || "").trim();
      if (!d || !t) return "";
      const local = new Date(d + "T" + t + ":00");
      if (Number.isNaN(local.getTime())) return "";
      return local.toISOString();
    }

    function readCreateWindow() {
      const startRaw = String(atInputEl && atInputEl.value ? atInputEl.value : "").trim();
      const startDate = startRaw ? new Date(startRaw) : null;
      const duration = Number(durationInputEl && durationInputEl.value ? durationInputEl.value : defaultDurationByType(typeInputEl && typeInputEl.value));
      const safeDuration = Number.isFinite(duration) ? Math.max(15, Math.min(360, Math.floor(duration))) : 60;
      const endRaw = String(endAtInputEl && endAtInputEl.value ? endAtInputEl.value : "").trim();
      const endDate = endRaw ? new Date(endRaw) : null;
      const computedEnd = startDate && Number.isFinite(startDate.getTime())
        ? new Date(startDate.getTime() + safeDuration * 60 * 1000)
        : null;
      const finalEnd = endDate && Number.isFinite(endDate.getTime()) ? endDate : computedEnd;
      return {
        appointmentAt: startDate && Number.isFinite(startDate.getTime()) ? startDate.toISOString() : "",
        endAt: finalEnd && Number.isFinite(finalEnd.getTime()) ? finalEnd.toISOString() : "",
        durationMinutes: safeDuration
      };
    }

    function statusMeta(statusRaw) {
      const status = String(statusRaw || "scheduled");
      const map = {
        scheduled: { label: "Demandé", className: "status-scheduled" },
        confirmed: { label: "Confirmé", className: "status-confirmed" },
        reminder_sent: { label: "Rappel envoyé", className: "status-reminder_sent" },
        rescheduled: { label: "Replanifié", className: "status-rescheduled" },
        cancelled: { label: "Annulé", className: "status-cancelled" },
        completed: { label: "Terminé", className: "status-completed" },
        no_show: { label: "Absence", className: "status-no_show" }
      };
      return map[status] || map.scheduled;
    }

    function appointmentTypeMeta(typeRaw) {
      const type = String(typeRaw || "fitting");
      const map = {
        fitting: { label: "Essayage", color: "#3e4fc2", bg: "#edf1ff", border: "#cbd6ff" },
        measurements: { label: "Prises de mesures", color: "#1c7a4a", bg: "#e7f5ed", border: "#c6e8d5" },
        pickup: { label: "Retrait", color: "#995602", bg: "#fff2e2", border: "#f2d4a9" },
        alteration: { label: "Retouche", color: "#7a3fb1", bg: "#f3eafd", border: "#dbc5f7" },
        vip_consultation: { label: "Consultation VIP", color: "#1f5c9f", bg: "#eaf2fe", border: "#cadefb" }
      };
      return map[type] || map.fitting;
    }

    function defaultDurationByType(typeRaw) {
      const type = String(typeRaw || "fitting");
      const map = {
        fitting: 60,
        measurements: 45,
        pickup: 30,
        alteration: 30,
        vip_consultation: 90
      };
      return Number(map[type] || 60);
    }

    function toDateTimeLocalValue(iso) {
      const d = new Date(String(iso || ""));
      if (Number.isNaN(d.getTime())) return "";
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      const h = String(d.getHours()).padStart(2, "0");
      const min = String(d.getMinutes()).padStart(2, "0");
      return y + "-" + m + "-" + day + "T" + h + ":" + min;
    }

    function roundedFutureDate(minutesAhead, slotMinutes) {
      const now = new Date();
      const d = new Date(now.getTime() + Math.max(0, Number(minutesAhead || 0)) * 60 * 1000);
      d.setSeconds(0, 0);
      const slot = Math.max(5, Number(slotMinutes || 30));
      const mod = d.getMinutes() % slot;
      if (mod !== 0) d.setMinutes(d.getMinutes() + (slot - mod));
      return d;
    }

    function setCreateDefaultDateTime(force) {
      if (!atInputEl) return;
      const hasStart = String(atInputEl.value || "").trim().length > 0;
      if (hasStart && !force) return;
      const start = roundedFutureDate(60, 30);
      atInputEl.value = toDateTimeLocalValue(start.toISOString());
      atInputEl.min = toDateTimeLocalValue(new Date().toISOString());
      applyEndOneHourAfterStart();
    }

    function applyEndOneHourAfterStart() {
      const startRaw = String(atInputEl && atInputEl.value ? atInputEl.value : "").trim();
      if (!startRaw) return;
      const start = new Date(startRaw);
      if (Number.isNaN(start.getTime())) return;
      const end = new Date(start.getTime() + 60 * 60 * 1000);
      if (durationInputEl) durationInputEl.value = "60";
      if (endAtInputEl) endAtInputEl.value = toDateTimeLocalValue(end.toISOString());
    }

    function applyQuickDate(days) {
      if (!atInputEl) return;
      const currentRaw = String(atInputEl.value || "").trim();
      const current = currentRaw ? new Date(currentRaw) : roundedFutureDate(60, 30);
      const base = new Date();
      base.setHours(current.getHours(), current.getMinutes(), 0, 0);
      base.setDate(base.getDate() + Number(days || 0));
      atInputEl.value = toDateTimeLocalValue(base.toISOString());
      applyEndOneHourAfterStart();
    }

    function applyQuickTime(hhmm) {
      if (!atInputEl) return;
      const value = String(hhmm || "").trim();
      if (!/^\d{2}:\d{2}$/.test(value)) return;
      const [hh, mm] = value.split(":");
      const currentRaw = String(atInputEl.value || "").trim();
      const current = currentRaw ? new Date(currentRaw) : roundedFutureDate(60, 30);
      current.setHours(Number(hh), Number(mm), 0, 0);
      atInputEl.value = toDateTimeLocalValue(current.toISOString());
      applyEndOneHourAfterStart();
    }

    function renderSkeletonRows() {
      if (!appointmentsBodyEl) return;
      let html = "";
      for (let i = 0; i < 8; i += 1) {
        html += "<tr class='skeleton'>" +
          "<td><div class='sk'></div></td>" +
          "<td><div class='sk'></div></td>" +
          "<td><div class='sk'></div></td>" +
          "<td><div class='sk'></div></td>" +
          "<td><div class='sk'></div></td>" +
          "<td><div class='sk'></div></td>" +
          "<td><div class='sk'></div></td>" +
          "<td><div class='sk'></div></td>" +
        "</tr>";
      }
      appointmentsBodyEl.innerHTML = html;
    }

    function updateKpis() {
      const now = new Date();
      const startDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const endDay = startDay + 24 * 60 * 60 * 1000;
      const dayIdx = (now.getDay() + 6) % 7;
      const weekStart = new Date(startDay - dayIdx * 24 * 60 * 60 * 1000).getTime();
      const weekEnd = weekStart + 7 * 24 * 60 * 60 * 1000;

      let today = 0;
      let week = 0;
      let confirmed = 0;
      let noShow = 0;
      let converted = 0;
      const total = Array.isArray(appointments) ? appointments.length : 0;

      appointments.forEach((row) => {
        const ts = new Date(String(row.appointmentAt || "")).getTime();
        if (Number.isFinite(ts)) {
          if (ts >= startDay && ts < endDay) today += 1;
          if (ts >= weekStart && ts < weekEnd) week += 1;
        }
        const status = String(row.status || "");
        if (status === "confirmed") confirmed += 1;
        if (status === "no_show") noShow += 1;
        if (row.orderId) converted += 1;
      });

      if (kpiTodayEl) kpiTodayEl.textContent = String(today);
      if (kpiWeekEl) kpiWeekEl.textContent = String(week);
      if (kpiConfirmedEl) kpiConfirmedEl.textContent = String(confirmed);
      if (kpiAbsenceEl) kpiAbsenceEl.textContent = String(noShow);
      const confirmationRate = total > 0 ? (Math.round((confirmed / total) * 1000) / 10) : 0;
      const noShowRate = total > 0 ? (Math.round((noShow / total) * 1000) / 10) : 0;
      const conversionRate = total > 0 ? (Math.round((converted / total) * 1000) / 10) : 0;
      if (kpiConfirmationRateEl) kpiConfirmationRateEl.textContent = String(confirmationRate) + "%";
      if (kpiNoShowRateEl) kpiNoShowRateEl.textContent = String(noShowRate) + "%";
      if (kpiConversionRateEl) kpiConversionRateEl.textContent = String(conversionRate) + "%";

      const kpiCardConfirmationEl = document.getElementById("kpiCardConfirmation");
      const kpiCardNoShowEl = document.getElementById("kpiCardNoShow");
      const kpiCardConversionEl = document.getElementById("kpiCardConversion");
      if (kpiCardConfirmationEl) {
        kpiCardConfirmationEl.classList.toggle("accent-success", confirmationRate > 80);
      }
      if (kpiCardNoShowEl) {
        kpiCardNoShowEl.classList.toggle("accent-amber", noShow > 0);
      }
      if (kpiCardConversionEl) {
        kpiCardConversionEl.classList.toggle("accent-blue", conversionRate > 50);
      }
    }

    function closeMenus() {
      document.querySelectorAll(".menu").forEach((el) => { el.style.display = "none"; });
    }

    function selectedLocationValue() {
      const selected = String(locationSelectEl && locationSelectEl.value ? locationSelectEl.value : "").trim();
      if (selected === "__whatsapp__") return "Rendez-vous WhatsApp";
      return selected || null;
    }

    function locationSelectOptionsHtml() {
      if (!Array.isArray(locations) || locations.length === 0) {
        return "<option value=''>Aucun point de vente</option><option value='__whatsapp__'>Rendez-vous WhatsApp</option>";
      }
      return "<option value=''>Choisir un point de vente</option>" +
        locations.map((row) => {
          const labelParts = [String(row.name || ""), [String(row.city || ""), String(row.country || "")].filter(Boolean).join(" · ")].filter(Boolean);
          return "<option value='" + escapeHtml(String(row.name || "")) + "'>" + escapeHtml(labelParts.join(" — ")) + "</option>";
        }).join("") +
        "<option value='__whatsapp__'>Rendez-vous WhatsApp</option>";
    }

    function setLocationSelectValue(selectEl, locationLabel) {
      if (!selectEl) return;
      const location = String(locationLabel || "").trim();
      if (!location) {
        selectEl.value = "";
        return;
      }
      if (location.toLowerCase() === "rendez-vous whatsapp") {
        selectEl.value = "__whatsapp__";
        return;
      }
      const values = Array.from(selectEl.options).map((opt) => String(opt.value || ""));
      if (values.includes(location)) {
        selectEl.value = location;
      } else {
        selectEl.value = "__whatsapp__";
      }
    }

    function applyDefaultCreateLocation() {
      if (!locationSelectEl) return;
      const normalize = (value) => String(value || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/['’]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      const target = normalize(defaultCreateLocationLabel);
      const options = Array.from(locationSelectEl.options || []);
      const exact = options.find((opt) => normalize(opt.value) === target);
      if (exact && exact.value) {
        locationSelectEl.value = exact.value;
        return;
      }
      const partial = options.find((opt) => {
        const v = normalize(opt.value);
        return v.includes("triangle dor") || v.includes("triangle d or");
      });
      if (partial && partial.value) {
        locationSelectEl.value = partial.value;
      }
    }

    function selectedRescheduleLocationValue() {
      const selected = String(rescheduleLocationSelectEl && rescheduleLocationSelectEl.value ? rescheduleLocationSelectEl.value : "").trim();
      if (selected === "__whatsapp__") return "Rendez-vous WhatsApp";
      return selected || null;
    }

    function closeRescheduleModal() {
      if (!rescheduleModalEl) return;
      rescheduleModalEl.classList.remove("open");
      rescheduleModalEl.setAttribute("aria-hidden", "true");
      setTimeout(() => { rescheduleModalEl.style.display = "none"; }, 180);
      rescheduleTargetId = "";
      if (rescheduleCustomToggleEl) rescheduleCustomToggleEl.checked = false;
      if (rescheduleCustomWrapEl) rescheduleCustomWrapEl.style.display = "none";
      if (rescheduleCustomMessageInputEl) rescheduleCustomMessageInputEl.value = "";
      if (rescheduleCustomCountEl) rescheduleCustomCountEl.textContent = "0 / 500";
      if (rescheduleSendToggleEl) rescheduleSendToggleEl.checked = true;
    }

    function openRescheduleModalFor(row) {
      if (!row || !rescheduleModalEl) return;
      rescheduleTargetId = String(row.id || "");
      if (!rescheduleTargetId) return;
      if (rescheduleDateInputEl) rescheduleDateInputEl.value = toDateInputValue(row.appointmentAt);
      if (rescheduleTimeInputEl) rescheduleTimeInputEl.value = toTimeInputValue(row.appointmentAt);
      if (rescheduleLocationSelectEl) {
        rescheduleLocationSelectEl.innerHTML = locationSelectOptionsHtml();
        setLocationSelectValue(rescheduleLocationSelectEl, row.location);
      }
      if (rescheduleCustomToggleEl) rescheduleCustomToggleEl.checked = false;
      if (rescheduleCustomWrapEl) rescheduleCustomWrapEl.style.display = "none";
      if (rescheduleCustomMessageInputEl) rescheduleCustomMessageInputEl.value = "";
      if (rescheduleCustomCountEl) rescheduleCustomCountEl.textContent = "0 / 500";
      if (rescheduleSendToggleEl) rescheduleSendToggleEl.checked = true;
      if (rescheduleConflictErrorEl) {
        rescheduleConflictErrorEl.style.display = "none";
        rescheduleConflictErrorEl.textContent = "";
      }
      rescheduleModalEl.style.display = "flex";
      rescheduleModalEl.setAttribute("aria-hidden", "false");
      requestAnimationFrame(() => rescheduleModalEl.classList.add("open"));
    }

    function renderAppointmentsTable() {
      if (!appointmentsBodyEl) return;
      if (!Array.isArray(appointments) || appointments.length === 0) {
        appointmentsBodyEl.innerHTML = "<tr><td colspan='8' style='padding:20px; color:#7d766d;'>Aucun rendez-vous.</td></tr>";
        return;
      }
      appointmentsBodyEl.innerHTML = appointments.map((row) => {
        const id = escapeHtml(row.id || "");
        const meta = statusMeta(row.status);
        const typeMeta = appointmentTypeMeta(row.type);
        const selected = String(row.id || "") === selectedId ? "true" : "false";
        const nowMs = Date.now();
        const startMs = new Date(String(row.appointmentAt || "")).getTime();
        const isToday = Number.isFinite(startMs) && new Date(startMs).toDateString() === new Date(nowMs).toDateString();
        const isSoon = Number.isFinite(startMs) && startMs > nowMs && (startMs - nowMs) < 2 * 60 * 60 * 1000;
        return "<tr data-row-id='" + id + "' data-selected='" + selected + "' style='" +
          (isSoon ? "border-left:3px solid #c9342f;" : isToday ? "border-left:3px solid #8ab4f8;" : "") + "'>" +
          "<td>" + escapeHtml(formatDateTime(row.appointmentAt)) + "</td>" +
          "<td><strong>" + escapeHtml(row.customerName || "-") + "</strong><br/><span style='font-size:12px;color:#7d766d;'>" + escapeHtml(row.customerEmail || "") + "</span></td>" +
          "<td>" + escapeHtml(row.customerPhone || "-") + "</td>" +
          "<td><span class='status-pill' style='background:" + typeMeta.bg + ";border-color:" + typeMeta.border + ";color:" + typeMeta.color + ";'>" + escapeHtml(typeMeta.label) + "</span></td>" +
          "<td><span class='status-pill " + meta.className + "'>" + meta.label + "</span></td>" +
          "<td>" + escapeHtml(row.location || "-") + "</td>" +
          "<td><span class='msg-cell'><span class='wa'>🟢</span><span>" + escapeHtml(formatDateTime(row.lastMessageAt)) + "</span></span></td>" +
          "<td class='menu-cell'>" +
            "<button class='menu-btn' data-menu-btn='" + id + "'>⋯</button>" +
            "<div class='menu' id='menu-" + id + "'>" +
              "<button data-menu-action='view' data-id='" + id + "'>Voir détails</button>" +
              "<button data-menu-action='confirm' data-id='" + id + "'>Envoyer confirmation</button>" +
              "<button data-menu-action='reminder' data-id='" + id + "'>Envoyer rappel</button>" +
              "<button data-menu-action='delete' data-id='" + id + "'>Supprimer</button>" +
            "</div>" +
          "</td>" +
        "</tr>";
      }).join("");
    }

    function selectedAppointment() {
      return appointments.find((row) => String(row.id) === String(selectedId)) || null;
    }

    function runContextAction(action, row) {
      if (!row) return;
      if (action === "reschedule") {
        openRescheduleModalFor(row);
        return;
      }
      if (action === "reminder") {
        const ok = window.confirm("Envoyer le rappel WhatsApp maintenant ?");
        if (!ok) return;
        sendTemplateFor(row.id, "reminder");
        return;
      }
      if (action === "confirm") {
        sendTemplateFor(row.id, "confirm");
        return;
      }
      if (action === "reopen") {
        updateStatus(row.id, "confirmed");
        return;
      }
      if (action === "complete") {
        updateStatus(row.id, "completed");
      }
    }

    function timelineLabelFromMessageType(messageType) {
      const t = String(messageType || "").trim().toLowerCase();
      if (t === "confirm") return "Confirmation WhatsApp";
      if (t === "reminder" || t === "reminder_h3" || t === "reminder_d1") return "Rappel WhatsApp";
      if (t === "designer_reminder_830") return "Rappel designer 08:30";
      if (t === "reschedule") return "Replanification WhatsApp";
      if (t === "cancel") return "Annulation WhatsApp";
      if (t === "order_created") return "Commande créée";
      return "Message WhatsApp";
    }

    function timelineBodyFromMessage(entry, appointmentRow) {
      const messageLabel = timelineLabelFromMessageType(entry && entry.messageType ? entry.messageType : "");
      const toName = appointmentRow && appointmentRow.customerName ? String(appointmentRow.customerName) : "Client";
      const toPhone = appointmentRow && appointmentRow.customerPhone ? String(appointmentRow.customerPhone) : "";
      const who = toPhone ? (toName + " (" + toPhone + ")") : toName;
      const msgType = String(entry && entry.messageType ? entry.messageType : "").trim().toLowerCase();
      if (msgType === "order_created") {
        const payload = entry && entry.payload && typeof entry.payload === "object" ? entry.payload : null;
        const orderName = payload && payload.orderName ? String(payload.orderName) : (payload && payload.orderId ? "#" + String(payload.orderId) : "Commande Shopify");
        const amount = payload && Number.isFinite(Number(payload.totalAmount))
          ? new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(payload.totalAmount)) + " " + String(payload.currency || "MAD")
          : "";
        const paymentLabel = payload && payload.paymentMethodLabel ? String(payload.paymentMethodLabel) : "";
        const splitPayload = payload && payload.paymentBreakdown && typeof payload.paymentBreakdown === "object" ? payload.paymentBreakdown : null;
        const paymentType = payload && payload.payment_type ? String(payload.payment_type) : "";
        const splitDetails = splitPayload && Number.isFinite(Number(splitPayload.firstAmount))
          ? (paymentType === "installment"
            ? " · Paiement 1: " + formatMad(Number(splitPayload.firstAmount || 0)) +
              " (" + String(splitPayload.firstMethod || "-") + ")" +
              " · Reste: " + formatMad(Number(splitPayload.secondAmount || 0)) +
              " (" + String(splitPayload.secondMethod || "-") + ")"
            : " · Split: P1 " + formatMad(Number(splitPayload.firstAmount || 0)) +
              " (" + String(splitPayload.firstMethod || "-") + ")" +
              " + P2 " + formatMad(Number(splitPayload.secondAmount || 0)) +
              " (" + String(splitPayload.secondMethod || "-") + ")")
          : "";
        return "Commande " + orderName + " créée pour " + who +
          (amount ? (" · Montant: " + amount) : "") +
          (paymentLabel ? (" · Paiement: " + paymentLabel) : "") +
          splitDetails;
      }
      if (msgType === "designer_reminder_830") {
        const payload = entry && entry.payload && typeof entry.payload === "object" ? entry.payload : null;
        const recipient = payload && payload.recipient ? String(payload.recipient) : "";
        return "Rappel designer 08:30 envoyé" + (recipient ? (" à " + recipient) : "") + " · Client du jour: " + who;
      }
      const parts = [
        "Message: " + messageLabel,
        "Envoyé à: " + who
      ];
      if (entry && entry.providerStatus) parts.push("Statut: " + String(entry.providerStatus));
      return parts.join(" · ");
    }

    async function loadTimelineForAppointment(appointmentId) {
      const id = String(appointmentId || "").trim();
      if (!id) return;
      const shop = shopValue();
      if (!shop) return;
      try {
        const params = new URLSearchParams({ shop });
        const res = await fetch("/admin/api/appointments/" + encodeURIComponent(id) + "/messages?" + params.toString());
        const parsed = await readJsonSafe(res);
        if (!res.ok || !parsed.ok || !parsed.data || !parsed.data.ok) return;
        timelineByAppointment[id] = Array.isArray(parsed.data.messages) ? parsed.data.messages : [];
        if (String(selectedId) === id) renderContextPanel();
      } catch {
        // keep existing timeline fallback
      }
    }

    function renderContextPanel() {
      const row = selectedAppointment();
      if (!row) {
        if (contextEmptyEl) contextEmptyEl.style.display = "block";
        if (contextContentEl) contextContentEl.style.display = "none";
        if (notesPanelEmptyEl) notesPanelEmptyEl.style.display = "block";
        if (notesPanelContentEl) notesPanelContentEl.style.display = "none";
        if (commandBarClientEl) commandBarClientEl.textContent = "Aucun rendez-vous sélectionné";
        if (commandBarMetaEl) commandBarMetaEl.textContent = "Sélectionnez un rendez-vous pour afficher le résumé rapide.";
        if (commandBarStatusEl) {
          commandBarStatusEl.className = "status-pill status-scheduled";
          commandBarStatusEl.textContent = "-";
        }
        if (ctxTopActionReminderEl) ctxTopActionReminderEl.disabled = true;
        if (ctxTopActionRescheduleEl) ctxTopActionRescheduleEl.disabled = true;
        if (ctxTopActionCompleteEl) ctxTopActionCompleteEl.disabled = true;
        if (contextPanelEl) contextPanelEl.classList.remove("open");
        return;
      }

      if (contextEmptyEl) contextEmptyEl.style.display = "none";
      if (contextContentEl) contextContentEl.style.display = "block";
      if (notesPanelEmptyEl) notesPanelEmptyEl.style.display = "none";
      if (notesPanelContentEl) notesPanelContentEl.style.display = "block";
      if (ctxTopActionReminderEl) ctxTopActionReminderEl.disabled = false;
      if (ctxTopActionRescheduleEl) ctxTopActionRescheduleEl.disabled = false;
      if (ctxTopActionCompleteEl) ctxTopActionCompleteEl.disabled = false;
      if (commandBarClientEl) {
        const cmdName = String(row.customerName || "Client").trim() || "Client";
        const cmdPhone = String(row.customerPhone || "").trim();
        commandBarClientEl.textContent = cmdPhone ? (cmdName + " · " + cmdPhone) : cmdName;
      }
      if (commandBarMetaEl) {
        const nextAt = formatDateTime(row.appointmentAt);
        const lastWa = row.lastMessageAt ? formatDateTime(row.lastMessageAt) : "";
        commandBarMetaEl.textContent = "Prochain RDV: " + String(nextAt || "-") + (lastWa ? " · WA: " + String(lastWa) : "");
      }
      if (commandBarStatusEl) {
        const cmdStatusMeta = statusMeta(row.status);
        commandBarStatusEl.className = "status-pill " + String(cmdStatusMeta.className || "");
        commandBarStatusEl.textContent = String(cmdStatusMeta.label || "-");
      }
      if (ctxNameEl) ctxNameEl.textContent = String(row.customerName || "-");
      if (ctxPhoneEl) {
        const phone = String(row.customerPhone || "");
        ctxPhoneEl.textContent = phone || "-";
        ctxPhoneEl.href = phone ? ("tel:" + phone) : "#";
      }
      if (ctxStatusEl) ctxStatusEl.value = String(row.status || "scheduled");
      if (ctxTypeEl) ctxTypeEl.value = String(row.type || "fitting");
      if (ctxDurationMetaEl) {
        const endText = formatDateTime(row.endAt || "");
        ctxDurationMetaEl.innerHTML = "<div><strong>Durée:</strong> " + escapeHtml(String(row.durationMinutes || 0)) + " min</div>" +
          "<div style='margin-top:4px;'><strong>Fin:</strong> " + escapeHtml(endText) + "</div>";
      }
      if (ctxNotesInputEl) ctxNotesInputEl.value = String(row.notes || "");
      if (ctxNotesCountEl) ctxNotesCountEl.textContent = String((row.notes || "").length) + " / 500";
      if (ctxReminderD1El) ctxReminderD1El.checked = !!row.reminderD1Enabled;
      if (ctxReminderH3El) ctxReminderH3El.checked = !!row.reminderH3Enabled;
      if (ctxReminderDesignerEl) ctxReminderDesignerEl.checked = !!row.reminderDesignerEnabled;
      if (ctxOrderLinkWrapEl) {
        if (row.orderId) {
          const orderUrl = "https://" + String(shopValue()) + "/admin/orders/" + encodeURIComponent(String(row.orderId));
          const total = row.orderTotalAmount != null
            ? new Intl.NumberFormat("fr-FR", { style: "currency", currency: row.orderCurrency || "MAD" }).format(Number(row.orderTotalAmount || 0))
            : "-";
          ctxOrderLinkWrapEl.innerHTML =
            "<a href='" + orderUrl + "' target='_blank' rel='noreferrer' class='act order-link-btn' style='display:inline-flex;align-items:center;justify-content:center;width:100%;text-decoration:none;margin-bottom:8px;'>Ouvrir commande</a>" +
            "<button id='ctxViewOrderStatusBtn' class='act' type='button' style='width:100%; text-align:center; margin-bottom:8px;'>Voir statut paiement</button>" +
            "<div><strong>Order ID:</strong> " + escapeHtml(String(row.orderName || row.orderId)) + "</div>" +
            "<div style='margin-top:4px;'><strong>Total:</strong> " + escapeHtml(total) + "</div>";
        } else {
          ctxOrderLinkWrapEl.innerHTML =
            "<button id='ctxCreateOrderBtn' class='act primary' type='button' style='width:100%; text-align:center;'>Créer commande</button>";
        }
      }
      const isCompleted = String(row.status || "") === "completed";
      if (ctxActionConfirmEl) ctxActionConfirmEl.classList.toggle("is-hidden", isCompleted);
      if (ctxActionReminderEl) ctxActionReminderEl.classList.toggle("is-hidden", isCompleted);
      if (ctxActionRescheduleEl) ctxActionRescheduleEl.classList.toggle("is-hidden", isCompleted);
      if (ctxActionCompleteEl) ctxActionCompleteEl.classList.toggle("is-hidden", isCompleted);
      if (ctxActionReopenEl) ctxActionReopenEl.classList.toggle("is-hidden", !isCompleted);
      if (ctxTopActionReminderEl) ctxTopActionReminderEl.classList.toggle("is-hidden", isCompleted);
      if (ctxTopActionRescheduleEl) ctxTopActionRescheduleEl.classList.toggle("is-hidden", isCompleted);
      if (ctxTopActionCompleteEl) ctxTopActionCompleteEl.classList.toggle("is-hidden", isCompleted);
      if (ctxTimelineEl) {
        const logs = Array.isArray(timelineByAppointment[row.id]) ? timelineByAppointment[row.id] : [];
        const logEvents = logs.map((entry) => ({
          label: timelineLabelFromMessageType(entry.messageType),
          date: entry.sentAt || entry.createdAt,
          body: timelineBodyFromMessage(entry, row)
        }));
        const events = [
          { label: "Rendez-vous créé", date: row.createdAt, body: "Enregistrement ajouté dans le planning." },
          { label: "Rendez-vous prévu", date: row.appointmentAt, body: "Créneau planifié." },
          ...logEvents
        ].filter(Boolean).sort((a, b) => new Date(String(b.date || 0)).getTime() - new Date(String(a.date || 0)).getTime());
        ctxTimelineEl.innerHTML = events.map((evt) => {
          return "<div class='bubble'><div class='t'>" + escapeHtml(evt.label) + " • " + escapeHtml(formatDateTime(evt.date)) + "</div><div>" + escapeHtml(evt.body) + "</div></div>";
        }).join("");
      }

      if (window.matchMedia("(max-width: 1080px)").matches && contextPanelEl) {
        contextPanelEl.classList.add("open");
      }
    }

    function getWeekDates(weekStartDate) {
      const start = new Date(weekStartDate);
      start.setHours(0, 0, 0, 0);
      return Array.from({ length: 7 }, (_, i) => {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        return d;
      });
    }

    function renderCalendarView() {
      if (!calendarGridEl || !calendarWeekLabelEl) return;
      const weekDays = getWeekDates(calendarWeekStart);
      const fmtDay = new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "2-digit", month: "2-digit" });
      calendarWeekLabelEl.textContent = "Semaine du " + weekDays[0].toLocaleDateString("fr-FR") + " au " + weekDays[6].toLocaleDateString("fr-FR");
      const hourStart = 9;
      const hourEnd = 20;
      const rows = [];
      for (let h = hourStart; h <= hourEnd; h += 1) {
        rows.push("<div style='height:56px; border-top:1px solid #ebedf0; position:relative;'></div>");
      }
      const columns = weekDays.map((day, dayIdx) => {
        const dayStart = new Date(day);
        const dayEnd = new Date(day);
        dayEnd.setDate(day.getDate() + 1);
        const dayAppts = appointments.filter((row) => {
          const ts = new Date(String(row.appointmentAt || "")).getTime();
          return Number.isFinite(ts) && ts >= dayStart.getTime() && ts < dayEnd.getTime();
        });
        const blocks = dayAppts.map((row) => {
          const start = new Date(String(row.appointmentAt || ""));
          const end = new Date(String(row.endAt || ""));
          const startHourFloat = start.getHours() + start.getMinutes() / 60;
          const endHourFloat = end.getHours() + end.getMinutes() / 60;
          const top = Math.max(0, (startHourFloat - hourStart) * 56);
          const height = Math.max(24, (endHourFloat - startHourFloat) * 56);
          const typeMeta = appointmentTypeMeta(row.type);
          const soon = (new Date(row.appointmentAt).getTime() - Date.now()) < 2 * 60 * 60 * 1000 && (new Date(row.appointmentAt).getTime() - Date.now()) > 0;
          const today = new Date(row.appointmentAt).toDateString() === new Date().toDateString();
          return "<button type='button' data-calendar-id='" + escapeHtml(String(row.id || "")) + "' style='position:absolute;left:6px;right:6px;top:" + top + "px;height:" + height + "px;border-radius:10px;border:1px solid " + typeMeta.border + ";background:" + typeMeta.bg + ";color:" + typeMeta.color + ";padding:6px 7px;text-align:left;overflow:hidden;cursor:pointer;" + (soon ? "box-shadow: inset 3px 0 0 #c9342f;" : today ? "box-shadow: inset 3px 0 0 #8ab4f8;" : "") + "'>" +
            "<div style='font-size:11px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'>" + escapeHtml(row.customerName || "-") + "</div>" +
            "<div style='font-size:10px;margin-top:2px;'>" + escapeHtml(typeMeta.label) + " · " + escapeHtml(formatDateTime(row.appointmentAt)) + "</div>" +
          "</button>";
        }).join("");
        return "<div style='position:relative;border-left:1px solid #ebedf0;min-width:170px;'>" +
          "<div style='position:sticky;top:0;background:#fff;z-index:1;padding:8px 6px;border-bottom:1px solid #ebedf0;font-size:12px;font-weight:700;'>" + escapeHtml(fmtDay.format(day)) + "</div>" +
          "<div style='position:relative;height:" + ((hourEnd - hourStart + 1) * 56) + "px;'>" + rows.join("") + blocks + "</div>" +
        "</div>";
      }).join("");
      const timeAxis = Array.from({ length: hourEnd - hourStart + 1 }, (_, i) => hourStart + i)
        .map((h) => "<div style='height:56px;border-top:1px solid #ebedf0;padding-top:2px;font-size:11px;color:#6b7280;'>" + String(h).padStart(2, "0") + ":00</div>")
        .join("");
      calendarGridEl.innerHTML =
        "<div style='display:grid;grid-template-columns:72px 1fr;min-width:900px;'>" +
          "<div style='border-right:1px solid #ebedf0;background:#fff;position:sticky;left:0;z-index:2;'>" +
            "<div style='height:38px;border-bottom:1px solid #ebedf0;'></div>" + timeAxis +
          "</div>" +
          "<div style='display:grid;grid-template-columns:repeat(7,minmax(170px,1fr));'>" + columns + "</div>" +
        "</div>";
    }

    function applyViewMode() {
      if (appointmentsListWrapEl) appointmentsListWrapEl.style.display = activeView === "list" ? "grid" : "none";
      if (appointmentsCalendarWrapEl) appointmentsCalendarWrapEl.style.display = activeView === "calendar" ? "block" : "none";
      if (viewListBtnEl) viewListBtnEl.style.background = activeView === "list" ? "#111111" : "#fff";
      if (viewListBtnEl) viewListBtnEl.style.color = activeView === "list" ? "#fff" : "#1f2937";
      if (viewCalendarBtnEl) viewCalendarBtnEl.style.background = activeView === "calendar" ? "#111111" : "#fff";
      if (viewCalendarBtnEl) viewCalendarBtnEl.style.color = activeView === "calendar" ? "#fff" : "#1f2937";
      if (activeView === "calendar") renderCalendarView();
    }

    function renderAll() {
      renderAppointmentsTable();
      renderContextPanel();
      renderCalendarView();
      applyViewMode();
      updateKpis();
      if (tableSubEl) tableSubEl.textContent = String(appointments.length) + " enregistrements";
      if (shopLabelEl) shopLabelEl.textContent = shopValue() || "-";
    }

    async function loadAppointments() {
      const shop = shopValue();
      if (!shop) {
        appointments = [];
        renderAll();
        return;
      }
      renderSkeletonRows();
      try {
        const query = new URLSearchParams({ shop: shop, limit: "500" });
        const typeFilter = String(typeFilterSelectEl && typeFilterSelectEl.value ? typeFilterSelectEl.value : "all");
        if (typeFilter && typeFilter !== "all") query.set("type", typeFilter);
        const res = await fetch("/admin/api/appointments?" + query.toString());
        const parsed = await readJsonSafe(res);
        if (!res.ok || !parsed.ok || !parsed.data || !parsed.data.ok) {
          throw new Error(parsed.ok && parsed.data && parsed.data.error ? parsed.data.error : "Erreur chargement rendez-vous");
        }
        appointments = Array.isArray(parsed.data.appointments) ? parsed.data.appointments : [];
        timelineByAppointment = {};
        if (!selectedAppointment() && appointments[0]) selectedId = String(appointments[0].id || "");
        renderAll();
        if (selectedId) void loadTimelineForAppointment(selectedId);
      } catch (error) {
        appointments = [];
        timelineByAppointment = {};
        renderAll();
        showToast(error instanceof Error ? error.message : "Erreur chargement", "error");
      }
    }

    async function loadLocations() {
      const shop = shopValue();
      if (!shop) {
        locations = [];
        if (locationSelectEl) locationSelectEl.innerHTML = "<option value=''>Aucun point de vente</option>";
        return;
      }
      try {
        const query = new URLSearchParams({ shop: shop });
        const res = await fetch("/admin/api/appointments/locations?" + query.toString());
        const parsed = await readJsonSafe(res);
        if (!res.ok || !parsed.ok || !parsed.data || !parsed.data.ok) {
          throw new Error(parsed.ok && parsed.data && parsed.data.error ? parsed.data.error : "Erreur chargement points de vente");
        }
        locations = Array.isArray(parsed.data.locations) ? parsed.data.locations : [];
      } catch {
        locations = [];
      }
      if (locationSelectEl) {
        locationSelectEl.innerHTML = locationSelectOptionsHtml();
        applyDefaultCreateLocation();
      }
      if (rescheduleLocationSelectEl && rescheduleModalEl && rescheduleModalEl.style.display === "flex") {
        const currentLocation = selectedAppointment() ? selectedAppointment().location : null;
        rescheduleLocationSelectEl.innerHTML = locationSelectOptionsHtml();
        setLocationSelectValue(rescheduleLocationSelectEl, currentLocation);
      }
    }

    async function loadPaymentMethods() {
      const shop = shopValue();
      if (!shop) {
        shopifyPaymentMethods = defaultPaymentMethods();
        renderPaymentMethodsUi();
        return;
      }
      try {
        const query = new URLSearchParams({ shop: shop });
        const res = await fetch("/admin/api/appointments/payment-methods?" + query.toString());
        const parsed = await readJsonSafe(res);
        if (!res.ok || !parsed.ok) throw new Error("Erreur moyens de paiement");
        const rawMethods = Array.isArray(parsed.methods) ? parsed.methods : [];
        const allowed = new Set(["cash", "cheque", "bank_transfer", "card", "installment"]);
        const normalized = [];
        rawMethods.forEach((item) => {
          if (!item || typeof item !== "object") return;
          const code = String(item.code || "").trim();
          const label = String(item.label || "").trim();
          if (!allowed.has(code) || !label) return;
          if (normalized.some((row) => row.code === code)) return;
          normalized.push({ code, label });
        });
        shopifyPaymentMethods = normalized.length ? normalized : defaultPaymentMethods();
      } catch {
        shopifyPaymentMethods = defaultPaymentMethods();
      }
      renderPaymentMethodsUi();
    }

    function openModal() {
      if (!modalEl) return;
      syncCreateNotesVisibility();
      setCreateDefaultDateTime(false);
      applyDefaultCreateLocation();
      modalEl.style.display = "flex";
      modalEl.setAttribute("aria-hidden", "false");
      requestAnimationFrame(() => {
        modalEl.classList.add("open");
      });
    }

    function closeModal() {
      if (!modalEl) return;
      modalEl.classList.remove("open");
      modalEl.setAttribute("aria-hidden", "true");
      setTimeout(() => { modalEl.style.display = "none"; }, 180);
      hideCustomerSuggestions();
    }

    window.__openAppointmentsModal = openModal;
    window.__closeAppointmentsModal = closeModal;

    function syncCreateNotesVisibility() {
      if (!notesFieldWrapEl) return;
      const enabled = !!(createNotesToggleEl && createNotesToggleEl.checked);
      notesFieldWrapEl.style.display = enabled ? "block" : "none";
      if (!enabled) {
        if (notesInputEl) notesInputEl.value = "";
        if (notesCountEl) notesCountEl.textContent = "0 / 500";
      }
    }

    function hideCustomerSuggestions() {
      if (!customerSuggestBoxEl) return;
      customerSuggestBoxEl.style.display = "none";
      customerSuggestBoxEl.innerHTML = "";
    }

    function applySuggestedCustomer(item) {
      if (!item || typeof item !== "object") return;
      if (customerNameInputEl && item.name) customerNameInputEl.value = String(item.name);
      if (phoneInputEl && item.phone) phoneInputEl.value = String(item.phone);
      if (emailInputEl && item.email) emailInputEl.value = String(item.email);
      hideCustomerSuggestions();
    }

    function renderCustomerSuggestions() {
      if (!customerSuggestBoxEl) return;
      if (!customerSuggestions.length) {
        hideCustomerSuggestions();
        return;
      }
      customerSuggestBoxEl.innerHTML = customerSuggestions.map((item, idx) => {
        const meta = [String(item.email || ""), String(item.phone || "")].filter(Boolean).join(" · ");
        return "<button type='button' data-suggest='" + String(idx) + "' style='display:block;width:100%;border:0;border-bottom:1px solid #f0ece5;background:#fff;padding:9px 10px;text-align:left;cursor:pointer;'>" +
          "<span style='display:block;font-weight:700;color:#241f1b;'>" + escapeHtml(item.name || "Client Shopify") + "</span>" +
          "<span style='display:block;font-size:12px;color:#756e64;margin-top:2px;'>" + escapeHtml(meta) + "</span>" +
        "</button>";
      }).join("");
      customerSuggestBoxEl.style.display = "block";
    }

    async function fetchCustomerSuggestions(query) {
      const shop = shopValue();
      const q = String(query || "").trim();
      if (!shop || q.length < 1) {
        customerSuggestions = [];
        hideCustomerSuggestions();
        return;
      }
      try {
        const params = new URLSearchParams({ shop: shop, q: q });
        const res = await fetch("/admin/api/appointments/customer-suggest?" + params.toString());
        const parsed = await readJsonSafe(res);
        if (!res.ok || !parsed.ok || !parsed.data || !parsed.data.ok) {
          customerSuggestions = [];
          hideCustomerSuggestions();
          return;
        }
        customerSuggestions = Array.isArray(parsed.data.suggestions) ? parsed.data.suggestions : [];
        renderCustomerSuggestions();
      } catch {
        customerSuggestions = [];
        hideCustomerSuggestions();
      }
    }

    function queueCustomerSuggest(query) {
      if (suggestDebounceId) clearTimeout(suggestDebounceId);
      suggestDebounceId = setTimeout(() => fetchCustomerSuggestions(query), 170);
    }

    function hideOrderProductSuggestions() {
      if (!orderProductSuggestBoxEl) return;
      orderProductSuggestBoxEl.style.display = "none";
      orderProductSuggestBoxEl.innerHTML = "";
    }

    function selectedAppointmentForOrderModal() {
      return appointments.find((row) => String(row.id) === String(createOrderTargetId)) || null;
    }
    function latestOrderOutcomeForAppointment(row) {
      if (!row) return null;
      const appointmentId = String(row.id || "").trim();
      if (!appointmentId) return null;
      const cached = orderOutcomeByAppointment[appointmentId];
      if (cached && typeof cached === "object") return cached;
      const logs = Array.isArray(timelineByAppointment[appointmentId]) ? timelineByAppointment[appointmentId] : [];
      const orderLog = logs
        .filter((entry) => String(entry && entry.messageType ? entry.messageType : "").toLowerCase() === "order_created")
        .sort((a, b) => new Date(String(b && (b.sentAt || b.createdAt) || 0)).getTime() - new Date(String(a && (a.sentAt || a.createdAt) || 0)).getTime())[0];
      const payload = orderLog && orderLog.payload && typeof orderLog.payload === "object" ? orderLog.payload : null;
      const orderId = String(
        (payload && (payload.orderId || payload.id)) ||
        row.orderId ||
        row.shopifyOrderId ||
        ""
      ).trim();
      if (!orderId) return null;
      const resolvedPaymentMethod = String((payload && payload.paymentMethod) || "cash");
      const outcome = {
        id: orderId,
        name: String((payload && payload.orderName) || row.orderName || orderId),
        totalAmount: Number(
          (payload && payload.totalAmount != null ? payload.totalAmount : null) ??
          (row.orderTotalAmount != null ? row.orderTotalAmount : 0)
        ),
        currency: String((payload && payload.currency) || row.orderCurrency || "MAD"),
        paymentMethod: resolvedPaymentMethod,
        paymentMethodLabel: String(
          (payload && payload.paymentMethodLabel) ||
          paymentMethodLabel(resolvedPaymentMethod)
        ),
        paymentRecorded: payload && payload.paymentRecorded !== undefined ? !!payload.paymentRecorded : true,
        paymentRecordError: String((payload && payload.paymentRecordError) || ""),
        payment_type: payload && payload.payment_type ? String(payload.payment_type) : "",
        deposit_amount: payload && payload.deposit_amount != null ? Number(payload.deposit_amount) : null,
        remaining_amount: payload && payload.remaining_amount != null ? Number(payload.remaining_amount) : null,
        deposit_method: payload && payload.deposit_method ? String(payload.deposit_method) : null,
        remaining_method: payload && payload.remaining_method ? String(payload.remaining_method) : null,
        remaining_due_date: payload && payload.remaining_due_date ? String(payload.remaining_due_date) : null,
        url: "https://" + String(shopValue()) + "/admin/orders/" + encodeURIComponent(orderId)
      };
      orderOutcomeByAppointment[appointmentId] = outcome;
      return outcome;
    }
    async function openOrderStatusModalFor(row) {
      if (!row || !createOrderModalEl) return;
      const appointmentId = String(row.id || "").trim();
      if (!appointmentId) return;
      createOrderTargetId = appointmentId;
      if (!Array.isArray(timelineByAppointment[appointmentId])) {
        await loadTimelineForAppointment(appointmentId);
      }
      const outcome = latestOrderOutcomeForAppointment(row);
      if (!outcome) {
        showToast("Aucune commande liée disponible pour ce rendez-vous.", "error");
        return;
      }
      createOrderModalEl.style.display = "flex";
      createOrderModalEl.setAttribute("aria-hidden", "false");
      requestAnimationFrame(() => createOrderModalEl.classList.add("open"));
      renderSuccessState(outcome);
    }
    function selectedOrderShopifyLocationLabel() {
      const appt = selectedAppointmentForOrderModal();
      const label = String(appt && appt.location ? appt.location : "").trim();
      return label || "En ligne";
    }

    async function copyTextToClipboard(value) {
      const text = String(value || "").trim();
      if (!text) return false;
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch {}
      try {
        const input = document.createElement("input");
        input.value = text;
        input.style.position = "fixed";
        input.style.opacity = "0";
        document.body.appendChild(input);
        input.focus();
        input.select();
        const ok = document.execCommand("copy");
        input.remove();
        return !!ok;
      } catch {
        return false;
      }
    }

    function renderOrderClientContext() {
      if (!orderClientContextEl) return;
      const appt = selectedAppointmentForOrderModal();
      if (!appt) {
        orderClientContextEl.innerHTML = "<div class='order-client-meta'>Client et rendez-vous introuvables.</div>";
        return;
      }
      const name = String(appt.customerName || "Client").trim() || "Client";
      const phone = String(appt.customerPhone || "").trim();
      const when = formatDateTime(appt.appointmentAt);
      const where = String(appt.location || "").trim();
      orderClientContextEl.innerHTML =
        "<div class='order-client-main'>" +
          "<button type='button' class='order-client-chip' data-copy-order-client='" + escapeHtml(name) + "'>" + escapeHtml(name) + "</button>" +
          (phone ? "<button type='button' class='order-client-chip' data-copy-order-client='" + escapeHtml(phone) + "'>" + escapeHtml(phone) + "</button>" : "") +
        "</div>" +
        "<div class='order-client-meta'>" + escapeHtml(when) + (where ? " · " + escapeHtml(where) : "") + "</div>";
    }

    function validateOrderEditorDraft() {
      const title = String(orderCustomTitleInputEl && orderCustomTitleInputEl.value ? orderCustomTitleInputEl.value : "").trim();
      const quantity = currentOrderQty();
      const price = readPriceCents() / 100;
      const errors = [];
      const titleValid = !!title;
      const priceValid = Number.isFinite(price) && price > 0;
      const quantityValid = Number.isFinite(quantity) && quantity >= 1;
      if (!titleValid) errors.push("Titre requis.");
      if (!priceValid) errors.push("Prix > 0 requis.");
      if (!quantityValid) errors.push("Quantité >= 1 requise.");
      return {
        ok: errors.length === 0,
        title,
        quantity,
        price: Number.isFinite(price) ? Number(price.toFixed(2)) : 0,
        errors,
        fieldErrors: {
          title: !titleValid,
          price: !priceValid,
          quantity: !quantityValid
        }
      };
    }

    function clearOrderError() {
      if (!createOrderErrorEl) return;
      createOrderErrorEl.style.display = "none";
      createOrderErrorEl.textContent = "";
    }

    function setOrderError(message) {
      if (!createOrderErrorEl) return;
      createOrderErrorEl.style.display = "block";
      createOrderErrorEl.textContent = String(message || "");
    }

    function triggerOrderShake() {
      if (!createOrderModalEl) return;
      const modalCard = createOrderModalEl.querySelector(".order-editor-modal");
      if (!(modalCard instanceof HTMLElement)) return;
      modalCard.classList.remove("shake");
      requestAnimationFrame(() => {
        modalCard.classList.add("shake");
        setTimeout(() => modalCard.classList.remove("shake"), 360);
      });
    }

    function showLoadingState() {
      if (orderConfirmOrderBtnEl) {
        orderConfirmOrderBtnEl.disabled = true;
        orderConfirmOrderBtnEl.classList.add("loading");
      }
      if (orderConfirmOrderBtnTextEl) orderConfirmOrderBtnTextEl.textContent = "Paiement en cours...";
      if (orderMobilePrimaryBtnEl) {
        orderMobilePrimaryBtnEl.disabled = true;
        orderMobilePrimaryBtnEl.classList.add("loading");
        if (orderWizardStep === 2) orderMobilePrimaryBtnEl.textContent = "Paiement en cours...";
      }
    }

    function restoreButtonState() {
      if (orderConfirmOrderBtnEl) {
        orderConfirmOrderBtnEl.disabled = false;
        orderConfirmOrderBtnEl.classList.remove("loading");
      }
      if (orderMobilePrimaryBtnEl) {
        orderMobilePrimaryBtnEl.classList.remove("loading");
      }
      renderStickySummary();
      syncOrderPrimaryActions();
    }

    function setOrderModalSuccessVisible(show) {
      const visible = !!show;
      if (orderWizardHeadEl instanceof HTMLElement) orderWizardHeadEl.style.display = visible ? "none" : "grid";
      if (orderStepEditorEl) orderStepEditorEl.style.display = visible ? "none" : "";
      if (orderStepCartEl) orderStepCartEl.style.display = visible ? "none" : "";
      if (createOrderErrorEl) createOrderErrorEl.style.display = visible ? "none" : createOrderErrorEl.style.display;
      if (orderMobileSummaryBarEl instanceof HTMLElement) orderMobileSummaryBarEl.style.display = visible ? "none" : "";
      if (orderSuccessStateEl) orderSuccessStateEl.style.display = visible ? "flex" : "none";
    }

    function renderSuccessState(orderData) {
      if (!orderSuccessStateEl) return;
      if (createOrderTargetId && orderData && typeof orderData === "object") {
        orderOutcomeByAppointment[String(createOrderTargetId)] = Object.assign({}, orderData);
      }
      const orderName = String(orderData && (orderData.name || orderData.id) ? (orderData.name || orderData.id) : "-");
      const totals = computeOrderTotals();
      const totalFromOrder = Number(orderData && orderData.totalAmount != null ? orderData.totalAmount : NaN);
      const shownTotal = Number.isFinite(totalFromOrder) && totalFromOrder > 0 ? totalFromOrder : totals.total;
      const appt = selectedAppointmentForOrderModal();
      const paymentMethod = String(orderData && orderData.paymentMethod ? orderData.paymentMethod : selectedOrderPaymentMethod());
      const paymentLabel = String(
        orderData && orderData.paymentMethodLabel
          ? orderData.paymentMethodLabel
          : paymentMethodLabel(paymentMethod)
      );
      const openUrl = String(orderData && orderData.url ? orderData.url : "").trim();
      const paymentRecorded = !(orderData && orderData.paymentRecorded === false);
      const paymentError = String(orderData && orderData.paymentRecordError ? orderData.paymentRecordError : "").trim();
      const paymentBanner = paymentRecorded
        ? ""
        : (
          "<div class='order-inline-error' style='display:block;margin-bottom:10px;'>" +
            "Commande créée mais paiement non enregistré." +
            (paymentError ? (" " + escapeHtml(paymentError)) : "") +
          "</div>"
        );
      orderSuccessStateEl.innerHTML =
        "<div class='order-success-card'>" +
          "<svg class='order-checkmark' viewBox='0 0 72 72' aria-hidden='true'>" +
            "<circle class='order-checkmark-circle' cx='36' cy='36' r='30'></circle>" +
            "<path class='order-checkmark-path' d='M22 37 L32 47 L50 27'></path>" +
          "</svg>" +
          "<h3 class='order-success-title'>Commande créée avec succès</h3>" +
          "<div class='order-success-sub'>Commande #" + escapeHtml(orderName) + "</div>" +
          paymentBanner +
          "<div class='order-success-recap'>" +
            "<div class='order-success-row'><span>Client</span><strong>" + escapeHtml(String(appt && appt.customerName ? appt.customerName : "Client")) + "</strong></div>" +
            "<div class='order-success-row'><span>Total</span><strong>" + escapeHtml(formatMad(shownTotal)) + "</strong></div>" +
            "<div class='order-success-row'><span>Paiement</span><strong>" + escapeHtml(paymentLabel) + "</strong></div>" +
          "</div>" +
          "<div class='order-actions-row' style='justify-content:center;'>" +
            (!paymentRecorded
              ? "<button id='orderRetryPaymentBtn' class='order-cta-secondary' type='button' style='min-width:220px;'>Réessayer encaissement</button>"
              : "") +
            (openUrl
              ? "<a class='order-cta-primary' href='" + escapeHtml(openUrl) + "' target='_blank' rel='noreferrer' style='display:inline-flex;align-items:center;justify-content:center;min-width:200px;text-decoration:none;'>Ouvrir commande</a>"
              : "<button class='order-cta-primary' type='button' disabled style='min-width:200px;'>Ouvrir commande</button>") +
            "<button id='orderSuccessCloseBtn' class='order-cta-secondary' type='button' style='min-width:140px;'>Fermer</button>" +
          "</div>" +
        "</div>";
      setOrderModalSuccessVisible(true);
      const closeBtn = document.getElementById("orderSuccessCloseBtn");
      if (closeBtn) closeBtn.addEventListener("click", closeCreateOrderModal);
      const retryBtn = document.getElementById("orderRetryPaymentBtn");
      if (retryBtn) {
        retryBtn.addEventListener("click", async () => {
          const retry = await retryOrderPaymentCapture(orderData);
          if (retry && retry.ok) {
            const merged = Object.assign({}, orderData || {}, { paymentRecorded: true, paymentRecordError: null });
            renderSuccessState(merged);
          }
        });
      }
    }

    function syncOrderPrimaryActions() {
      const validation = validateOrderEditorDraft();
      if (addCustomOrderLineBtnEl) addCustomOrderLineBtnEl.disabled = !validation.ok;
      if (orderEditorValidationEl) {
        orderEditorValidationEl.textContent = hasAttemptedAddItem && !validation.ok ? validation.errors.join(" ") : "";
      }
      if (orderCustomTitleInputEl) orderCustomTitleInputEl.classList.toggle("is-invalid", !!(hasAttemptedAddItem && validation.fieldErrors && validation.fieldErrors.title));
      if (orderCustomPriceInputEl) orderCustomPriceInputEl.classList.toggle("is-invalid", !!(hasAttemptedAddItem && validation.fieldErrors && validation.fieldErrors.price));
      if (orderContinueToPaymentBtnEl) orderContinueToPaymentBtnEl.disabled = !Array.isArray(orderLines) || !orderLines.length;
      const hasLines = Array.isArray(orderLines) && orderLines.length > 0;
      let installmentInvalid = false;
      if (selectedOrderPaymentMethod() === "installment" && hasLines) {
        const totals = computeOrderTotals();
        installmentInvalid = !selectedInstallmentPlan(totals.total).ok;
      }
      if (orderInstallmentErrorEl) {
        if (selectedOrderPaymentMethod() === "installment" && hasLines) {
          const check = selectedInstallmentPlan(computeOrderTotals().total);
          orderInstallmentErrorEl.textContent = check.ok ? "" : check.error;
        } else {
          orderInstallmentErrorEl.textContent = "";
        }
      }
      if (orderConfirmOrderBtnEl) orderConfirmOrderBtnEl.disabled = !hasLines || installmentInvalid;
      if (orderMobilePrimaryBtnEl) {
        const needsItems = !hasLines;
        orderMobilePrimaryBtnEl.disabled = orderSingleStepFlow
          ? (needsItems || installmentInvalid)
          : ((needsItems && orderWizardStep === 1) || (orderWizardStep === 2 && installmentInvalid));
      }
    }

    function renderStickySummary() {
      const totals = computeOrderTotals();
      const itemCount = (Array.isArray(orderLines) ? orderLines : []).reduce((sum, line) => sum + Math.max(1, Number(line && line.quantity || 1)), 0);
      const splitModeForCta = selectedOrderPaymentMethod() === "installment" || selectedOrderPaymentMethod() === "split";
      const splitPlanForCta = splitModeForCta ? selectedInstallmentPlan(totals.total) : null;
      const amountToPayNow = splitPlanForCta && splitPlanForCta.ok ? Number(splitPlanForCta.data.firstAmount || 0) : totals.total;
      const confirmAmount = formatMad(amountToPayNow).replace(/,00(?=\s+[A-Z]{3}$)/, "");
      const confirmLabel = orderSingleStepFlow ? "Confirmer commande" : ("Paiement " + confirmAmount);
      if (orderMobileTotalValueEl) orderMobileTotalValueEl.textContent = formatMad(totals.total);
      if (orderPosAmountEl) orderPosAmountEl.textContent = formatMad(totals.total);
      if (orderConfirmOrderBtnTextEl && !(orderConfirmOrderBtnEl && orderConfirmOrderBtnEl.classList.contains("loading"))) {
        orderConfirmOrderBtnTextEl.textContent = confirmLabel;
      }
      if (orderMobilePrimaryBtnEl && (orderSingleStepFlow || orderWizardStep === 2) && !orderMobilePrimaryBtnEl.classList.contains("loading")) {
        orderMobilePrimaryBtnEl.textContent = confirmLabel;
      }
      syncOrderPaymentMethodVisual();

      if (document.getElementById("orderStep1Summary")) {
        const step1Summary = document.getElementById("orderStep1Summary");
        if (step1Summary) {
          step1Summary.innerHTML =
            "<h3 class='order-panel-title' style='margin-bottom:2px;'>Résumé</h3>" +
            "<div class='order-summary-line'><span>Articles</span><strong>" + escapeHtml(String(itemCount)) + "</strong></div>" +
            "<div class='order-summary-line'><span>Sous-total</span><strong>" + escapeHtml(formatMad(totals.subtotal)) + "</strong></div>" +
            "<div class='order-summary-total'><span>Total</span><strong>" + escapeHtml(formatMad(totals.total)) + "</strong></div>";
        }
      }
      if (orderPaymentSummaryEl) {
        const payment = selectedOrderPaymentMethod();
        const totalLabel = "Total";
        const shopifyLocation = selectedOrderShopifyLocationLabel();
        orderPaymentSummaryEl.innerHTML =
          "<div class='order-summary-line'><span>Mode de paiement</span><strong>" + escapeHtml(paymentMethodLabel(payment)) + "</strong></div>" +
          "<div class='order-summary-line'><span>Point de vente Shopify</span><strong>" + escapeHtml(shopifyLocation) + "</strong></div>" +
          "<div class='order-summary-line'><span>Sous-total</span><strong>" + escapeHtml(formatMad(totals.subtotal)) + "</strong></div>" +
          "<div class='order-summary-total'><span>" + totalLabel + "</span><strong>" + escapeHtml(formatMad(totals.total)) + "</strong></div>";
      }
      if (orderFinalRecapEl) {
        const payment = selectedOrderPaymentMethod();
        if (payment === "installment" || payment === "split") {
          const plan = selectedInstallmentPlan(totals.total);
          if (plan.ok) {
            orderFinalRecapEl.textContent =
              "Paiement 1: " + formatMad(plan.data.firstAmount) + " • Reste à payer: " + formatMad(plan.data.secondAmount);
          } else {
            orderFinalRecapEl.textContent = "Paiement 1: - • Reste à payer: -";
          }
        } else {
          const articleLabel = itemCount > 1 ? "articles" : "article";
          const paymentText = paymentMethodLabel(payment).toLowerCase();
          orderFinalRecapEl.textContent =
            String(itemCount) + " " + articleLabel + " • Paiement en " + paymentText + " • Total " + formatMad(totals.total);
        }
      }
      const splitMode = selectedOrderPaymentMethod() === "installment" || selectedOrderPaymentMethod() === "split";
      if (orderSplitPaymentWrapEl) orderSplitPaymentWrapEl.style.display = splitMode ? "grid" : "none";
      if (orderFinancialBadgeEl) {
        let statusText = "Payé";
        let statusClass = "paid";
        if (orderForceUnpaid) {
          statusText = "Non payé";
          statusClass = "pending";
        } else if (splitMode) {
          const plan = selectedInstallmentPlan(totals.total);
          if (plan.ok && plan.data.secondAmount <= 0) {
            statusText = "Payé";
            statusClass = "paid";
          } else if (plan.ok && plan.data.firstAmount > 0) {
            statusText = "Partiellement payé";
            statusClass = "partial";
          } else {
            statusText = "Non payé";
            statusClass = "pending";
          }
        }
        orderFinancialBadgeEl.className = "order-financial-badge " + statusClass;
        orderFinancialBadgeEl.textContent = statusText;
      }
      if (orderBalanceActionWrapEl) {
        const plan = splitMode ? selectedInstallmentPlan(totals.total) : null;
        orderBalanceActionWrapEl.style.display = splitMode && plan && plan.ok && plan.data.secondAmount > 0 ? "block" : "none";
      }
      if (splitMode && orderSplitRemainderLabelEl) {
        const plan = selectedInstallmentPlan(totals.total);
        const depositRaw = orderSplitFirstAmountInputEl && orderSplitFirstAmountInputEl.value ? orderSplitFirstAmountInputEl.value : "";
        const depositParsed = Math.max(0, Number(parseMoneyInput(depositRaw).toFixed(2)));
        const remaining = plan.ok ? plan.data.secondAmount : Math.max(0, Number((totals.total - depositParsed).toFixed(2)));
        if (orderSplitRemainingAmountInputEl) orderSplitRemainingAmountInputEl.value = formatMad(remaining);
        orderSplitRemainderLabelEl.textContent = "Reste à payer (paiement 2): " + formatMad(remaining);
      }
    }

    function renderStep1() {
      if (!orderLinesWrapEl) return;
      if (!Array.isArray(orderLines) || !orderLines.length) {
        orderLinesWrapEl.innerHTML = "<div class='order-line-row'><div class='order-line-meta'>Aucun article ajouté.</div></div>";
      } else {
        orderLinesWrapEl.innerHTML = orderLines.map((line, idx) => {
          const qty = Math.max(1, Number(line.quantity || 1));
          const price = Number(line.price || 0);
          const label = String(line.title || "").trim() || "Article";
          return "<div class='order-line-row compact'>" +
            "<div><strong>" + escapeHtml(label) + "</strong><div class='order-line-meta'>" + escapeHtml(String(qty)) + " × " + escapeHtml(formatMad(price)) + "</div></div>" +
            "<div class='order-line-subtotal'>" + escapeHtml(formatMad(qty * price)) + "</div>" +
            "<button type='button' data-remove-order-line='" + String(idx) + "' class='order-line-remove'>Supprimer</button>" +
          "</div>";
        }).join("");
      }
      renderStickySummary();
      syncOrderPrimaryActions();
    }

    function renderStep2() {
      renderOrderClientContext();
      if (!orderCartItemsEl) return;
      if (!Array.isArray(orderLines) || !orderLines.length) {
        orderCartItemsEl.innerHTML = "<div class='order-line-row'><div class='order-line-meta'>Aucun article dans le panier.</div></div>";
      } else {
        orderCartItemsEl.innerHTML = orderLines.map((line, idx) => {
          const qty = Math.max(1, Number(line.quantity || 1));
          const price = Number(line.price || 0);
          const total = qty * price;
          return "<div class='order-cart-row'>" +
            "<div><strong>" + escapeHtml(String(line.title || "Article")) + "</strong><div class='order-line-meta'>" + escapeHtml(formatMad(price)) + "</div></div>" +
            "<div class='order-cart-row-right'>" +
              "<div class='order-qty'>" +
                "<button type='button' class='order-qty-btn' data-order-qty-change='" + String(idx) + "' data-order-qty-delta='-1'>−</button>" +
                "<div class='order-qty-value'>" + escapeHtml(String(qty)) + "</div>" +
                "<button type='button' class='order-qty-btn' data-order-qty-change='" + String(idx) + "' data-order-qty-delta='1'>+</button>" +
              "</div>" +
              "<div class='order-line-subtotal'>" + escapeHtml(formatMad(total)) + "</div>" +
              "<button type='button' data-remove-order-line='" + String(idx) + "' class='order-line-remove'>Supprimer</button>" +
            "</div>" +
          "</div>";
        }).join("");
      }
      renderStickySummary();
      syncOrderPrimaryActions();
    }

    function openCreateOrderModalFor(appointmentId) {
      createOrderTargetId = String(appointmentId || "").trim();
      if (!createOrderTargetId || !createOrderModalEl) return;
      orderLines = [];
      hasAttemptedAddItem = false;
      orderProductSuggestions = [];
      if (orderProductSearchInputEl) orderProductSearchInputEl.value = "";
      if (orderCustomTitleInputEl) orderCustomTitleInputEl.value = "";
      if (orderCustomQtyInputEl) orderCustomQtyInputEl.value = "1";
      if (orderQtyValueEl) orderQtyValueEl.textContent = "1";
      if (orderCustomPriceInputEl) {
        orderCustomPriceInputEl.value = "0,00";
        orderCustomPriceInputEl.dataset.cents = "0";
      }
      if (orderSplitFirstAmountInputEl) orderSplitFirstAmountInputEl.value = "";
      if (orderSplitSecondMethodSelectEl) orderSplitSecondMethodSelectEl.value = "";
      if (orderSplitDueDateInputEl) orderSplitDueDateInputEl.value = "";
      if (orderSplitRemainingAmountInputEl) orderSplitRemainingAmountInputEl.value = "0,00 MAD";
      if (orderInstallmentErrorEl) orderInstallmentErrorEl.textContent = "";
      if (orderPaymentMethodSelectEl) orderPaymentMethodSelectEl.value = defaultSinglePaymentCode();
      if (orderSplitFirstMethodSelectEl) orderSplitFirstMethodSelectEl.value = defaultSinglePaymentCode();
      orderForceUnpaid = false;
      setOrderModalSuccessVisible(false);
      if (orderSuccessStateEl) orderSuccessStateEl.innerHTML = "";
      syncOrderStepUi("editor");
      if (createOrderErrorEl) {
        createOrderErrorEl.style.display = "none";
        createOrderErrorEl.textContent = "";
      }
      hideOrderProductSuggestions();
      renderOrderClientContext();
      renderStep1();
      renderStep2();
      createOrderModalEl.style.display = "flex";
      createOrderModalEl.setAttribute("aria-hidden", "false");
      requestAnimationFrame(() => {
        createOrderModalEl.classList.add("open");
        if (orderCustomTitleInputEl) orderCustomTitleInputEl.focus();
      });
    }

    function closeCreateOrderModal() {
      if (!createOrderModalEl) return;
      createOrderModalEl.classList.remove("open");
      createOrderModalEl.setAttribute("aria-hidden", "true");
      setTimeout(() => { createOrderModalEl.style.display = "none"; }, 180);
      setOrderModalSuccessVisible(false);
      restoreButtonState();
      if (orderSuccessStateEl) orderSuccessStateEl.innerHTML = "";
      createOrderTargetId = "";
      hideOrderProductSuggestions();
    }

    function currentOrderQty() {
      const fromInput = Number(orderCustomQtyInputEl && orderCustomQtyInputEl.value ? orderCustomQtyInputEl.value : "");
      const fromText = Number(orderQtyValueEl && orderQtyValueEl.textContent ? orderQtyValueEl.textContent : "1");
      const qty = Number.isFinite(fromInput) && fromInput > 0 ? fromInput : fromText;
      return Number.isFinite(qty) ? Math.max(1, Math.floor(qty)) : 1;
    }

    function setOrderQty(qty) {
      const safe = Math.max(1, Math.min(999, Math.floor(Number(qty || 1))));
      if (orderCustomQtyInputEl) orderCustomQtyInputEl.value = String(safe);
      if (orderQtyValueEl) orderQtyValueEl.textContent = String(safe);
    }

    function formatCentsToMad(cents) {
      const safe = Math.max(0, Math.floor(Number(cents || 0)));
      const major = Math.floor(safe / 100);
      const minor = String(safe % 100).padStart(2, "0");
      return new Intl.NumberFormat("fr-FR").format(major) + "," + minor;
    }

    function readPriceCents() {
      if (!orderCustomPriceInputEl) return 0;
      const raw = String(orderCustomPriceInputEl.value || "").trim();
      const sanitized = raw
        .replace(/\s+/g, "")
        .replace(/,/g, ".")
        .replace(/[^0-9.]/g, "");
      const parsed = Number(sanitized || "0");
      if (!Number.isFinite(parsed)) return 0;
      return Math.max(0, Math.round(parsed * 100));
    }

    function writePriceCents(cents) {
      const safe = Math.max(0, Math.floor(Number(cents || 0)));
      if (!orderCustomPriceInputEl) return;
      orderCustomPriceInputEl.dataset.cents = String(safe);
      orderCustomPriceInputEl.value = formatCentsToMad(safe);
    }

    function buildCustomOrderLineFromEditor() {
      const validation = validateOrderEditorDraft();
      if (!validation.ok) return null;
      return {
        title: validation.title,
        quantity: validation.quantity,
        price: validation.price,
        taxable: false
      };
    }

    function addCustomOrderLine() {
      hasAttemptedAddItem = true;
      const line = buildCustomOrderLineFromEditor();
      if (!line) {
        syncOrderPrimaryActions();
        return;
      }
      orderLines.push(line);
      hasAttemptedAddItem = false;
      if (orderCustomTitleInputEl) orderCustomTitleInputEl.value = "";
      setOrderQty(1);
      writePriceCents(0);
      clearOrderError();
      renderStep1();
      renderStep2();
      showToast("Article ajouté au panier.", "success");
    }

    function formatMad(value) {
      const n = Number(value || 0);
      return new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n) + " MAD";
    }

    function computeOrderTotals() {
      const subtotal = (Array.isArray(orderLines) ? orderLines : []).reduce((sum, line) => {
        const qty = Math.max(1, Number(line.quantity || 1));
        const price = Number(line.price || 0);
        return sum + qty * price;
      }, 0);
      const tax = 0;
      return { subtotal, tax, total: subtotal };
    }

    function openCartStep() {
      if (orderSingleStepFlow) {
        return submitOrderConfirmation();
      }
      if (!Array.isArray(orderLines) || !orderLines.length) {
        setOrderError("Panier vide: ajoutez au moins un article.");
        return false;
      }
      clearOrderError();
      renderStep2();
      syncOrderStepUi("cart");
      return true;
    }

    async function fetchOrderProductSuggestions(query) {
      const shop = shopValue();
      const q = String(query || "").trim();
      if (!shop || q.length < 2) {
        orderProductSuggestions = [];
        hideOrderProductSuggestions();
        return;
      }
      try {
        const params = new URLSearchParams({ shop: shop, q: q });
        const res = await fetch("/admin/api/appointments/product-suggest?" + params.toString());
        const parsed = await readJsonSafe(res);
        if (!res.ok || !parsed.ok || !parsed.data || !parsed.data.ok) {
          orderProductSuggestions = [];
          hideOrderProductSuggestions();
          return;
        }
        orderProductSuggestions = Array.isArray(parsed.data.suggestions) ? parsed.data.suggestions : [];
        if (!orderProductSuggestBoxEl || !orderProductSuggestions.length) {
          hideOrderProductSuggestions();
          return;
        }
        orderProductSuggestBoxEl.innerHTML = orderProductSuggestions.map((item, idx) => {
          const price = Number(item.price || 0);
          return "<button type='button' data-order-product-suggest='" + String(idx) + "' style='display:block;width:100%;border:0;border-bottom:1px solid #f0ece5;background:#fff;padding:9px 10px;text-align:left;cursor:pointer;'>" +
            "<span style='display:block;font-weight:700;color:#241f1b;'>" + escapeHtml(item.title || "Produit Shopify") + "</span>" +
            "<span style='display:block;font-size:12px;color:#756e64;margin-top:2px;'>Variant #" + escapeHtml(String(item.variantId || "")) + " · " + escapeHtml(new Intl.NumberFormat(\"fr-FR\", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(price)) + " MAD</span>" +
          "</button>";
        }).join("");
        orderProductSuggestBoxEl.style.display = "block";
      } catch {
        orderProductSuggestions = [];
        hideOrderProductSuggestions();
      }
    }

    function queueOrderProductSuggest(query) {
      if (orderProductSuggestDebounceId) clearTimeout(orderProductSuggestDebounceId);
      orderProductSuggestDebounceId = setTimeout(() => fetchOrderProductSuggestions(query), 180);
    }

    async function createAppointment(sendConfirmation) {
      const shop = shopValue();
      const windowData = readCreateWindow();
      const payload = {
        shop: shop,
        customerName: String(customerNameInputEl && customerNameInputEl.value ? customerNameInputEl.value : "").trim(),
        customerPhone: String(phoneInputEl && phoneInputEl.value ? phoneInputEl.value : "").trim(),
        customerEmail: String(emailInputEl && emailInputEl.value ? emailInputEl.value : "").trim() || null,
        appointmentAt: windowData.appointmentAt,
        endAt: windowData.endAt,
        type: String(typeInputEl && typeInputEl.value ? typeInputEl.value : "fitting"),
        durationMinutes: windowData.durationMinutes,
        status: String(statusInputEl && statusInputEl.value ? statusInputEl.value : "scheduled"),
        location: selectedLocationValue(),
        notes: !!(createNotesToggleEl && createNotesToggleEl.checked)
          ? (String(notesInputEl && notesInputEl.value ? notesInputEl.value : "").trim() || null)
          : null,
        reminderD1Enabled: !!(createReminderD1InputEl && createReminderD1InputEl.checked),
        reminderH3Enabled: !!(createReminderH3InputEl && createReminderH3InputEl.checked),
        reminderDesignerEnabled: !!(createReminderDesignerInputEl && createReminderDesignerInputEl.checked)
      };

      if (!payload.shop || !payload.customerName || !payload.customerPhone || !payload.appointmentAt) {
        showToast("Nom, téléphone, date et shop sont obligatoires.", "error");
        return;
      }
      if (createConflictErrorEl) {
        createConflictErrorEl.style.display = "none";
        createConflictErrorEl.textContent = "";
      }

      const lockBtn = sendConfirmation ? createAndSendBtnEl : createOnlyBtnEl;
      if (lockBtn) lockBtn.disabled = true;
      try {
        const res = await fetch("/admin/api/appointments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        const parsed = await readJsonSafe(res);
        if (!res.ok || !parsed.ok || !parsed.data || !parsed.data.ok) {
          if (res.status === 409 && createConflictErrorEl) {
            createConflictErrorEl.style.display = "block";
            createConflictErrorEl.textContent = String(parsed.ok && parsed.data && parsed.data.error ? parsed.data.error : "Conflit horaire.");
          }
          throw new Error(parsed.ok && parsed.data && parsed.data.error ? parsed.data.error : "Échec création rendez-vous");
        }
        const created = parsed.data.appointment;
        showToast("Rendez-vous créé.", "success");

        if (sendConfirmation && created && created.id) {
          const sendRes = await fetch("/admin/api/appointments/" + encodeURIComponent(created.id) + "/send-template", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ shop: shop, action: "confirm" })
          });
          const sendParsed = await readJsonSafe(sendRes);
          if (!sendRes.ok || !sendParsed.ok || !sendParsed.data || !sendParsed.data.ok) {
            throw new Error(sendParsed.ok && sendParsed.data && sendParsed.data.error ? sendParsed.data.error : "Créé mais envoi confirmation échoué");
          }
          showToast("Confirmation WhatsApp envoyée.", "success");
        }

        if (customerNameInputEl) customerNameInputEl.value = "";
        if (phoneInputEl) phoneInputEl.value = "";
        if (emailInputEl) emailInputEl.value = "";
        if (statusInputEl) statusInputEl.value = "scheduled";
        if (typeInputEl) typeInputEl.value = "fitting";
        if (durationInputEl) durationInputEl.value = "60";
        if (atInputEl) atInputEl.value = "";
        if (endAtInputEl) endAtInputEl.value = "";
        if (locationSelectEl) {
          locationSelectEl.value = "";
          applyDefaultCreateLocation();
        }
        if (createNotesToggleEl) createNotesToggleEl.checked = false;
        if (notesFieldWrapEl) notesFieldWrapEl.style.display = "none";
        if (notesInputEl) notesInputEl.value = "";
        if (notesCountEl) notesCountEl.textContent = "0 / 500";
        if (createReminderD1InputEl) createReminderD1InputEl.checked = true;
        if (createReminderH3InputEl) createReminderH3InputEl.checked = true;
        if (createReminderDesignerInputEl) createReminderDesignerInputEl.checked = true;

        closeModal();
        await loadAppointments();
      } catch (error) {
        showToast(error instanceof Error ? error.message : "Erreur création", "error");
      } finally {
        if (lockBtn) lockBtn.disabled = false;
      }
    }

    async function sendTemplateFor(id, action) {
      if (!id) return;
      try {
        const res = await fetch("/admin/api/appointments/" + encodeURIComponent(id) + "/send-template", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shop: shopValue(), action: action })
        });
        const parsed = await readJsonSafe(res);
        if (!res.ok || !parsed.ok || !parsed.data || !parsed.data.ok) {
          throw new Error(parsed.ok && parsed.data && parsed.data.error ? parsed.data.error : "Échec envoi template");
        }
        showToast("Message envoyé.", "success");
        await loadAppointments();
      } catch (error) {
        showToast(error instanceof Error ? error.message : "Erreur envoi", "error");
      }
    }

    async function sendDesignerReminderFor(id) {
      if (!id) return;
      try {
        const res = await fetch("/admin/api/appointments/" + encodeURIComponent(id) + "/send-designer-reminder", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shop: shopValue() })
        });
        const parsed = await readJsonSafe(res);
        if (!res.ok || !parsed.ok || !parsed.data || !parsed.data.ok) {
          throw new Error(parsed.ok && parsed.data && parsed.data.error ? parsed.data.error : "Échec envoi rappel designer");
        }
        showToast("Rappel designer envoyé.", "success");
        await loadAppointments();
      } catch (error) {
        showToast(error instanceof Error ? error.message : "Erreur rappel designer", "error");
      }
    }

    async function updateStatus(id, status) {
      if (!id || !status) return;
      try {
        const res = await fetch("/admin/api/appointments/" + encodeURIComponent(id), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shop: shopValue(), status: status })
        });
        const parsed = await readJsonSafe(res);
        if (!res.ok || !parsed.ok || !parsed.data || !parsed.data.ok) {
          throw new Error(parsed.ok && parsed.data && parsed.data.error ? parsed.data.error : "Échec mise à jour statut");
        }
        showToast("Statut mis à jour.", "success");
        await loadAppointments();
      } catch (error) {
        showToast(error instanceof Error ? error.message : "Erreur statut", "error");
      }
    }

    async function updateAppointmentPatch(id, patch, successMessage) {
      if (!id) return;
      try {
        const res = await fetch("/admin/api/appointments/" + encodeURIComponent(id), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(Object.assign({ shop: shopValue() }, patch || {}))
        });
        const parsed = await readJsonSafe(res);
        if (!res.ok || !parsed.ok || !parsed.data || !parsed.data.ok) {
          throw new Error(parsed.ok && parsed.data && parsed.data.error ? parsed.data.error : "Échec mise à jour");
        }
        if (successMessage) showToast(successMessage, "success");
        await loadAppointments();
      } catch (error) {
        showToast(error instanceof Error ? error.message : "Erreur mise à jour", "error");
      }
    }

    function selectedOrderPaymentMethod() {
      const fallback = defaultSinglePaymentCode();
      const value = String(orderPaymentMethodSelectEl && orderPaymentMethodSelectEl.value ? orderPaymentMethodSelectEl.value : "").trim();
      const methods = Array.isArray(shopifyPaymentMethods) && shopifyPaymentMethods.length ? shopifyPaymentMethods : defaultPaymentMethods();
      if (value && methods.some((item) => item.code === value)) return value;
      return fallback;
    }

    function syncOrderPaymentMethodVisual() {
      if (!orderPosMethodListEl) return;
      const selected = selectedOrderPaymentMethod();
      const items = Array.from(orderPosMethodListEl.querySelectorAll("[data-order-payment-method]"));
      items.forEach((node) => {
        if (!(node instanceof HTMLElement)) return;
        const method = String(node.getAttribute("data-order-payment-method") || "");
        node.classList.toggle("is-active", method === selected);
      });
      if (orderMarkUnpaidBtnEl) orderMarkUnpaidBtnEl.classList.toggle("is-active", orderForceUnpaid);
    }

    function parseMoneyInput(value) {
      const normalized = String(value || "").trim().replace(/\s+/g, "").replace(/,/g, ".");
      const parsed = Number(normalized);
      if (!Number.isFinite(parsed)) return 0;
      return parsed;
    }

    function selectedInstallmentPlan(totalTTC) {
      const depositRaw = orderSplitFirstAmountInputEl && orderSplitFirstAmountInputEl.value ? orderSplitFirstAmountInputEl.value : "";
      const depositAmount = Math.max(0, Number(parseMoneyInput(depositRaw).toFixed(2)));
      const depositMethod = String(orderSplitFirstMethodSelectEl && orderSplitFirstMethodSelectEl.value ? orderSplitFirstMethodSelectEl.value : defaultSinglePaymentCode());
      const remainingMethodRaw = String(orderSplitSecondMethodSelectEl && orderSplitSecondMethodSelectEl.value ? orderSplitSecondMethodSelectEl.value : "").trim();
      const remainingMethod = remainingMethodRaw || null;
      const remainingDueDate = String(orderSplitDueDateInputEl && orderSplitDueDateInputEl.value ? orderSplitDueDateInputEl.value : "").trim() || null;
      const safeTotal = Number(Number(totalTTC || 0).toFixed(2));
      if (!(depositAmount > 0)) {
        return { ok: false, error: "Veuillez renseigner le montant du premier paiement." };
      }
      if (depositAmount > safeTotal) {
        return { ok: false, error: "Paiement 1 invalide: le montant doit être inférieur ou égal au total." };
      }
      const remainingAmount = Number((safeTotal - depositAmount).toFixed(2));
      return {
        ok: true,
        data: {
          firstAmount: depositAmount,
          firstMethod: depositMethod,
          secondAmount: remainingAmount,
          secondMethod: remainingMethod || undefined,
          remainingDueDate: remainingDueDate || undefined,
          payment_type: "installment",
          deposit_amount: depositAmount,
          remaining_amount: remainingAmount,
          deposit_method: depositMethod,
          remaining_method: remainingMethod,
          remaining_due_date: remainingDueDate
        }
      };
    }

    function syncOrderStepUi(step) {
      if (orderSingleStepFlow) {
        orderWizardStep = 1;
        if (orderStepEditorEl) {
          orderStepEditorEl.classList.remove("is-hidden");
        }
        if (orderStepCartEl) {
          orderStepCartEl.classList.add("is-hidden");
        }
        if (orderWizardStepLabelEl) orderWizardStepLabelEl.textContent = "Étape 1/1";
        if (orderWizardProgressFillEl) orderWizardProgressFillEl.style.width = "100%";
        if (orderMobilePrimaryBtnEl) {
          orderMobilePrimaryBtnEl.textContent = "Confirmer commande";
        }
        renderStep1();
        syncOrderPrimaryActions();
        return;
      }
      const isCart = step === "cart";
      orderWizardStep = isCart ? 2 : 1;
      if (orderStepEditorEl) {
        orderStepEditorEl.classList.toggle("is-hidden", isCart);
      }
      if (orderStepCartEl) {
        orderStepCartEl.classList.toggle("is-hidden", !isCart);
      }
      if (orderWizardStepLabelEl) orderWizardStepLabelEl.textContent = isCart ? "Étape 2/2" : "Étape 1/2";
      if (orderWizardProgressFillEl) orderWizardProgressFillEl.style.width = isCart ? "100%" : "50%";
      if (orderMobilePrimaryBtnEl) {
        orderMobilePrimaryBtnEl.textContent = isCart ? "Confirmer commande" : "Continuer vers paiement";
      }
      if (isCart) renderStep2();
      else renderStep1();
      syncOrderPrimaryActions();
    }

    function buildOrderLinePayload() {
      return orderLines.map((line) => ({
        title: String(line.title || "Vente personnalisée"),
        quantity: Math.max(1, Number(line.quantity || 1)),
        price: Number(Number(line.price || 0).toFixed(2)),
        variantId: line.variantId
      }));
    }

    async function submitOrderConfirmation() {
      if (!createOrderTargetId) return;
      if (!Array.isArray(orderLines) || !orderLines.length) {
        setOrderError("Ajoutez au moins un article.");
        return;
      }
      const totalsGuard = computeOrderTotals();
      if (!(Number(totalsGuard.total || 0) > 0)) {
        setOrderError("Total TTC invalide: ajoutez un article avec montant > 0.");
        return;
      }
      clearOrderError();
      showLoadingState();
      try {
        const paymentMethod = selectedOrderPaymentMethod();
        const totals = computeOrderTotals();
        let paymentBreakdown = undefined;
        let paymentMeta = undefined;
        if (paymentMethod === "installment" || paymentMethod === "split") {
          const installment = selectedInstallmentPlan(totals.total);
          if (!installment.ok) {
            setOrderError(installment.error);
            return;
          }
          paymentBreakdown = {
            firstAmount: installment.data.firstAmount,
            firstMethod: installment.data.firstMethod,
            secondAmount: installment.data.secondAmount,
            secondMethod: installment.data.secondMethod,
            remainingDueDate: installment.data.remaining_due_date || undefined
          };
          paymentMeta = {
            payment_type: "installment",
            deposit_amount: installment.data.deposit_amount,
            remaining_amount: installment.data.remaining_amount,
            deposit_method: installment.data.deposit_method,
            remaining_method: installment.data.remaining_method,
            remaining_due_date: installment.data.remaining_due_date
          };
        }
        const order = await createLinkedOrder(createOrderTargetId, buildOrderLinePayload(), paymentMethod, paymentBreakdown, paymentMeta);
        if (order) {
          if (order.paymentRecorded === false && !orderForceUnpaid) {
            const detail = String(order.paymentRecordError || "").trim();
            const suffix = detail ? " (" + detail.slice(0, 180) + ")" : "";
            showToast("error", "Commande créée, mais le paiement n'a pas été encaissé." + suffix);
          } else {
            showToast("success", "Commande créée avec succès.");
          }
          renderSuccessState(order);
          return;
        }
        triggerOrderShake();
      } finally {
        restoreButtonState();
      }
    }

    async function createLinkedOrder(appointmentId, lineItems, paymentMethod, paymentBreakdown, paymentMeta) {
      if (!appointmentId) return;
      try {
        const res = await fetch("/admin/api/appointments/" + encodeURIComponent(appointmentId) + "/create-order", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            shop: shopValue(),
            lineItems: Array.isArray(lineItems) ? lineItems : [],
            paymentMethod: String(paymentMethod || "cash"),
            markUnpaid: orderForceUnpaid,
            paymentBreakdown: paymentBreakdown || undefined,
            payment_type: paymentMeta && paymentMeta.payment_type ? paymentMeta.payment_type : undefined,
            deposit_amount: paymentMeta && Number.isFinite(Number(paymentMeta.deposit_amount)) ? Number(paymentMeta.deposit_amount) : undefined,
            remaining_amount: paymentMeta && Number.isFinite(Number(paymentMeta.remaining_amount)) ? Number(paymentMeta.remaining_amount) : undefined,
            deposit_method: paymentMeta && paymentMeta.deposit_method ? String(paymentMeta.deposit_method) : undefined,
            remaining_method: paymentMeta && paymentMeta.remaining_method ? String(paymentMeta.remaining_method) : undefined,
            remaining_due_date: paymentMeta && paymentMeta.remaining_due_date ? String(paymentMeta.remaining_due_date) : undefined
          })
        });
        const parsed = await readJsonSafe(res);
        if (!res.ok || !parsed.ok || !parsed.data || !parsed.data.ok) {
          throw new Error(parsed.ok && parsed.data && parsed.data.error ? parsed.data.error : "Échec création commande");
        }
        await loadAppointments();
        return parsed.data.order || null;
      } catch (error) {
        showToast("error", error instanceof Error ? error.message : "Erreur création commande");
        return null;
      }
    }

    async function retryOrderPaymentCapture(orderData) {
      if (!createOrderTargetId) return null;
      const orderId = String(orderData && orderData.id ? orderData.id : "").trim();
      if (!orderId) {
        showToast("error", "Commande introuvable pour retry paiement.");
        return null;
      }
      const paymentMethod = String(orderData && orderData.paymentMethod ? orderData.paymentMethod : selectedOrderPaymentMethod());
      const paymentMethodLabelText = String(orderData && orderData.paymentMethodLabel ? orderData.paymentMethodLabel : paymentMethodLabel(paymentMethod));
      const amount = Number(orderData && orderData.deposit_amount != null
        ? Number(orderData.deposit_amount)
        : Number(orderData && orderData.totalAmount != null ? orderData.totalAmount : 0));
      if (!(amount > 0)) {
        showToast("error", "Montant d'encaissement invalide.");
        return null;
      }
      try {
        const res = await fetch("/admin/api/appointments/" + encodeURIComponent(createOrderTargetId) + "/retry-payment", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            shop: shopValue(),
            orderId: orderId,
            amount: amount,
            currency: String(orderData && orderData.currency ? orderData.currency : "MAD"),
            paymentMethod: paymentMethod,
            paymentMethodLabel: paymentMethodLabelText
          })
        });
        const parsed = await readJsonSafe(res);
        if (!res.ok || !parsed.ok || !parsed.data || !parsed.data.ok) {
          throw new Error(parsed.ok && parsed.data && parsed.data.error ? parsed.data.error : "Échec retry encaissement");
        }
        showToast("success", "Acompte encaissé avec succès.");
        return parsed.data;
      } catch (error) {
        showToast("error", error instanceof Error ? error.message : "Erreur retry encaissement");
        return null;
      }
    }

    async function applyReschedule(sendAfterUpdate) {
      const id = String(rescheduleTargetId || "").trim();
      if (!id) return;
      const newIso = localDateTimeToIso(
        rescheduleDateInputEl && rescheduleDateInputEl.value ? rescheduleDateInputEl.value : "",
        rescheduleTimeInputEl && rescheduleTimeInputEl.value ? rescheduleTimeInputEl.value : ""
      );
      if (!newIso) {
        showToast("Veuillez choisir une date et une heure valides.", "error");
        return;
      }
      if (rescheduleConflictErrorEl) {
        rescheduleConflictErrorEl.style.display = "none";
        rescheduleConflictErrorEl.textContent = "";
      }

      const extraMessage =
        rescheduleCustomToggleEl && rescheduleCustomToggleEl.checked && rescheduleCustomMessageInputEl
          ? String(rescheduleCustomMessageInputEl.value || "").trim()
          : "";
      const selected = selectedAppointment();
      const selectedDuration = selected && Number.isFinite(Number(selected.durationMinutes)) ? Number(selected.durationMinutes) : 60;
      const endIso = new Date(new Date(newIso).getTime() + selectedDuration * 60 * 1000).toISOString();
      const patchBody = {
        shop: shopValue(),
        appointmentAt: newIso,
        endAt: endIso,
        type: selected ? String(selected.type || "fitting") : "fitting",
        durationMinutes: selectedDuration,
        location: selectedRescheduleLocationValue(),
        status: "rescheduled",
        reminderD1Enabled: selected ? !!selected.reminderD1Enabled : true,
        reminderH3Enabled: selected ? !!selected.reminderH3Enabled : true,
        reminderDesignerEnabled: selected ? !!selected.reminderDesignerEnabled : true,
        notes: extraMessage ? [selected && selected.notes ? String(selected.notes) : "", extraMessage].filter(Boolean).join("\\n\\n") : undefined
      };

      const lockBtn = sendAfterUpdate ? rescheduleUpdateSendBtnEl : rescheduleOnlyBtnEl;
      if (lockBtn) lockBtn.disabled = true;
      try {
        const res = await fetch("/admin/api/appointments/" + encodeURIComponent(id), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patchBody)
        });
        const parsed = await readJsonSafe(res);
        if (!res.ok || !parsed.ok || !parsed.data || !parsed.data.ok) {
          if (res.status === 409 && rescheduleConflictErrorEl) {
            rescheduleConflictErrorEl.style.display = "block";
            rescheduleConflictErrorEl.textContent = String(parsed.ok && parsed.data && parsed.data.error ? parsed.data.error : "Conflit horaire.");
          }
          throw new Error(parsed.ok && parsed.data && parsed.data.error ? parsed.data.error : "Échec mise à jour replanification");
        }

        const shouldSend = !!(rescheduleSendToggleEl && rescheduleSendToggleEl.checked && sendAfterUpdate);
        if (shouldSend) {
          const sendRes = await fetch("/admin/api/appointments/" + encodeURIComponent(id) + "/send-template", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ shop: shopValue(), action: "reschedule" })
          });
          const sendParsed = await readJsonSafe(sendRes);
          if (!sendRes.ok || !sendParsed.ok || !sendParsed.data || !sendParsed.data.ok) {
            throw new Error(sendParsed.ok && sendParsed.data && sendParsed.data.error ? sendParsed.data.error : "Replanifié mais envoi WhatsApp échoué");
          }
        }

        closeRescheduleModal();
        showToast(shouldSend ? "Replanifié et message envoyé." : "Rendez-vous replanifié.", "success");
        await loadAppointments();
      } catch (error) {
        showToast(error instanceof Error ? error.message : "Erreur replanification", "error");
      } finally {
        if (lockBtn) lockBtn.disabled = false;
      }
    }

    async function deleteAppointment(id) {
      if (!id || !confirm("Supprimer ce rendez-vous ?")) return;
      try {
        const res = await fetch("/admin/api/appointments/" + encodeURIComponent(id), {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shop: shopValue() })
        });
        const parsed = await readJsonSafe(res);
        if (!res.ok || !parsed.ok || !parsed.data || !parsed.data.ok) {
          throw new Error(parsed.ok && parsed.data && parsed.data.error ? parsed.data.error : "Échec suppression");
        }
        if (String(selectedId) === String(id)) selectedId = "";
        showToast("Rendez-vous supprimé.", "success");
        await loadAppointments();
      } catch (error) {
        showToast(error instanceof Error ? error.message : "Erreur suppression", "error");
      }
    }

    async function syncMetafield() {
      try {
        const res = await fetch("/admin/api/appointments/sync-metafield", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shop: shopValue() })
        });
        const parsed = await readJsonSafe(res);
        if (!res.ok || !parsed.ok || !parsed.data || !parsed.data.ok) {
          throw new Error(parsed.ok && parsed.data && parsed.data.error ? parsed.data.error : "Échec sync metafield");
        }
        showToast("Metafield synchronisé.", "success");
      } catch (error) {
        showToast(error instanceof Error ? error.message : "Erreur sync", "error");
      }
    }

    if (openModalBtnEl) openModalBtnEl.addEventListener("click", openModal);
    if (closeModalBtnEl) closeModalBtnEl.addEventListener("click", closeModal);
    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.closest("#openModalBtn")) {
        event.preventDefault();
        openModal();
        return;
      }
      if (target.closest("#closeModalBtn")) {
        event.preventDefault();
        closeModal();
      }
    }, true);
    document.addEventListener("pointerup", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const openHit = target.closest("#openModalBtn");
      if (openHit instanceof HTMLElement) {
        event.preventDefault();
        openModal();
      }
      const closeHit = target.closest("#closeModalBtn");
      if (closeHit instanceof HTMLElement) {
        event.preventDefault();
        closeModal();
      }
    });
    if (modalEl) {
      modalEl.addEventListener("click", function(event) {
        if (event.target === modalEl) closeModal();
      });
    }
    if (closeRescheduleModalBtnEl) closeRescheduleModalBtnEl.addEventListener("click", closeRescheduleModal);
    if (rescheduleModalEl) {
      rescheduleModalEl.addEventListener("click", function(event) {
        if (event.target === rescheduleModalEl) closeRescheduleModal();
      });
    }
    if (rescheduleCustomToggleEl && rescheduleCustomWrapEl) {
      rescheduleCustomToggleEl.addEventListener("change", () => {
        rescheduleCustomWrapEl.style.display = rescheduleCustomToggleEl.checked ? "block" : "none";
      });
    }
    if (rescheduleCustomMessageInputEl && rescheduleCustomCountEl) {
      rescheduleCustomMessageInputEl.addEventListener("input", () => {
        rescheduleCustomCountEl.textContent = String((rescheduleCustomMessageInputEl.value || "").length) + " / 500";
      });
    }
    if (rescheduleOnlyBtnEl) rescheduleOnlyBtnEl.addEventListener("click", () => applyReschedule(false));
    if (rescheduleUpdateSendBtnEl) rescheduleUpdateSendBtnEl.addEventListener("click", () => applyReschedule(true));
    function bindHandlers() {
      if (closeCreateOrderModalBtnEl) closeCreateOrderModalBtnEl.addEventListener("click", closeCreateOrderModal);
      if (createOrderModalEl) {
        createOrderModalEl.addEventListener("click", function(event) {
          if (event.target === createOrderModalEl) closeCreateOrderModal();
        });
      }
      if (addCustomOrderLineBtnEl) addCustomOrderLineBtnEl.addEventListener("click", addCustomOrderLine);
      if (orderCancelWizardBtnEl) orderCancelWizardBtnEl.addEventListener("click", closeCreateOrderModal);
      if (orderContinueToPaymentBtnEl) {
        orderContinueToPaymentBtnEl.addEventListener("click", async () => {
          await openCartStep();
        });
      }
      if (orderBackToEditorBtnEl) {
        orderBackToEditorBtnEl.addEventListener("click", () => {
          clearOrderError();
          syncOrderStepUi("editor");
        });
      }
      if (orderBackTopBtnEl) {
        orderBackTopBtnEl.addEventListener("click", () => {
          clearOrderError();
          syncOrderStepUi("editor");
        });
      }
      if (orderConfirmOrderBtnEl) {
        orderConfirmOrderBtnEl.addEventListener("click", async () => {
          await submitOrderConfirmation();
        });
      }
      if (orderMobilePrimaryBtnEl) {
        orderMobilePrimaryBtnEl.addEventListener("click", async () => {
          if (orderSingleStepFlow || orderWizardStep === 1) {
            await openCartStep();
            return;
          }
          await submitOrderConfirmation();
        });
      }
      if (orderCustomTitleInputEl) {
        orderCustomTitleInputEl.addEventListener("input", () => syncOrderPrimaryActions());
        orderCustomTitleInputEl.addEventListener("blur", () => {
          hasAttemptedAddItem = true;
          syncOrderPrimaryActions();
        });
      }
      if (orderQtyMinusBtnEl) {
        orderQtyMinusBtnEl.addEventListener("click", () => {
          setOrderQty(currentOrderQty() - 1);
          syncOrderPrimaryActions();
        });
      }
      if (orderQtyPlusBtnEl) {
        orderQtyPlusBtnEl.addEventListener("click", () => {
          setOrderQty(currentOrderQty() + 1);
          syncOrderPrimaryActions();
        });
      }
      if (orderCustomPriceInputEl) {
        orderCustomPriceInputEl.addEventListener("input", () => {
          const raw = String(orderCustomPriceInputEl.value || "");
          orderCustomPriceInputEl.value = raw.replace(/[^0-9,.\s]/g, "");
          syncOrderPrimaryActions();
        });
        orderCustomPriceInputEl.addEventListener("blur", () => {
          hasAttemptedAddItem = true;
          writePriceCents(readPriceCents());
          syncOrderPrimaryActions();
        });
      }
      if (orderPaymentMethodSelectEl) {
        orderPaymentMethodSelectEl.addEventListener("change", () => {
          renderStickySummary();
          syncOrderPrimaryActions();
        });
      }
      if (orderMarkUnpaidBtnEl) {
        orderMarkUnpaidBtnEl.addEventListener("click", () => {
          orderForceUnpaid = !orderForceUnpaid;
          renderStickySummary();
        });
      }
      if (orderSplitFirstAmountInputEl) {
        orderSplitFirstAmountInputEl.addEventListener("input", () => {
          const raw = String(orderSplitFirstAmountInputEl.value || "");
          orderSplitFirstAmountInputEl.value = raw.replace(/[^0-9,.\s]/g, "");
          renderStickySummary();
          syncOrderPrimaryActions();
        });
      }
      if (orderSplitFirstMethodSelectEl) {
        orderSplitFirstMethodSelectEl.addEventListener("change", () => renderStickySummary());
      }
      if (orderSplitSecondMethodSelectEl) {
        orderSplitSecondMethodSelectEl.addEventListener("change", () => renderStickySummary());
      }
      if (orderSplitDueDateInputEl) {
        orderSplitDueDateInputEl.addEventListener("change", () => renderStickySummary());
      }
      if (orderProductSearchInputEl) {
        orderProductSearchInputEl.addEventListener("input", () => queueOrderProductSuggest(orderProductSearchInputEl.value));
      }
      if (orderProductSuggestBoxEl) {
        orderProductSuggestBoxEl.addEventListener("click", (event) => {
          const target = event.target;
          if (!(target instanceof HTMLElement)) return;
          const hit = target.closest("[data-order-product-suggest]");
          if (!(hit instanceof HTMLElement)) return;
          const idx = Number(hit.getAttribute("data-order-product-suggest") || "-1");
          if (!Number.isFinite(idx) || idx < 0 || idx >= orderProductSuggestions.length) return;
          const item = orderProductSuggestions[idx];
          orderLines.push({
            title: String(item.title || "Produit Shopify"),
            quantity: 1,
            price: Number(item.price || 0),
            variantId: Number(item.variantId || 0) || undefined
          });
          if (orderProductSearchInputEl) orderProductSearchInputEl.value = "";
          hideOrderProductSuggestions();
          renderStep1();
          renderStep2();
        });
      }
      if (createOrderModalEl) {
        createOrderModalEl.addEventListener("click", (event) => {
          const target = event.target;
          if (!(target instanceof HTMLElement)) return;
          const methodHit = target.closest("[data-order-payment-method]");
          if (methodHit instanceof HTMLElement && orderPaymentMethodSelectEl) {
            const requested = String(methodHit.getAttribute("data-order-payment-method") || "").trim();
            if (requested) {
              orderPaymentMethodSelectEl.value = requested;
              renderStickySummary();
              syncOrderPrimaryActions();
            }
            return;
          }
          const copyHit = target.closest("[data-copy-order-client]");
          if (copyHit instanceof HTMLElement) {
            const toCopy = String(copyHit.getAttribute("data-copy-order-client") || "").trim();
            if (!toCopy) return;
            copyTextToClipboard(toCopy).then((ok) => {
              showToast(ok ? "Copié." : "Copie impossible.", ok ? "success" : "error");
            });
            return;
          }
          const removeHit = target.closest("[data-remove-order-line]");
          if (removeHit instanceof HTMLElement) {
            const idx = Number(removeHit.getAttribute("data-remove-order-line") || "-1");
            if (Number.isFinite(idx) && idx >= 0 && idx < orderLines.length) {
              orderLines.splice(idx, 1);
              renderStep1();
              renderStep2();
            }
            return;
          }
          const qtyHit = target.closest("[data-order-qty-change]");
          if (qtyHit instanceof HTMLElement) {
            const idx = Number(qtyHit.getAttribute("data-order-qty-change") || "-1");
            const delta = Number(qtyHit.getAttribute("data-order-qty-delta") || "0");
            if (!Number.isFinite(idx) || idx < 0 || idx >= orderLines.length || !Number.isFinite(delta) || !delta) return;
            const line = orderLines[idx];
            line.quantity = Math.max(1, Math.min(999, Math.floor(Number(line.quantity || 1) + delta)));
            renderStep1();
            renderStep2();
          }
        });
      }
    }

    bindHandlers();

    if (refreshBtnEl) {
      refreshBtnEl.addEventListener("click", async () => {
        await loadLocations();
        await loadPaymentMethods();
        await loadAppointments();
        showToast("Données actualisées.", "success");
      });
    }
    if (darkModeToggleBtnEl) {
      darkModeToggleBtnEl.addEventListener("click", () => {
        toggleDarkMode();
      });
    }
    if (fullscreenBtnEl) {
      fullscreenBtnEl.addEventListener("click", () => {
        toggleFullscreenMode();
      });
    }
    document.addEventListener("fullscreenchange", syncFullscreenButtonLabel);

    if (syncMetaBtnEl) syncMetaBtnEl.addEventListener("click", syncMetafield);

    if (shopInputEl) {
      shopInputEl.addEventListener("change", async () => {
        await loadLocations();
        await loadPaymentMethods();
        await loadAppointments();
      });
    }
    if (createOnlyBtnEl) createOnlyBtnEl.addEventListener("click", () => createAppointment(false));
    if (createAndSendBtnEl) createAndSendBtnEl.addEventListener("click", () => createAppointment(true));

    if (typeInputEl && durationInputEl) {
      typeInputEl.addEventListener("change", () => {
        durationInputEl.value = String(defaultDurationByType(typeInputEl.value));
        const windowData = readCreateWindow();
        if (endAtInputEl) endAtInputEl.value = toDateTimeLocalValue(windowData.endAt);
      });
    }
    if (atInputEl) {
      atInputEl.addEventListener("change", () => {
        applyEndOneHourAfterStart();
      });
    }
    if (durationInputEl) {
      durationInputEl.addEventListener("change", () => {
        const windowData = readCreateWindow();
        if (endAtInputEl) endAtInputEl.value = toDateTimeLocalValue(windowData.endAt);
      });
    }
    if (quickDateTimeWrapEl) {
      quickDateTimeWrapEl.addEventListener("click", (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const dateBtn = target.closest("[data-quick-date]");
        if (dateBtn instanceof HTMLElement) {
          const days = Number(dateBtn.getAttribute("data-quick-date") || "0");
          applyQuickDate(days);
          return;
        }
        const timeBtn = target.closest("[data-quick-time]");
        if (timeBtn instanceof HTMLElement) {
          const hhmm = String(timeBtn.getAttribute("data-quick-time") || "");
          applyQuickTime(hhmm);
        }
      });
    }
    if (typeFilterSelectEl) {
      typeFilterSelectEl.addEventListener("change", () => {
        loadAppointments();
      });
    }
    if (viewListBtnEl) viewListBtnEl.addEventListener("click", () => { activeView = "list"; applyViewMode(); });
    if (viewCalendarBtnEl) viewCalendarBtnEl.addEventListener("click", () => { activeView = "calendar"; applyViewMode(); });
    if (calendarPrevWeekBtnEl) {
      calendarPrevWeekBtnEl.addEventListener("click", () => {
        calendarWeekStart = new Date(calendarWeekStart.getTime() - 7 * 24 * 60 * 60 * 1000);
        renderCalendarView();
      });
    }
    if (calendarNextWeekBtnEl) {
      calendarNextWeekBtnEl.addEventListener("click", () => {
        calendarWeekStart = new Date(calendarWeekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
        renderCalendarView();
      });
    }

    if (notesInputEl && notesCountEl) {
      notesInputEl.addEventListener("input", () => {
        notesCountEl.textContent = String((notesInputEl.value || "").length) + " / 500";
      });
    }
    if (createNotesToggleEl) {
      createNotesToggleEl.addEventListener("change", syncCreateNotesVisibility);
    }

    if (customerNameInputEl) customerNameInputEl.addEventListener("input", () => queueCustomerSuggest(customerNameInputEl.value));
    if (phoneInputEl) phoneInputEl.addEventListener("input", () => queueCustomerSuggest(phoneInputEl.value));
    if (emailInputEl) emailInputEl.addEventListener("input", () => queueCustomerSuggest(emailInputEl.value));

    if (customerSuggestBoxEl) {
      customerSuggestBoxEl.addEventListener("click", (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const rowEl = target.closest("[data-suggest]");
        if (!(rowEl instanceof HTMLElement)) return;
        const index = Number(rowEl.getAttribute("data-suggest") || "-1");
        if (!Number.isFinite(index) || index < 0 || index >= customerSuggestions.length) return;
        applySuggestedCustomer(customerSuggestions[index]);
      });
    }

    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const openModalHit = target.closest("#openModalBtn");
      if (openModalHit instanceof HTMLElement) {
        event.preventDefault();
        openModal();
        return;
      }
      const closeModalHit = target.closest("#closeModalBtn");
      if (closeModalHit instanceof HTMLElement) {
        event.preventDefault();
        closeModal();
        return;
      }
      if (!target.closest("#customerNameInput") && !target.closest("#customerSuggestBox")) {
        hideCustomerSuggestions();
      }
      if (!target.closest("#orderProductSearchInput") && !target.closest("#orderProductSuggestBox")) {
        hideOrderProductSuggestions();
      }
      if (!target.closest(".menu-cell")) closeMenus();
    });

    if (appointmentsBodyEl) {
      appointmentsBodyEl.addEventListener("click", (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;

        const menuBtn = target.closest("[data-menu-btn]");
        if (menuBtn instanceof HTMLElement) {
          const id = menuBtn.getAttribute("data-menu-btn") || "";
          const menu = document.getElementById("menu-" + id);
          if (menu) {
            const isOpen = menu.style.display === "block";
            closeMenus();
            menu.style.display = isOpen ? "none" : "block";
          }
          return;
        }

        const menuAction = target.closest("[data-menu-action]");
        if (menuAction instanceof HTMLElement) {
          const action = menuAction.getAttribute("data-menu-action") || "";
          const id = menuAction.getAttribute("data-id") || "";
          closeMenus();
          if (action === "view") {
            selectedId = id;
            renderAll();
            if (selectedId) void loadTimelineForAppointment(selectedId);
            return;
          }
          if (action === "confirm" || action === "reminder") {
            const rowForAction = appointments.find((r) => String(r.id) === String(id)) || null;
            runContextAction(action, rowForAction);
            return;
          }
          if (action === "delete") {
            deleteAppointment(id);
            return;
          }
          return;
        }

        const row = target.closest("[data-row-id]");
        if (row instanceof HTMLElement) {
          selectedId = row.getAttribute("data-row-id") || "";
          renderAll();
          if (selectedId) void loadTimelineForAppointment(selectedId);
        }
      });
    }

    if (ctxStatusEl) {
      ctxStatusEl.addEventListener("change", () => {
        const row = selectedAppointment();
        if (!row) return;
        updateStatus(row.id, ctxStatusEl.value);
      });
    }
    if (ctxTypeEl) {
      ctxTypeEl.addEventListener("change", () => {
        const row = selectedAppointment();
        if (!row) return;
        const nextType = String(ctxTypeEl.value || "fitting");
        const nextDuration = defaultDurationByType(nextType);
        const nextEnd = new Date(new Date(row.appointmentAt).getTime() + nextDuration * 60 * 1000).toISOString();
        updateAppointmentPatch(row.id, { type: nextType, durationMinutes: nextDuration, endAt: nextEnd }, "Type mis à jour.");
      });
    }
    if (ctxNotesInputEl && ctxNotesCountEl) {
      ctxNotesInputEl.addEventListener("input", () => {
        ctxNotesCountEl.textContent = String((ctxNotesInputEl.value || "").length) + " / 500";
      });
    }
    if (ctxNotesSaveBtnEl) {
      ctxNotesSaveBtnEl.addEventListener("click", () => {
        const row = selectedAppointment();
        if (!row) return;
        const value = String(ctxNotesInputEl && ctxNotesInputEl.value ? ctxNotesInputEl.value : "").trim();
        updateAppointmentPatch(row.id, { notes: value || "" }, "Notes mises à jour.");
      });
    }
    if (ctxReminderD1El) {
      ctxReminderD1El.addEventListener("change", () => {
        const row = selectedAppointment();
        if (!row) return;
        updateAppointmentPatch(row.id, { reminderD1Enabled: !!ctxReminderD1El.checked }, "Rappel J-1 mis à jour.");
      });
    }
    if (ctxReminderH3El) {
      ctxReminderH3El.addEventListener("change", () => {
        const row = selectedAppointment();
        if (!row) return;
        updateAppointmentPatch(row.id, { reminderH3Enabled: !!ctxReminderH3El.checked }, "Rappel H-3 mis à jour.");
      });
    }
    if (ctxReminderDesignerEl) {
      ctxReminderDesignerEl.addEventListener("change", () => {
        const row = selectedAppointment();
        if (!row) return;
        updateAppointmentPatch(row.id, { reminderDesignerEnabled: !!ctxReminderDesignerEl.checked }, "Rappel designer 08:30 mis à jour.");
      });
    }
    if (ctxReminderDesignerSendBtnEl) {
      ctxReminderDesignerSendBtnEl.addEventListener("click", () => {
        const row = selectedAppointment();
        if (!row) return;
        sendDesignerReminderFor(row.id);
      });
    }

    if (contextContentEl) {
      contextContentEl.addEventListener("click", (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        if (target.closest("#ctxCreateOrderBtn")) {
          const rowForOrder = selectedAppointment();
          if (rowForOrder) openCreateOrderModalFor(rowForOrder.id);
          return;
        }
        if (target.closest("#ctxViewOrderStatusBtn")) {
          const rowForOrderStatus = selectedAppointment();
          if (rowForOrderStatus) void openOrderStatusModalFor(rowForOrderStatus);
          return;
        }
        const action = target.getAttribute("data-ctx-action") || "";
        if (!action) return;
        const row = selectedAppointment();
        if (!row) return;
        runContextAction(action, row);
      });
    }
    if (ctxTopActionReminderEl) {
      ctxTopActionReminderEl.addEventListener("click", () => {
        runContextAction("reminder", selectedAppointment());
      });
    }
    if (ctxTopActionRescheduleEl) {
      ctxTopActionRescheduleEl.addEventListener("click", () => {
        runContextAction("reschedule", selectedAppointment());
      });
    }
    if (ctxTopActionCompleteEl) {
      ctxTopActionCompleteEl.addEventListener("click", () => {
        runContextAction("complete", selectedAppointment());
      });
    }

    if (closeDrawerBtnEl && contextPanelEl) {
      closeDrawerBtnEl.addEventListener("click", () => contextPanelEl.classList.remove("open"));
    }

    if (calendarGridEl) {
      calendarGridEl.addEventListener("click", (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const hit = target.closest("[data-calendar-id]");
        if (!(hit instanceof HTMLElement)) return;
        selectedId = String(hit.getAttribute("data-calendar-id") || "");
        renderAll();
        if (selectedId) void loadTimelineForAppointment(selectedId);
      });
    }

    if (modalEl) {
      modalEl.classList.remove("open");
      modalEl.style.display = "none";
      modalEl.setAttribute("aria-hidden", "true");
    }
    if (rescheduleModalEl) {
      rescheduleModalEl.classList.remove("open");
      rescheduleModalEl.style.display = "none";
      rescheduleModalEl.setAttribute("aria-hidden", "true");
    }
    if (createOrderModalEl) {
      createOrderModalEl.classList.remove("open");
      createOrderModalEl.style.display = "none";
      createOrderModalEl.setAttribute("aria-hidden", "true");
    }
    if (shopInputEl && !String(shopInputEl.value || "").trim()) {
      const qsShop = new URLSearchParams(window.location.search).get("shop") || "";
      if (qsShop) shopInputEl.value = qsShop;
    }

    loadLocations();
    loadPaymentMethods();
    loadAppointments();
    syncDarkModeButtonLabel();
    syncFullscreenButtonLabel();
  </script>
</body>
</html>`);
});

function RendezVousV2(req: Request, res: Response) {
  const params = new URLSearchParams();
  const host = typeof req.query.host === "string" ? req.query.host : "";
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  const embedded = typeof req.query.embedded === "string" ? req.query.embedded : "";
  if (host) params.set("host", host);
  if (shop) params.set("shop", shop);
  if (embedded) params.set("embedded", embedded);
  params.set("v", "2");
  return res.redirect(`/admin/appointments?${params.toString()}`);
}

adminRouter.get("/appointments-v2", RendezVousV2);

async function getShopCurrencyCode(shop: string): Promise<string> {
  const safeShop = String(shop || "").trim().toLowerCase();
  if (!safeShop || !safeShop.endsWith(".myshopify.com")) return "MAD";
  try {
    const token = await getShopifyAdminToken(safeShop);
    const res = await fetch(`https://${safeShop}/admin/api/2026-01/shop.json`, {
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token
      }
    });
    const raw = await res.text();
    let parsed: { shop?: { currency?: string } } | null = null;
    try {
      parsed = JSON.parse(raw) as { shop?: { currency?: string } };
    } catch {
      parsed = null;
    }
    const currency = String(parsed?.shop?.currency || "").trim().toUpperCase();
    return currency || "MAD";
  } catch {
    return "MAD";
  }
}

adminRouter.get("/api/appointments", async (req, res) => {
  try {
    const shop = resolveShopFromRequest(req);
    const limitRaw = Number(req.query.limit ?? 300);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(1000, Math.floor(limitRaw))) : 300;
    const typeFilterRaw = String(req.query.type || "").trim().toLowerCase();
    const typeFilter: AppointmentType | "all" =
      typeFilterRaw && typeFilterRaw !== "all" && appointmentTypeSchema.safeParse(typeFilterRaw).success
        ? (typeFilterRaw as AppointmentType)
        : "all";
    const appointments = await listAppointmentsByShop(shop, limit, { type: typeFilter });
    return res.status(200).json({ ok: true, shop, appointments });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur lecture rendez-vous";
    return res.status(400).json({ ok: false, error: message });
  }
});

adminRouter.get("/api/appointments/customer-suggest", async (req, res) => {
  let shop = "";
  try {
    shop = resolveShopFromRequest(req);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Shop invalide";
    return res.status(400).json({ ok: false, error: message });
  }

  const query = String(req.query.q || "").trim();
  if (query.length < 1) {
    return res.status(200).json({ ok: true, suggestions: [] });
  }

  try {
    const suggestions = await suggestShopifyCustomers({
      shop,
      query,
      limit: 7
    });
    return res.status(200).json({ ok: true, suggestions });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur suggestion client";
    return res.status(500).json({ ok: false, error: message });
  }
});

adminRouter.get("/api/appointments/locations", async (req, res) => {
  let shop = "";
  try {
    shop = resolveShopFromRequest(req);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Shop invalide";
    return res.status(400).json({ ok: false, error: message });
  }

  try {
    const [locations, currency] = await Promise.all([
      listShopifyPointsOfSale(shop),
      getShopCurrencyCode(shop)
    ]);
    return res.status(200).json({ ok: true, locations, currency });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur chargement points de vente";
    return res.status(500).json({ ok: false, error: message });
  }
});

adminRouter.get("/api/appointments/payment-methods", async (req, res) => {
  let shop = "";
  try {
    shop = resolveShopFromRequest(req);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Shop invalide";
    return res.status(400).json({ ok: false, error: message });
  }

  try {
    const token = await getShopifyAdminToken(shop);
    const ordersRes = await fetch(
      `https://${shop}/admin/api/2026-01/orders.json?status=any&limit=250&fields=payment_gateway_names,transactions`,
      {
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token
        }
      }
    );
    const raw = await ordersRes.text();
    let parsed: { orders?: Array<Record<string, unknown>> } | null = null;
    try {
      parsed = JSON.parse(raw) as { orders?: Array<Record<string, unknown>> };
    } catch {
      parsed = null;
    }
    if (!ordersRes.ok || !parsed || !Array.isArray(parsed.orders)) {
      return res.status(502).json({ ok: false, error: "Échec lecture moyens de paiement Shopify." });
    }

    const gateways = new Set<string>();
    parsed.orders.forEach((order) => {
      const names = Array.isArray(order.payment_gateway_names) ? order.payment_gateway_names : [];
      names.forEach((name) => {
        const value = String(name || "").trim();
        if (value) gateways.add(value);
      });
      const txs = Array.isArray(order.transactions) ? order.transactions : [];
      txs.forEach((tx) => {
        if (!tx || typeof tx !== "object") return;
        const value = String((tx as { gateway?: unknown }).gateway || "").trim();
        if (value) gateways.add(value);
      });
    });

    const methods: Array<{ code: "cash" | "cheque" | "bank_transfer" | "card" | "installment"; label: string }> = [];
    const addMethod = (code: "cash" | "cheque" | "bank_transfer" | "card" | "installment", label: string) => {
      if (!methods.some((m) => m.code === code)) methods.push({ code, label });
    };

    const normalize = (value: string): "cash" | "cheque" | "bank_transfer" | "card" | null => {
      const text = String(value || "").toLowerCase();
      if (!text) return null;
      if (/cash|esp[eè]ce/.test(text)) return "cash";
      if (/ch[eè]que|check|chq/.test(text)) return "cheque";
      if (/virement|bank|transfer|wire/.test(text)) return "bank_transfer";
      if (/card|carte|visa|master|amex|stripe|shopify payments/.test(text)) return "card";
      return null;
    };

    Array.from(gateways).forEach((gateway) => {
      const code = normalize(gateway);
      if (!code) return;
      const label =
        code === "cash"
          ? "Espèces"
          : code === "cheque"
            ? "Chèque"
            : code === "bank_transfer"
              ? "Virement bancaire"
              : "Carte bancaire";
      addMethod(code, label);
    });

    if (!methods.length) {
      addMethod("cash", "Espèces");
      addMethod("cheque", "Chèque");
      addMethod("bank_transfer", "Virement bancaire");
      addMethod("card", "Carte bancaire");
    }
    addMethod("installment", "Paiement divisé");

    return res.status(200).json({ ok: true, methods });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur chargement moyens de paiement Shopify";
    return res.status(500).json({ ok: false, error: message });
  }
});

adminRouter.get("/api/appointments/:appointmentId/messages", async (req, res) => {
  let shop = "";
  try {
    shop = resolveShopFromRequest(req);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Shop invalide";
    return res.status(400).json({ ok: false, error: message });
  }
  try {
    const rows = await listAppointmentMessages(shop, String(req.params.appointmentId || ""), 120);
    return res.status(200).json({ ok: true, messages: rows });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur lecture messages";
    return res.status(500).json({ ok: false, error: message });
  }
});

adminRouter.get("/api/appointments/product-suggest", async (req, res) => {
  let shop = "";
  try {
    shop = resolveShopFromRequest(req);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Shop invalide";
    return res.status(400).json({ ok: false, error: message });
  }

  const queryText = String(req.query.q || "").trim();
  if (queryText.length < 1) {
    return res.status(200).json({ ok: true, suggestions: [] });
  }

  try {
    const token = await getShopifyAdminToken(shop);
    const gqlRes = await fetch(`https://${shop}/admin/api/2026-01/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token
      },
      body: JSON.stringify({
        query: `
          query ProductSuggest($q: String!) {
            products(first: 12, query: $q) {
              edges {
                node {
                  id
                  title
                  variants(first: 3) {
                    edges {
                      node {
                        id
                        title
                        price
                      }
                    }
                  }
                }
              }
            }
          }
        `,
        variables: { q: `title:*${queryText.replace(/"/g, "")}*` }
      })
    });
    const raw = await gqlRes.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      parsed = null;
    }
    if (!gqlRes.ok || !parsed || typeof parsed !== "object") {
      return res.status(502).json({ ok: false, error: `Erreur recherche produits (${gqlRes.status}).` });
    }
    const dataObj = (parsed as { data?: unknown; errors?: unknown }).data as
      | { products?: { edges?: Array<{ node?: { title?: string; variants?: { edges?: Array<{ node?: { id?: string; title?: string; price?: string } }> } } }> } }
      | undefined;
    const edges = Array.isArray(dataObj?.products?.edges) ? dataObj.products.edges : [];
    const suggestions = edges.flatMap((edge) => {
      const node = edge && edge.node ? edge.node : null;
      if (!node) return [];
      const variants = Array.isArray(node.variants?.edges) ? node.variants.edges : [];
      return variants.map((variantEdge) => {
        const variant = variantEdge && variantEdge.node ? variantEdge.node : null;
        const variantId = extractNumericShopifyId(variant?.id);
        if (!variantId) return null;
        const label = String(variant?.title || "Default Title").trim();
        return {
          variantId,
          title: label && label.toLowerCase() !== "default title" ? `${String(node.title || "").trim()} - ${label}` : String(node.title || "").trim(),
          price: Number(variant?.price || 0)
        };
      }).filter(Boolean);
    }).filter(Boolean);
    return res.status(200).json({ ok: true, suggestions });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur recherche produits";
    return res.status(500).json({ ok: false, error: message });
  }
});

adminRouter.post("/api/appointments", async (req, res) => {
  const parsed = appointmentCreateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: "Données rendez-vous invalides." });
  }

  let shop = "";
  try {
    shop = resolveShopFromRequest(req);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Shop invalide";
    return res.status(400).json({ ok: false, error: message });
  }

  try {
    const window = resolveAppointmentWindow(
      parsed.data.appointmentAt,
      parsed.data.type,
      parsed.data.durationMinutes,
      parsed.data.endAt
    );
    const conflict = await findAppointmentConflict(
      shop,
      parsed.data.location ?? null,
      window.appointmentAt,
      window.endAt
    );
    if (conflict) {
      return res.status(409).json({
        ok: false,
        error: "Conflit horaire: ce point de vente a déjà un rendez-vous sur ce créneau.",
        conflict
      });
    }

    const customerSync = await ensureShopifyCustomerForAppointment({
      shop,
      customerName: parsed.data.customerName,
      customerPhone: parsed.data.customerPhone,
      customerEmail: parsed.data.customerEmail ?? null
    });

    const appointment = await createAppointment({
      shop,
      customerName: parsed.data.customerName,
      customerPhone: parsed.data.customerPhone,
      customerEmail: parsed.data.customerEmail ?? null,
      appointmentAt: window.appointmentAt,
      endAt: window.endAt,
      type: window.type,
      durationMinutes: window.durationMinutes,
      status: parsed.data.status,
      location: parsed.data.location ?? null,
      notes: parsed.data.notes ?? null,
      reminderD1Enabled: parsed.data.reminderD1Enabled,
      reminderH3Enabled: parsed.data.reminderH3Enabled,
      reminderDesignerEnabled: parsed.data.reminderDesignerEnabled
    });
    if (!appointment) {
      return res.status(503).json({ ok: false, error: "Base de données indisponible pour créer le rendez-vous." });
    }
    console.log(
      `[appointments] Shopify customer ${customerSync.created ? "created" : "matched"} (${customerSync.customerId}) for shop ${shop}.`
    );
    void syncAppointmentsMetafieldForShop(shop);
    return res.status(200).json({
      ok: true,
      appointment,
      shopifyCustomer: {
        id: customerSync.customerId,
        created: customerSync.created
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur création rendez-vous";
    return res.status(500).json({ ok: false, error: message });
  }
});

adminRouter.put("/api/appointments/:appointmentId", async (req, res) => {
  const parsed = appointmentUpdateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: "Données de mise à jour invalides." });
  }

  let shop = "";
  try {
    shop = resolveShopFromRequest(req);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Shop invalide";
    return res.status(400).json({ ok: false, error: message });
  }

  try {
    const existing = await getAppointmentById(shop, req.params.appointmentId);
    if (!existing) return res.status(404).json({ ok: false, error: "Rendez-vous introuvable." });

    const window = resolveAppointmentWindow(
      parsed.data.appointmentAt ?? existing.appointmentAt,
      parsed.data.type ?? existing.type,
      parsed.data.durationMinutes ?? existing.durationMinutes,
      parsed.data.endAt ?? existing.endAt
    );
    const nextLocation = parsed.data.location ?? existing.location;
    const conflict = await findAppointmentConflict(shop, nextLocation ?? null, window.appointmentAt, window.endAt, existing.id);
    if (conflict) {
      return res.status(409).json({
        ok: false,
        error: "Conflit horaire: ce point de vente a déjà un rendez-vous sur ce créneau.",
        conflict
      });
    }

    const updated = await updateAppointment(shop, req.params.appointmentId, {
      customerName: parsed.data.customerName,
      customerPhone: parsed.data.customerPhone,
      customerEmail: parsed.data.customerEmail,
      appointmentAt: window.appointmentAt,
      endAt: window.endAt,
      type: window.type,
      durationMinutes: window.durationMinutes,
      status: parsed.data.status,
      location: parsed.data.location,
      notes: parsed.data.notes,
      lastMessageAt: parsed.data.lastMessageAt,
      orderId: parsed.data.orderId,
      orderName: parsed.data.orderName,
      orderTotalAmount: parsed.data.orderTotalAmount,
      orderCurrency: parsed.data.orderCurrency,
      reminderD1Enabled: parsed.data.reminderD1Enabled,
      reminderH3Enabled: parsed.data.reminderH3Enabled,
      reminderDesignerEnabled: parsed.data.reminderDesignerEnabled,
      reminderD1SentAt: parsed.data.reminderD1SentAt,
      reminderH3SentAt: parsed.data.reminderH3SentAt,
      reminderDesignerSentAt: parsed.data.reminderDesignerSentAt
    });
    if (!updated) return res.status(404).json({ ok: false, error: "Rendez-vous introuvable." });
    void syncAppointmentsMetafieldForShop(shop);
    return res.status(200).json({ ok: true, appointment: updated });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur mise à jour rendez-vous";
    return res.status(500).json({ ok: false, error: message });
  }
});

adminRouter.delete("/api/appointments/:appointmentId", async (req, res) => {
  let shop = "";
  try {
    shop = resolveShopFromRequest(req);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Shop invalide";
    return res.status(400).json({ ok: false, error: message });
  }

  try {
    const removed = await deleteAppointment(shop, req.params.appointmentId);
    if (!removed) return res.status(404).json({ ok: false, error: "Rendez-vous introuvable." });
    void syncAppointmentsMetafieldForShop(shop);
    return res.status(200).json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur suppression rendez-vous";
    return res.status(500).json({ ok: false, error: message });
  }
});

adminRouter.post("/api/appointments/sync-metafield", async (req, res) => {
  let shop = "";
  try {
    shop = resolveShopFromRequest(req);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Shop invalide";
    return res.status(400).json({ ok: false, error: message });
  }

  try {
    const rows = await listAppointmentsForMetafield(shop, 200);
    const syncResult = await syncAppointmentsMetafield(shop, rows);
    if (!syncResult.ok) {
      return res.status(502).json({ ok: false, error: syncResult.error || "Échec sync metafield Shopify." });
    }
    return res.status(200).json({ ok: true, synced: rows.length, metafieldId: syncResult.metafieldId || null });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur sync metafield Shopify";
    return res.status(500).json({ ok: false, error: message });
  }
});

adminRouter.post("/api/appointments/:appointmentId/send-template", async (req, res) => {
  if (!env.ZOKO_API_URL || !env.ZOKO_AUTH_TOKEN) {
    return res.status(400).json({
      ok: false,
      error: "Configuration Zoko manquante. Ajoutez ZOKO_API_URL et ZOKO_AUTH_TOKEN."
    });
  }

  const parsed = appointmentSendTemplateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: "Action template invalide." });
  }

  let shop = "";
  try {
    shop = resolveShopFromRequest(req);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Shop invalide";
    return res.status(400).json({ ok: false, error: message });
  }

  try {
    const appointment = await getAppointmentById(shop, req.params.appointmentId);
    if (!appointment) {
      return res.status(404).json({ ok: false, error: "Rendez-vous introuvable." });
    }
    const sendResult = await sendAppointmentTemplate({ appointment, action: parsed.data.action });
    if (!sendResult.ok) {
      return res.status(502).json({
        ok: false,
        error: sendResult.error || "Envoi template API échoué.",
        status: sendResult.status || 0,
        providerResponse: sendResult.providerResponse || null
      });
    }

    const updated = await updateAppointment(shop, appointment.id, {
      status: appointmentActionToStatus(parsed.data.action),
      lastMessageAt: new Date().toISOString()
    });
    await addAppointmentMessage({
      appointmentId: appointment.id,
      shop,
      direction: "outbound",
      channel: "whatsapp",
      messageType: parsed.data.action,
      templateName: sendResult.usedTemplate || appointmentActionTemplateName(parsed.data.action),
      payload: sendResult.providerResponse || null,
      providerStatus: "sent",
      sentAt: new Date().toISOString()
    });
    void syncAppointmentsMetafieldForShop(shop);

    return res.status(200).json({
      ok: true,
      appointment: updated,
      usedTemplate: sendResult.usedTemplate,
      usedLanguage: sendResult.usedLanguage,
      providerResponse: sendResult.providerResponse || null
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur envoi template rendez-vous";
    return res.status(500).json({ ok: false, error: message });
  }
});

adminRouter.post("/api/appointments/:appointmentId/send-designer-reminder", async (req, res) => {
  if (!env.ZOKO_API_URL || !env.ZOKO_AUTH_TOKEN) {
    return res.status(400).json({
      ok: false,
      error: "Configuration Zoko manquante. Ajoutez ZOKO_API_URL et ZOKO_AUTH_TOKEN."
    });
  }

  let shop = "";
  try {
    shop = resolveShopFromRequest(req);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Shop invalide";
    return res.status(400).json({ ok: false, error: message });
  }

  try {
    const appointment = await getAppointmentById(shop, req.params.appointmentId);
    if (!appointment) {
      return res.status(404).json({ ok: false, error: "Rendez-vous introuvable." });
    }
    const sendResult = await sendDesignerReminderTemplate({
      id: appointment.id,
      customerName: appointment.customerName,
      customerPhone: appointment.customerPhone,
      appointmentAt: appointment.appointmentAt,
      location: appointment.location
    });
    if (!sendResult.ok) {
      return res.status(502).json({
        ok: false,
        error: sendResult.error || "Envoi rappel designer échoué.",
        status: sendResult.status || 0,
        providerResponse: sendResult.providerResponse || null
      });
    }
    const sentAtIso = new Date().toISOString();
    const updated = await updateAppointment(shop, appointment.id, {
      reminderDesignerSentAt: sentAtIso,
      lastMessageAt: sentAtIso
    });
    await addAppointmentMessage({
      appointmentId: appointment.id,
      shop,
      direction: "outbound",
      channel: "whatsapp",
      messageType: "designer_reminder_830",
      templateName:
        sendResult.usedTemplate || String(env.ZOKO_APPOINTMENT_DESIGNER_REMINDER_TEMPLATE_NAME || "").trim(),
      payload: {
        recipient: normalizePhoneForApi(String(env.ZOKO_APPOINTMENT_DESIGNER_REMINDER_PHONE || "")),
        provider: sendResult.providerResponse || null
      },
      providerStatus: "sent",
      sentAt: sentAtIso
    });
    void syncAppointmentsMetafieldForShop(shop);

    return res.status(200).json({
      ok: true,
      appointment: updated,
      usedTemplate: sendResult.usedTemplate,
      usedLanguage: sendResult.usedLanguage,
      providerResponse: sendResult.providerResponse || null
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur envoi rappel designer";
    return res.status(500).json({ ok: false, error: message });
  }
});

adminRouter.post("/api/appointments/:appointmentId/create-order", async (req, res) => {
  const parsedBody = appointmentCreateOrderSchema.safeParse(req.body ?? {});
  if (!parsedBody.success) {
    return res.status(400).json({ ok: false, error: "Données de commande invalides (lineItems)." });
  }

  let shop = "";
  try {
    shop = resolveShopFromRequest(req);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Shop invalide";
    return res.status(400).json({ ok: false, error: message });
  }

  try {
    const appointment = await getAppointmentById(shop, req.params.appointmentId);
    if (!appointment) return res.status(404).json({ ok: false, error: "Rendez-vous introuvable." });
    if (appointment.orderId) {
      return res.status(200).json({
        ok: true,
        appointment,
        order: {
          id: appointment.orderId,
          name: appointment.orderName || appointment.orderId,
          totalAmount: appointment.orderTotalAmount ?? null,
          currency: appointment.orderCurrency || "MAD",
          url: `https://${shop}/admin/orders/${appointment.orderId}`
        }
      });
    }

    const token = await getShopifyAdminToken(shop);
    const [firstName = appointment.customerName, ...rest] = String(appointment.customerName || "").split(" ");
    const lastName = rest.join(" ").trim() || undefined;
    const label = appointment.type ? appointment.type.replace(/_/g, " ") : "appointment";
    const paymentMethodRaw = String(parsedBody.data.paymentMethod || "cash");
    const markUnpaid = parsedBody.data.markUnpaid === true;
    const paymentBreakdown = parsedBody.data.paymentBreakdown;
    const installmentRequested = paymentMethodRaw === "installment" || parsedBody.data.payment_type === "installment";
    const paymentMethod = installmentRequested ? "installment" : paymentMethodRaw;
    const paymentMethodLabelMap: Record<string, string> = {
      cash: "Espèces",
      cheque: "Chéquier",
      bank_transfer: "Virement bancaire",
      card: "Carte bancaire",
      split: "Paiement échelonné",
      installment: "Paiement échelonné"
    };
    const paymentMethodLabel = paymentMethodLabelMap[paymentMethod] || "Espèces";
    const shopifyPosLocation = String(appointment.location || "").trim() || "En ligne";
    const requestedLines = Array.isArray(parsedBody.data.lineItems) ? parsedBody.data.lineItems : [];
    const hasVariantLine = requestedLines.some((line) => {
      const variantId = extractNumericShopifyId(line && line.variantId);
      return !!variantId;
    });
    const estimatedTotalFromRequest = requestedLines.reduce((sum, line) => {
      const qty = Math.max(1, Math.floor(Number(line && line.quantity ? line.quantity : 1)));
      const variantId = extractNumericShopifyId(line && line.variantId);
      if (variantId) return sum;
      const price = Number(line && line.price ? line.price : 0);
      if (!Number.isFinite(price) || price < 0) return sum;
      return sum + qty * price;
    }, 0);
    if (!hasVariantLine && !(estimatedTotalFromRequest > 0)) {
      return res.status(400).json({ ok: false, error: "Total invalide: ajoutez au moins un article > 0." });
    }
    const installmentPlan = installmentRequested
      ? {
          depositAmount: Math.max(
            0,
            Number(
              parsedBody.data.deposit_amount ??
              (paymentBreakdown ? paymentBreakdown.firstAmount : 0) ??
              0
            )
          ),
          depositMethod: String(
            parsedBody.data.deposit_method ||
            (paymentBreakdown && paymentBreakdown.firstMethod ? paymentBreakdown.firstMethod : "cash")
          ),
          remainingMethod: String(
            parsedBody.data.remaining_method ||
            (paymentBreakdown && paymentBreakdown.secondMethod ? paymentBreakdown.secondMethod : "")
          ).trim() || null,
          remainingDueDate: String(
            parsedBody.data.remaining_due_date ||
            (paymentBreakdown && paymentBreakdown.remainingDueDate ? paymentBreakdown.remainingDueDate : "")
          ).trim() || null
        }
      : null;
    if (installmentPlan && !(installmentPlan.depositAmount > 0)) {
      return res.status(400).json({ ok: false, error: "Paiement 1 invalide: montant requis (> 0)." });
    }
    if (installmentPlan && !hasVariantLine && installmentPlan.depositAmount > estimatedTotalFromRequest) {
      return res.status(400).json({ ok: false, error: "Paiement 1 invalide: supérieur au total." });
    }
    const installmentRemainingFromRequest = installmentPlan
      ? Math.max(
          0,
          Number(
            parsedBody.data.remaining_amount ??
            (paymentBreakdown ? paymentBreakdown.secondAmount : 0) ??
            Math.max(0, estimatedTotalFromRequest - installmentPlan.depositAmount)
          )
        )
      : 0;
    const paymentNoteSuffix = installmentPlan
      ? ` · Paiement 1: ${installmentPlan.depositAmount.toFixed(2)} MAD via ${(paymentMethodLabelMap[installmentPlan.depositMethod] || installmentPlan.depositMethod)} · Solde: ${installmentRemainingFromRequest.toFixed(2)} MAD${installmentPlan.remainingMethod ? ` via ${(paymentMethodLabelMap[installmentPlan.remainingMethod] || installmentPlan.remainingMethod)}` : ""}${installmentPlan.remainingDueDate ? ` · Échéance: ${installmentPlan.remainingDueDate}` : ""}`
      : paymentMethod === "split" && paymentBreakdown
        ? ` · Split P1: ${Number(paymentBreakdown.firstAmount || 0).toFixed(2)} MAD via ${(paymentMethodLabelMap[paymentBreakdown.firstMethod || "cash"] || "Espèces")} · P2: ${Number(paymentBreakdown.secondAmount || 0).toFixed(2)} MAD via ${(paymentMethodLabelMap[paymentBreakdown.secondMethod || "cash"] || "Espèces")}`
        : "";
    const orderNote = `Created from appointment ${appointment.id} · Payment method: ${paymentMethodLabel}${paymentNoteSuffix}`;
    const orderTag = installmentPlan ? "payment_method:installment" : `payment_method:${paymentMethod}`;
    const commonNoteAttributes = [
      { name: "appointment_id", value: String(appointment.id) },
      { name: "shopify_pos_location", value: shopifyPosLocation },
      { name: "marked_unpaid", value: markUnpaid ? "true" : "false" },
      { name: "preferred_payment_method", value: paymentMethod },
      { name: "preferred_payment_method_label", value: paymentMethodLabel },
      { name: "payment_type", value: installmentPlan ? "installment" : "single" },
      { name: "deposit_amount", value: installmentPlan ? installmentPlan.depositAmount.toFixed(2) : "" },
      { name: "remaining_amount", value: installmentPlan ? installmentRemainingFromRequest.toFixed(2) : "" },
      { name: "deposit_method", value: installmentPlan ? installmentPlan.depositMethod : "" },
      { name: "remaining_method", value: installmentPlan && installmentPlan.remainingMethod ? installmentPlan.remainingMethod : "" },
      { name: "remaining_due_date", value: installmentPlan && installmentPlan.remainingDueDate ? installmentPlan.remainingDueDate : "" },
      { name: "payment_split_first_amount", value: paymentBreakdown && (paymentMethod === "split" || paymentMethod === "installment") ? String(Number(paymentBreakdown.firstAmount || 0).toFixed(2)) : "" },
      { name: "payment_split_first_method", value: paymentBreakdown && (paymentMethod === "split" || paymentMethod === "installment") ? String(paymentBreakdown.firstMethod || "") : "" },
      { name: "payment_split_second_amount", value: paymentBreakdown && (paymentMethod === "split" || paymentMethod === "installment") ? String(Number(paymentBreakdown.secondAmount || 0).toFixed(2)) : "" },
      { name: "payment_split_second_method", value: paymentBreakdown && (paymentMethod === "split" || paymentMethod === "installment") ? String(paymentBreakdown.secondMethod || "") : "" }
    ];
    async function recordOrderTransaction(
      orderId: string,
      currencyCode: string,
      amount: number,
      gatewayLabel: string,
      gatewayCode?: string
    ): Promise<{ ok: boolean; error?: string }> {
      return createManualOrderTransaction({
        shop,
        token,
        orderId,
        amount,
        currency: currencyCode,
        methodCode: gatewayCode,
        methodLabel: gatewayLabel,
        apiVersion: "2024-10"
      });
    }
    async function recordInstallmentDepositTransaction(orderId: string, currencyCode: string): Promise<{ ok: boolean; error?: string }> {
      if (!installmentPlan || !orderId) return { ok: false, error: "Acompte introuvable." };
      return recordOrderTransaction(
        orderId,
        currencyCode,
        installmentPlan.depositAmount,
        paymentMethodLabelMap[installmentPlan.depositMethod] || installmentPlan.depositMethod,
        installmentPlan.depositMethod
      );
    }
    async function recordFullPaymentTransaction(orderId: string, currencyCode: string, totalAmount: number): Promise<{ ok: boolean; error?: string }> {
      if (installmentPlan || markUnpaid || !orderId) return { ok: false, error: "Paiement complet non applicable." };
      return recordOrderTransaction(orderId, currencyCode, totalAmount, paymentMethodLabel, paymentMethod);
    }
    const normalizedLineItems = (requestedLines.length ? requestedLines : [{ title: `Appointment - ${label}`, quantity: 1, price: 0 }])
      .map((line) => {
        const quantity = Math.max(1, Math.floor(Number(line.quantity || 1)));
        const variantId = extractNumericShopifyId(line.variantId);
        const title = String(line.title || "").trim();
        const priceValue = Number(line.price);
        const price = Number.isFinite(priceValue) && priceValue >= 0 ? priceValue : 0;
        if (variantId) {
          return {
            variant_id: variantId,
            quantity
          };
        }
        return {
          title: title || `Appointment - ${label}`,
          quantity,
          price: price.toFixed(2)
        };
      })
      .filter((line) => Boolean((line as { variant_id?: number; title?: string }).variant_id || (line as { title?: string }).title));
    if (!normalizedLineItems.length) {
      return res.status(400).json({ ok: false, error: "Ajoutez au moins un article." });
    }

    const draftRes = await fetch(`https://${shop}/admin/api/2026-01/draft_orders.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token
      },
      body: JSON.stringify({
        draft_order: {
          note: orderNote,
          tags: orderTag,
          note_attributes: commonNoteAttributes,
          customer: {
            first_name: firstName,
            last_name: lastName,
            email: appointment.customerEmail || undefined,
            phone: appointment.customerPhone || undefined
          },
          line_items: normalizedLineItems
        }
      })
    });
    const draftRaw = await draftRes.text();
    let draftJson: { draft_order?: { id?: number } } | null = null;
    try {
      draftJson = JSON.parse(draftRaw) as { draft_order?: { id?: number } };
    } catch {
      draftJson = null;
    }
    const draftId = Number(draftJson?.draft_order?.id || 0);
    if (!draftRes.ok || !Number.isFinite(draftId) || draftId <= 0) {
      // Fallback: certains shops n'autorisent pas write_draft_orders.
      // On tente une création directe via orders API si write_orders est disponible.
      const draftProvider = draftRaw.slice(0, 500);
      const needsDraftApproval = draftRes.status === 403 && /write_draft_orders/i.test(draftRaw);
      if (!needsDraftApproval) {
        const detail = parseShopifyErrorMessage(draftRaw);
        return res.status(502).json({
          ok: false,
          error: detail
            ? `Échec création draft order (${draftRes.status}) - ${detail}`
            : `Échec création draft order (${draftRes.status}).`,
          provider: draftProvider
        });
      }

      const directOrderRes = await fetch(`https://${shop}/admin/api/2026-01/orders.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token
        },
        body: JSON.stringify({
          order: {
            note: orderNote,
            tags: orderTag,
            note_attributes: commonNoteAttributes,
            email: appointment.customerEmail || undefined,
            phone: appointment.customerPhone || undefined,
            line_items: normalizedLineItems,
            financial_status: "pending",
            send_receipt: false,
            send_fulfillment_receipt: false
          }
        })
      });
      const directOrderRaw = await directOrderRes.text();
      let directOrderJson:
        | { order?: { id?: number; name?: string; total_price?: string; currency?: string } }
        | null = null;
      try {
        directOrderJson = JSON.parse(directOrderRaw) as { order?: { id?: number; name?: string; total_price?: string; currency?: string } };
      } catch {
        directOrderJson = null;
      }
      const linkedOrderId = String(directOrderJson?.order?.id || "").trim();
      const linkedOrderName = String(directOrderJson?.order?.name || "").trim() || null;
      const linkedOrderTotal = Number(directOrderJson?.order?.total_price || 0);
      const linkedOrderCurrency = String(directOrderJson?.order?.currency || "").trim() || "MAD";
      if (installmentPlan && installmentPlan.depositAmount > linkedOrderTotal) {
        return res.status(400).json({
          ok: false,
          error: "Paiement 1 invalide: supérieur au total Shopify."
        });
      }
      const installmentRemainingAmount = installmentPlan
        ? Math.max(0, Number((linkedOrderTotal - installmentPlan.depositAmount).toFixed(2)))
        : 0;
      const paymentBreakdownPayload = installmentPlan
        ? [
            {
              gateway: paymentMethodLabelMap[installmentPlan.depositMethod] || installmentPlan.depositMethod,
              amount: installmentPlan.depositAmount,
              currency: linkedOrderCurrency
            }
          ]
        : paymentMethod === "split"
          ? paymentBreakdown || null
          : null;

      if (!directOrderRes.ok || !linkedOrderId) {
        const detail = parseShopifyErrorMessage(directOrderRaw);
        return res.status(502).json({
          ok: false,
          error: detail
            ? `Échec création commande Shopify (${directOrderRes.status}) - ${detail}`
            : `Échec création commande Shopify (${directOrderRes.status}).`,
          provider: directOrderRaw.slice(0, 500),
          draftProvider
        });
      }
      if (!(linkedOrderTotal > 0)) {
        return res.status(400).json({
          ok: false,
          error: "Total Shopify invalide (0). Commande refusée."
        });
      }

      const paymentResult = markUnpaid
        ? { ok: false as const, error: "" }
        : installmentPlan
          ? await recordInstallmentDepositTransaction(linkedOrderId, linkedOrderCurrency)
          : await recordFullPaymentTransaction(linkedOrderId, linkedOrderCurrency, linkedOrderTotal);
      const paymentRecorded = paymentResult.ok;
      const paymentRecordError = !markUnpaid && !paymentResult.ok ? String(paymentResult.error || "").trim() : "";

      const updatedFallback = await updateAppointment(shop, appointment.id, {
        orderId: linkedOrderId,
        shopifyOrderId: linkedOrderId,
        orderStatus: "active",
        orderName: linkedOrderName,
        orderTotalAmount: Number.isFinite(linkedOrderTotal) ? linkedOrderTotal : null,
        orderCurrency: linkedOrderCurrency
      });
      await addAppointmentMessage({
        appointmentId: appointment.id,
        shop,
        direction: "system",
        channel: "shopify",
        messageType: "order_created",
          payload: {
            orderId: linkedOrderId,
            orderName: linkedOrderName || linkedOrderId,
            totalAmount: Number.isFinite(linkedOrderTotal) ? linkedOrderTotal : null,
            currency: linkedOrderCurrency,
            source: "orders_api_fallback",
            paymentMethod,
            paymentMethodLabel,
            paymentBreakdown: paymentBreakdownPayload,
            paymentRecorded,
            paymentRecordError: paymentRecordError || null,
            payment_type: installmentPlan ? "installment" : "single",
            deposit_amount: installmentPlan ? installmentPlan.depositAmount : null,
            remaining_amount: installmentPlan ? installmentRemainingAmount : null,
            deposit_method: installmentPlan ? installmentPlan.depositMethod : null,
            remaining_method: installmentPlan ? installmentPlan.remainingMethod : null,
            remaining_due_date: installmentPlan ? installmentPlan.remainingDueDate : null
          },
        providerStatus: "created",
        sentAt: new Date().toISOString()
      });
      void syncAppointmentsMetafieldForShop(shop);
      return res.status(200).json({
        ok: true,
        appointment: updatedFallback,
        order: {
          id: linkedOrderId,
          name: linkedOrderName || linkedOrderId,
          totalAmount: Number.isFinite(linkedOrderTotal) ? linkedOrderTotal : null,
          currency: linkedOrderCurrency,
          url: `https://${shop}/admin/orders/${linkedOrderId}`,
          paymentMethod,
          paymentMethodLabel,
          paymentBreakdown: paymentBreakdownPayload,
          paymentRecorded,
          paymentRecordError: paymentRecordError || null,
          payment_type: installmentPlan ? "installment" : "single",
          deposit_amount: installmentPlan ? installmentPlan.depositAmount : null,
          remaining_amount: installmentPlan ? installmentRemainingAmount : null,
          deposit_method: installmentPlan ? installmentPlan.depositMethod : null,
          remaining_method: installmentPlan ? installmentPlan.remainingMethod : null,
          remaining_due_date: installmentPlan ? installmentPlan.remainingDueDate : null
        },
        fallback: "orders_api"
      });
    }

    const completeRes = await fetch(`https://${shop}/admin/api/2026-01/draft_orders/${draftId}/complete.json?payment_pending=true`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token
      }
    });
    const completeRaw = await completeRes.text();
    type DraftOrderCompleteResponse = {
      draft_order?: {
        order_id?: number;
        order?: {
          id?: number;
          name?: string;
          total_price?: string;
          currency?: string;
        };
      };
    };
    let completeJson: DraftOrderCompleteResponse | null = null;
    try {
      completeJson = JSON.parse(completeRaw) as DraftOrderCompleteResponse;
    } catch {
      completeJson = null;
    }
    const linkedOrderId = String(
      completeJson?.draft_order?.order_id ||
      completeJson?.draft_order?.order?.id ||
      ""
    ).trim();
    const linkedOrderName = String(completeJson?.draft_order?.order?.name || "").trim() || null;
    const linkedOrderTotal = Number(completeJson?.draft_order?.order?.total_price || 0);
    const linkedOrderCurrency = String(completeJson?.draft_order?.order?.currency || "").trim() || "MAD";
    if (installmentPlan && installmentPlan.depositAmount > linkedOrderTotal) {
      return res.status(400).json({
        ok: false,
        error: "Paiement 1 invalide: supérieur au total Shopify."
      });
    }
    const installmentRemainingAmount = installmentPlan
      ? Math.max(0, Number((linkedOrderTotal - installmentPlan.depositAmount).toFixed(2)))
      : 0;
    const paymentBreakdownPayload = installmentPlan
      ? [
          {
            gateway: paymentMethodLabelMap[installmentPlan.depositMethod] || installmentPlan.depositMethod,
            amount: installmentPlan.depositAmount,
            currency: linkedOrderCurrency
          }
        ]
      : paymentMethod === "split"
        ? paymentBreakdown || null
        : null;

    if (!completeRes.ok || !linkedOrderId) {
      const detail = parseShopifyErrorMessage(completeRaw);
      return res.status(502).json({
        ok: false,
        error: detail
          ? `Draft créé mais conversion en commande échouée (${completeRes.status}) - ${detail}`
          : `Draft créé mais conversion en commande échouée (${completeRes.status}).`,
        provider: completeRaw.slice(0, 500)
      });
    }
    if (!(linkedOrderTotal > 0)) {
      return res.status(400).json({
        ok: false,
        error: "Total Shopify invalide (0). Commande refusée."
      });
    }
    const paymentResult = markUnpaid
      ? { ok: false as const, error: "" }
      : installmentPlan
        ? await recordInstallmentDepositTransaction(linkedOrderId, linkedOrderCurrency)
        : await recordFullPaymentTransaction(linkedOrderId, linkedOrderCurrency, linkedOrderTotal);
    const paymentRecorded = paymentResult.ok;
    const paymentRecordError = !markUnpaid && !paymentResult.ok ? String(paymentResult.error || "").trim() : "";

    const updated = await updateAppointment(shop, appointment.id, {
      orderId: linkedOrderId,
      shopifyOrderId: linkedOrderId,
      orderStatus: "active",
      orderName: linkedOrderName,
      orderTotalAmount: Number.isFinite(linkedOrderTotal) ? linkedOrderTotal : null,
      orderCurrency: linkedOrderCurrency
    });
    await addAppointmentMessage({
      appointmentId: appointment.id,
      shop,
      direction: "system",
      channel: "shopify",
      messageType: "order_created",
      payload: {
        orderId: linkedOrderId,
        orderName: linkedOrderName || linkedOrderId,
        totalAmount: Number.isFinite(linkedOrderTotal) ? linkedOrderTotal : null,
        currency: linkedOrderCurrency,
        source: "draft_order_complete",
        paymentMethod,
        paymentMethodLabel,
        paymentBreakdown: paymentBreakdownPayload,
        paymentRecorded,
        paymentRecordError: paymentRecordError || null,
        payment_type: installmentPlan ? "installment" : "single",
        deposit_amount: installmentPlan ? installmentPlan.depositAmount : null,
        remaining_amount: installmentPlan ? installmentRemainingAmount : null,
        deposit_method: installmentPlan ? installmentPlan.depositMethod : null,
        remaining_method: installmentPlan ? installmentPlan.remainingMethod : null,
        remaining_due_date: installmentPlan ? installmentPlan.remainingDueDate : null
      },
      providerStatus: "created",
      sentAt: new Date().toISOString()
    });
    void syncAppointmentsMetafieldForShop(shop);
    return res.status(200).json({
      ok: true,
      appointment: updated,
      order: {
        id: linkedOrderId,
        name: linkedOrderName || linkedOrderId,
        totalAmount: Number.isFinite(linkedOrderTotal) ? linkedOrderTotal : null,
        currency: linkedOrderCurrency,
        url: `https://${shop}/admin/orders/${linkedOrderId}`,
        paymentMethod,
        paymentMethodLabel,
        paymentBreakdown: paymentBreakdownPayload,
        paymentRecorded,
        paymentRecordError: paymentRecordError || null,
        payment_type: installmentPlan ? "installment" : "single",
        deposit_amount: installmentPlan ? installmentPlan.depositAmount : null,
        remaining_amount: installmentPlan ? installmentRemainingAmount : null,
        deposit_method: installmentPlan ? installmentPlan.depositMethod : null,
        remaining_method: installmentPlan ? installmentPlan.remainingMethod : null,
        remaining_due_date: installmentPlan ? installmentPlan.remainingDueDate : null
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur création commande liée";
    return res.status(500).json({ ok: false, error: message });
  }
});

adminRouter.post("/api/appointments/:appointmentId/retry-payment", async (req, res) => {
  const parsedBody = appointmentRetryPaymentSchema.safeParse(req.body ?? {});
  if (!parsedBody.success) {
    return res.status(400).json({ ok: false, error: "Données d'encaissement invalides." });
  }

  let shop = "";
  try {
    shop = resolveShopFromRequest(req);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Shop invalide";
    return res.status(400).json({ ok: false, error: message });
  }

  try {
    const appointment = await getAppointmentById(shop, req.params.appointmentId);
    if (!appointment) return res.status(404).json({ ok: false, error: "Rendez-vous introuvable." });
    const token = await getShopifyAdminToken(shop);
    const orderId = String(
      parsedBody.data.orderId ||
      appointment.orderId ||
      appointment.shopifyOrderId ||
      ""
    ).trim();
    const orderIdNumeric = extractNumericShopifyId(orderId);
    if (!orderIdNumeric) return res.status(400).json({ ok: false, error: "Commande Shopify introuvable." });

    const amount = Number(parsedBody.data.amount || 0);
    if (!(amount > 0)) return res.status(400).json({ ok: false, error: "Montant d'encaissement invalide." });
    const paymentMethod = String(parsedBody.data.paymentMethod || "cash");
    const paymentMethodLabel = String(parsedBody.data.paymentMethodLabel || paymentMethod).trim() || paymentMethod;
    const currency = String(parsedBody.data.currency || appointment.orderCurrency || "MAD").trim().toUpperCase() || "MAD";

    const payment = await createManualOrderTransaction({
      shop,
      token,
      orderId: String(orderIdNumeric),
      amount,
      currency,
      methodCode: paymentMethod,
      methodLabel: paymentMethodLabel,
      apiVersion: "2024-10"
    });
    if (!payment.ok) {
      return res.status(502).json({
        ok: false,
        error: payment.error || "Encaissement Shopify refusé."
      });
    }

    await addAppointmentMessage({
      appointmentId: appointment.id,
      shop,
      direction: "system",
      channel: "shopify",
      messageType: "payment_retry_success",
      payload: {
        orderId,
        amount: Number(amount.toFixed(2)),
        currency,
        paymentMethod,
        paymentMethodLabel,
        gateway: payment.gateway || "manual"
      },
      providerStatus: "created",
      sentAt: new Date().toISOString()
    });

    return res.status(200).json({
      ok: true,
      orderId,
      paymentRecorded: true,
      gateway: payment.gateway || "manual"
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur retry encaissement";
    return res.status(500).json({ ok: false, error: message });
  }
});

adminRouter.get("/api/appointments/payment-health", async (req, res) => {
  let shop = "";
  try {
    shop = resolveShopFromRequest(req);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Shop invalide";
    return res.status(400).json({ ok: false, error: message });
  }

  const apiVersion = "2024-10";
  const parseJsonText = (raw: string): unknown => {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };

  try {
    const token = await getShopifyAdminToken(shop);
    const result: {
      ok: boolean;
      shop: string;
      apiVersion: string;
      currency: string | null;
      requiredScopes: string[];
      recommendedScopes: string[];
      grantedScopes: string[];
      missingRequiredScopes: string[];
      missingRecommendedScopes: string[];
      checks: Array<{ name: string; ok: boolean; status?: number; detail?: string }>;
      sampleOrderId: string | null;
    } = {
      ok: true,
      shop,
      apiVersion,
      currency: null,
      requiredScopes: ["write_orders", "read_orders"],
      recommendedScopes: ["write_draft_orders", "read_draft_orders", "read_products", "read_customers", "read_locations"],
      grantedScopes: [],
      missingRequiredScopes: [],
      missingRecommendedScopes: [],
      checks: [],
      sampleOrderId: null
    };

    const shopRes = await fetch(`https://${shop}/admin/api/${apiVersion}/shop.json`, {
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token
      }
    });
    const shopRaw = await shopRes.text();
    const shopJson = parseJsonText(shopRaw) as { shop?: { currency?: string } } | null;
    if (shopRes.ok) {
      result.currency = String(shopJson?.shop?.currency || "").trim().toUpperCase() || null;
      result.checks.push({ name: "shop_read", ok: true, status: shopRes.status });
    } else {
      result.ok = false;
      result.checks.push({
        name: "shop_read",
        ok: false,
        status: shopRes.status,
        detail: parseShopifyErrorMessage(shopRaw)
      });
    }

    const scopesRes = await fetch(`https://${shop}/admin/oauth/access_scopes.json`, {
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token
      }
    });
    const scopesRaw = await scopesRes.text();
    const scopesJson = parseJsonText(scopesRaw) as { access_scopes?: Array<{ handle?: string }> } | null;
    if (scopesRes.ok) {
      const granted = Array.isArray(scopesJson?.access_scopes)
        ? scopesJson!.access_scopes!.map((s) => String(s?.handle || "").trim()).filter(Boolean)
        : [];
      result.grantedScopes = granted;
      result.missingRequiredScopes = result.requiredScopes.filter((scope) => !granted.includes(scope));
      result.missingRecommendedScopes = result.recommendedScopes.filter((scope) => !granted.includes(scope));
      if (result.missingRequiredScopes.length > 0) result.ok = false;
      result.checks.push({
        name: "scopes_read",
        ok: true,
        status: scopesRes.status,
        detail: result.missingRequiredScopes.length
          ? `Missing required scopes: ${result.missingRequiredScopes.join(", ")}`
          : "All required scopes granted"
      });
    } else {
      result.ok = false;
      result.checks.push({
        name: "scopes_read",
        ok: false,
        status: scopesRes.status,
        detail: parseShopifyErrorMessage(scopesRaw)
      });
    }

    const orderProbeRes = await fetch(
      `https://${shop}/admin/api/${apiVersion}/orders.json?status=any&limit=1&fields=id,total_price,currency,financial_status`,
      {
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token
        }
      }
    );
    const orderProbeRaw = await orderProbeRes.text();
    const orderProbeJson = parseJsonText(orderProbeRaw) as { orders?: Array<{ id?: number | string }> } | null;
    if (orderProbeRes.ok) {
      const firstOrderId = Array.isArray(orderProbeJson?.orders) && orderProbeJson!.orders!.length > 0
        ? String(orderProbeJson!.orders![0]?.id || "").trim()
        : "";
      result.sampleOrderId = firstOrderId || null;
      result.checks.push({
        name: "orders_read",
        ok: true,
        status: orderProbeRes.status,
        detail: firstOrderId ? `Sample order id: ${firstOrderId}` : "No order available for probe"
      });
      if (firstOrderId) {
        const txProbeRes = await fetch(
          `https://${shop}/admin/api/${apiVersion}/orders/${encodeURIComponent(firstOrderId)}/transactions.json?limit=1`,
          {
            headers: {
              "Content-Type": "application/json",
              "X-Shopify-Access-Token": token
            }
          }
        );
        const txProbeRaw = await txProbeRes.text();
        if (txProbeRes.ok) {
          result.checks.push({ name: "transactions_read", ok: true, status: txProbeRes.status });
        } else {
          result.ok = false;
          result.checks.push({
            name: "transactions_read",
            ok: false,
            status: txProbeRes.status,
            detail: parseShopifyErrorMessage(txProbeRaw)
          });
        }
      }
    } else {
      result.ok = false;
      result.checks.push({
        name: "orders_read",
        ok: false,
        status: orderProbeRes.status,
        detail: parseShopifyErrorMessage(orderProbeRaw)
      });
    }

    return res.status(result.ok ? 200 : 207).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur health payment";
    return res.status(500).json({ ok: false, error: message, shop, apiVersion });
  }
});

adminRouter.get("/api/orders", (_req, res) => {
  res.status(200).json({ orders: listOrdersForQueue() });
});

adminRouter.get("/api/priority/leads", async (req, res) => {
  const limitRaw = Number(req.query.limit ?? 200);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.floor(limitRaw))) : 200;
  const slaFilter = String(req.query.sla || "all").toLowerCase();
  const slaAlertsOnly = slaFilter === "alerts";
  try {
    const items = await listWhatsAppPriorityLeads({ limit, slaAlertsOnly });
    return res.status(200).json({
      items: items.map((item) => ({
        id: item.id,
        lead_name: item.clientName,
        country: item.country,
        stage: item.stage,
        conversion_score: item.conversionScore,
        event_date: item.eventDate,
        days_since_last_message: item.daysSinceLastMessage,
        ticket_value: item.ticketValue,
        ticket_currency: item.ticketCurrency,
        sla_status: item.slaStatus,
        sla_due_at: item.slaDueAt,
        risk_flag: item.riskFlag,
        last_message_at: item.lastMessageAt
      }))
    });
  } catch (error) {
    console.error("[priority] leads", error);
    return res.status(503).json({ error: "priority_leads_unavailable" });
  }
});

adminRouter.get("/api/orders/:orderId", (req, res) => {
  const order = getOrderById(req.params.orderId);
  if (!order) return res.status(404).json({ error: "Commande introuvable" });
  return res.status(200).json(order);
});

adminRouter.get("/api/orders/:orderId/invoice-preview-html", (req, res) => {
  const order = getOrderById(req.params.orderId);
  if (!order) return res.status(404).send("Commande introuvable");

  const templateChoice = invoiceTemplateSchema.safeParse(req.query.template).success
    ? String(req.query.template)
    : "classic";

  const html = buildOrderInvoiceHtml(order, templateChoice);
  if (!html) return res.status(400).send("Aperçu HTML indisponible pour ce modèle.");
  return res.type("html").send(html);
});

adminRouter.get("/api/diagnostics/chromium", async (_req, res) => {
  const html =
    "<!doctype html><html><head><meta charset='utf-8' />" +
    "<style>@page{size:A4;margin:18mm}html,body{margin:0;padding:0;background:#fcfaf6;color:#121212;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif}" +
    "body{padding:18mm 20mm 16mm}.brand{text-align:center;font-family:Georgia,'Times New Roman',serif;font-size:34px;letter-spacing:.05em;margin-top:14px}" +
    ".meta{text-align:center;color:#756e66;font-size:13px;margin-top:10px}.rule{height:1px;background:#ebe5dc;margin:24px 0 28px}" +
    ".card{margin-top:24px;padding:20px;border:1px solid #ebe5dc}.k{font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:#756e66}" +
    ".v{margin-top:8px;font-size:22px;font-weight:700}</style></head><body>" +
    "<div class='brand'>Maison Bouchra Filali Lahlou</div>" +
    "<div class='meta'>Diagnostic Chromium Railway</div>" +
    "<div class='rule'></div>" +
    "<div class='card'><div class='k'>Statut</div><div class='v'>Chromium OK</div></div>" +
    "</body></html>";

  try {
    const pdfBuffer = await renderHtmlToPdfBuffer(html);
    return res.status(200).json({
      ok: true,
      chromium: true,
      pdfBytes: pdfBuffer.length
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Chromium failed";
    return res.status(500).json({
      ok: false,
      chromium: false,
      error: message
    });
  }
});

adminRouter.put("/api/orders/:orderId", (req, res) => {
  const parsed = orderUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Données de mise à jour de commande invalides" });
  }

  const updated = updateOrder(req.params.orderId, {
    shippingStatus: parsed.data.shippingStatus as ShippingStatus | undefined,
    shippingDate: parsed.data.shippingDate ?? undefined,
    orderLocation: parsed.data.orderLocation,
    bankDetails: parsed.data.bankDetails,
    articles: parsed.data.articles?.map((article) => ({
      id: article.id,
      status: article.status as ArticleStatus
    }))
  });

  if (!updated) return res.status(404).json({ error: "Commande introuvable" });
  return res.status(200).json({ ok: true, order: updated });
});

adminRouter.post("/api/orders/sync", async (req, res) => {
  const range = parseDateRange(req.body);
  if (!range) {
    return res.status(400).json({ error: "Plage de dates invalide. Format attendu: YYYY-MM-DD." });
  }

  try {
    const orders = await fetchOrdersForPeriod(range.from.toISOString(), range.toExclusive.toISOString(), {
      includeTransactions: false
    });
    addManyOrderSnapshots(orders, { pruneMissing: true });
    // Keep Commands page fast: persist to DB in background (non-blocking for UI sync).
    void upsertManyFromShopifyPayloads(orders)
      .then((persistedCount) => {
        console.log(`[sync-bg] Persisted ${persistedCount}/${orders.length} Shopify order(s) into Postgres.`);
      })
      .catch((persistError) => {
        console.error("[sync-bg] Failed to persist synced Shopify orders to Postgres", persistError);
      });
    const keepIds = orders.map((order) => (order && order.id !== undefined && order.id !== null ? String(order.id) : "")).filter(Boolean);
    void pruneOrdersMissingInRange(range.from.toISOString(), range.toExclusive.toISOString(), keepIds)
      .then((deletedCount) => {
        if (deletedCount > 0) {
          console.log(`[sync-bg] Pruned ${deletedCount} stale order(s) from Postgres in synced range.`);
        }
      })
      .catch((pruneError) => {
        console.error("[sync-bg] Failed to prune stale orders from Postgres", pruneError);
      });
    return res.status(200).json({ ok: true, syncedOrders: orders.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Échec de la synchronisation";
    return res.status(500).json({ error: message });
  }
});

adminRouter.get("/api/insights", async (req, res) => {
  const range = parseDateRange(req.query);
  if (!range) {
    return res.status(400).json({ ok: false, error: "Plage de dates invalide. Format attendu: YYYY-MM-DD." });
  }
  const comparisonRange = parseComparisonDateRange(req.query);

  try {
    const insights = await computeDashboardInsights(range.from, range.toExclusive, comparisonRange ?? undefined);
    return res.status(200).json({ ok: true, insights });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Échec du calcul des insights";
    return res.status(500).json({ ok: false, error: message });
  }
});

adminRouter.get("/api/insights/series", async (req, res) => {
  const range = parseDateRange(req.query);
  if (!range) {
    return res.status(400).json({ ok: false, error: "Plage de dates invalide. Format attendu: YYYY-MM-DD." });
  }

  try {
    const series = await computeDashboardSeries(range.from, range.toExclusive);
    return res.status(200).json({ ok: true, series });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Échec du calcul de la série";
    return res.status(500).json({ ok: false, error: message });
  }
});

adminRouter.get("/api/forecast/revenue", async (req, res) => {
  if (!isBigQueryForecastConfigured()) {
    return res.status(400).json({
      ok: false,
      error:
        "BigQuery non configuré. Ajoutez GCP_PROJECT_ID, BIGQUERY_DATASET, BIGQUERY_LOCATION et GOOGLE_APPLICATION_CREDENTIALS."
    });
  }

  const horizonRaw = Number(req.query.horizon ?? 30);
  const horizon = Number.isFinite(horizonRaw) ? Math.max(7, Math.min(365, Math.floor(horizonRaw))) : 30;
  const modeRaw = String(req.query.mode ?? "robust").toLowerCase();
  const mode = modeRaw === "raw" ? "raw" : "robust";

  try {
    const forecast = await runRevenueForecast(horizon, mode);
    try {
      const runId = await saveForecastRun(forecast);
      console.log(`[forecast] Saved forecast run ${runId ?? "n/a"} (${forecast.mode}, ${forecast.horizon}j).`);
    } catch (persistError) {
      console.error("[forecast] Failed to persist forecast run", persistError);
    }
    return res.status(200).json({ ok: true, forecast });
  } catch (error) {
    console.error("[forecast] primary forecast failed, retrying locally", error);
    try {
      const fallback = await runLocalRevenueForecast(horizon, mode);
      try {
        const runId = await saveForecastRun(fallback);
        console.log(`[forecast] Saved local fallback forecast run ${runId ?? "n/a"} (${fallback.mode}, ${fallback.horizon}j).`);
      } catch (persistError) {
        console.error("[forecast] Failed to persist local fallback forecast run", persistError);
      }
      return res.status(200).json({ ok: true, forecast: fallback });
    } catch (fallbackError) {
      const message = fallbackError instanceof Error ? fallbackError.message : "Échec du forecast local";
      return res.status(500).json({ ok: false, error: message });
    }
  }
});

adminRouter.get("/api/forecast/revenue/latest", async (_req, res) => {
  try {
    let forecast = await getLatestForecastRun();
    const from = new Date(Date.now() - 730 * 86400000).toISOString();
    const to = new Date().toISOString();
    const analyticsRows = await listOrdersForAnalytics(from, to);
    const currentHistoryOrders = analyticsRows.length;
    const storedHistoryOrders = Number(forecast?.dataUsage?.historyOrders || 0);
    const shouldRefresh =
      !forecast ||
      storedHistoryOrders <= 0 ||
      currentHistoryOrders > storedHistoryOrders + 10 ||
      currentHistoryOrders > Math.max(25, Math.floor(storedHistoryOrders * 1.2));

    if (shouldRefresh) {
      const regenerated = await runLocalRevenueForecast(365, "robust");
      try {
        await saveForecastRun(regenerated);
      } catch (persistError) {
        console.error("[forecast] Failed to persist regenerated latest forecast", persistError);
      }
      forecast = regenerated;
    }
    return res.status(200).json({ ok: true, forecast });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Échec lecture du dernier forecast";
    return res.status(500).json({ ok: false, error: message });
  }
});

adminRouter.get("/api/forecast/reconstruct", async (req, res) => {
  try {
    const yearRaw = Number(req.query.year ?? new Date().getUTCFullYear());
    const year = Number.isFinite(yearRaw) ? Math.max(2020, Math.min(2100, Math.floor(yearRaw))) : new Date().getUTCFullYear();
    const now = new Date();
    const currentYear = now.getUTCFullYear();
    const lastCompletedMonth = year === currentYear ? now.getUTCMonth() : 11;
    const monthIndices = Array.from({ length: Math.max(0, lastCompletedMonth) }, (_, index) => index);
    const results = [];

    for (const monthIndex of monthIndices) {
      const targetMonth = `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
      const asOfDate = new Date(Date.UTC(year, monthIndex, 0, 0, 0, 0, 0));
      const reconstructed = await runLocalRevenueForecastAsOf(asOfDate.toISOString().slice(0, 10), 365, "robust");
      const monthly = Array.isArray(reconstructed.monthlyOrdersForecast) ? reconstructed.monthlyOrdersForecast : [];
      const targetRow = monthly.find((row: { month?: string; revenueMad?: number; orders?: number }) =>
        String(row.month || "") === targetMonth
      ) || null;
      results.push({
        month: targetMonth,
        asOf: asOfDate.toISOString().slice(0, 10),
        forecastRevenueMad: Number(targetRow?.revenueMad || 0),
        forecastOrders: Number(targetRow?.orders || 0),
        historyOrdersUsed: Number(reconstructed.dataUsage?.historyOrders || 0),
        modelName: reconstructed.modelName
      });
    }

    return res.status(200).json({ ok: true, year, reconstructedMonths: results });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Échec reconstruction forecast";
    return res.status(500).json({ ok: false, error: message });
  }
});

adminRouter.get("/api/forecast/signals/debug", async (req, res) => {
  try {
    const fromRaw = typeof req.query.from === "string" ? req.query.from : "";
    const toRaw = typeof req.query.to === "string" ? req.query.to : "";
    const to = /^\d{4}-\d{2}-\d{2}$/.test(toRaw) ? toRaw : new Date().toISOString().slice(0, 10);
    const from = /^\d{4}-\d{2}-\d{2}$/.test(fromRaw)
      ? fromRaw
      : new Date(Date.now() - 28 * 86400000).toISOString().slice(0, 10);
    const signals = await computeExternalSignals(from, to);
    return res.status(200).json({
      ok: true,
      range: { from, to },
      ga4Used: Boolean(signals.ga4 && signals.ga4.points > 0),
      signals
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Échec debug signaux externes";
    return res.status(500).json({ ok: false, error: message });
  }
});

adminRouter.get("/api/forecast/v4/latest", async (req, res) => {
  try {
    const horizonRaw = Number(req.query.horizon ?? 365);
    const horizon = Number.isFinite(horizonRaw) ? Math.max(30, Math.min(365, Math.floor(horizonRaw))) : 365;
    const shop =
      (typeof req.query.shop === "string" && req.query.shop.trim()
        ? req.query.shop.trim().toLowerCase()
        : String(env.SHOPIFY_SHOP || "").trim().toLowerCase()) || "";
    const forecast = await getLatestForecastRun();
    if (!forecast) {
      return res.status(404).json({ ok: false, error: "Aucun baseline disponible. Lancez d'abord un forecast." });
    }
    const baselineDaily = buildBaselineDailyPointsFromForecast(
      Array.isArray(forecast.points) ? (forecast.points as unknown as Array<Record<string, unknown>>) : [],
      horizon
    );
    const rdvSnapshot = shop ? await getAppointmentRdvSnapshot(shop, 180) : null;
    const forecastV4 = runForecastV4FromBaseline(baselineDaily, {
      rdv_no_show_rate: rdvSnapshot && rdvSnapshot.available && Number.isFinite(Number(rdvSnapshot.noShowRate))
        ? Number(rdvSnapshot.noShowRate)
        : undefined,
      rdv_to_order_rate: rdvSnapshot && rdvSnapshot.available && Number.isFinite(Number(rdvSnapshot.rdvToOrderRate))
        ? Number(rdvSnapshot.rdvToOrderRate)
        : undefined,
      rdv_data_available: Boolean(rdvSnapshot && rdvSnapshot.available)
    });
    return res.status(200).json({ ok: true, forecast: forecastV4 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Échec lecture du forecast V4";
    return res.status(500).json({ ok: false, error: message });
  }
});

adminRouter.get("/api/forecast/baseline", async (req, res) => {
  try {
    const horizonRaw = Number(req.query.horizon ?? 365);
    const horizon = Number.isFinite(horizonRaw) ? Math.max(30, Math.min(365, Math.floor(horizonRaw))) : 365;
    const forecast = await getLatestForecastRun();
    if (!forecast) {
      return res.status(404).json({ ok: false, error: "Aucun baseline disponible. Lancez d'abord un forecast." });
    }
    const daily = buildBaselineDailyPointsFromForecast(
      Array.isArray(forecast.points) ? (forecast.points as unknown as Array<Record<string, unknown>>) : [],
      horizon
    );
    const monthly = aggregateMonthly(daily);
    const forecastAny = forecast as Record<string, any>;
    const methodology = forecastAny?.methodology as Record<string, unknown> | undefined;
    const dataUsed = forecastAny?.dataUsed as Record<string, unknown> | undefined;
    return res.status(200).json({
      ok: true,
      series_daily: daily,
      series_monthly: monthly,
      meta: {
        model_version:
          String(
            methodology
              ? `${String(methodology.modelRevenue || "-")} / ${String(methodology.modelOrders || "-")}`
              : String(forecastAny?.modelName || "forecast")
          ),
        last_refresh: String(forecastAny?.generatedAt || dataUsed?.lastRefreshAt || ""),
        baseline_period: `${String(dataUsed?.historyFrom || "-")}→${String(dataUsed?.historyTo || "-")}`,
        currency: "MAD"
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Échec baseline";
    return res.status(500).json({ ok: false, error: message });
  }
});

adminRouter.post("/api/forecast/simulate", async (req, res) => {
  try {
    const parsed = forecastSimulationSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: "Configuration simulation invalide." });
    }
    const forecast = await getLatestForecastRun();
    if (!forecast) {
      return res.status(404).json({ ok: false, error: "Aucun baseline disponible." });
    }
    const baselineDaily = buildBaselineDailyPointsFromForecast(
      Array.isArray(forecast.points) ? (forecast.points as unknown as Array<Record<string, unknown>>) : [],
      365
    );
    const simulation = applySimulation(baselineDaily, {
      trafficPct: parsed.data.trafficPct,
      conversionPct: parsed.data.conversionPct,
      aovPct: parsed.data.aovPct,
      showroomEnabled: parsed.data.showroomEnabled,
      showroomStartMonth: parsed.data.showroomStartMonth || null,
      capacityEnabled: parsed.data.capacityEnabled,
      capacityLimitOrdersPerDay: parsed.data.capacityLimitOrdersPerDay ?? null
    });
    return res.status(200).json({
      ok: true,
      simulated_daily: simulation.simulatedDaily,
      simulated_monthly: aggregateMonthly(
        simulation.simulatedDaily.map((row) => ({
          date: row.date,
          revenue_mad: row.revenue_mad,
          orders: row.orders
        }))
      ),
      totals: {
        revenue_365: simulation.totals.revenue_365,
        orders_365: simulation.totals.orders_365
      },
      deltas: simulation.deltas,
      constraints: simulation.constraints,
      explanation: simulation.explanation
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Échec simulation";
    return res.status(500).json({ ok: false, error: message });
  }
});

adminRouter.get("/public/invoices/:orderId", (req, res) => {
  const template = invoiceTemplateSchema.safeParse(req.query.template).success
    ? String(req.query.template)
    : "classic";
  const exp = typeof req.query.exp === "string" ? req.query.exp : "";
  const sig = typeof req.query.sig === "string" ? req.query.sig : "";
  const now = Date.now();
  const expMs = Number(exp);

  if (!exp || !sig || !Number.isFinite(expMs) || expMs < now) {
    return res.status(403).send("Lien expiré ou invalide.");
  }

  const expected = signInvoiceLink(req.params.orderId, exp, template);
  if (sig !== expected) {
    return res.status(403).send("Signature invalide.");
  }

  const html = buildPublicInvoiceHtml(req.params.orderId, template);
  if (!html) return res.status(404).send("Commande introuvable.");
  return res.type("html").send(html);
});

adminRouter.post("/api/orders/:orderId/send-invoice-template", async (req, res) => {
  const parsed = sendInvoiceTemplateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "Paramètres invalides." });
  }

  if (!env.ZOKO_API_URL || !env.ZOKO_AUTH_TOKEN) {
    return res.status(400).json({
      error: "Configuration API manquante. Ajoutez ZOKO_API_URL et ZOKO_AUTH_TOKEN dans .env."
    });
  }

  const order = getOrderById(req.params.orderId);
  if (!order) {
    return res.status(404).json({ error: "Commande introuvable." });
  }

  const requestedPhone = typeof parsed.data.recipientPhone === "string" ? parsed.data.recipientPhone : "";
  const phone = normalizePhoneForApi(requestedPhone || order.customerPhone || "");
  if (!phone) {
    return res.status(400).json({ error: "Numéro destinataire invalide pour envoi API." });
  }

  const requestedTemplates = Array.from(new Set(
    (Array.isArray(parsed.data.templateChoices) && parsed.data.templateChoices.length > 0
      ? parsed.data.templateChoices
      : [parsed.data.templateChoice ?? "classic"]
    ).filter(Boolean)
  ));

  const configuredTemplateName = String(env.ZOKO_TEMPLATE_NAME || "invoice_notification").trim();
  const configuredTemplateLanguage = String(env.ZOKO_TEMPLATE_LANGUAGE || "fr").trim();
  const orderNumberOnly = String(order.name || "0000")
    .replace(/[^0-9]/g, "")
    .trim() || "0000";
  const timestampCode = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const sendResults: Array<Record<string, unknown>> = [];

  for (let index = 0; index < requestedTemplates.length; index += 1) {
    const templateChoice = requestedTemplates[index];
    const expMs = Date.now() + 7 * 24 * 60 * 60 * 1000;
    const exp = String(expMs);
    const sig = signInvoiceLink(order.id, exp, templateChoice);
    const invoicePreviewUrl = `${env.SHOPIFY_APP_URL}/admin/public/invoices/${encodeURIComponent(order.id)}?template=${encodeURIComponent(
      templateChoice
    )}&exp=${encodeURIComponent(exp)}&sig=${encodeURIComponent(sig)}`;

    const randomCode = Math.random().toString(36).slice(2, 10).toUpperCase();
    const pdfFilename = `BFL-${templateChoice.toUpperCase()}-${timestampCode}-${index + 1}-${orderNumberOnly}-${randomCode}.pdf`;
    let invoiceFileUrl = "";
    try {
      const pdfBuffer = await buildOrderInvoicePdf(order, templateChoice);
      invoiceFileUrl = await uploadPdfToShopifyFiles(pdfFilename, pdfBuffer);
    } catch (error) {
      const message = error instanceof Error ? error.message : "PDF generation/upload failed";
      return res.status(502).json({
        error: `PDF Shopify Files échoué pour ${invoiceDocumentLabel(templateChoice)}: ${message}`,
        results: sendResults
      });
    }

    const payloadVars = {
      phone,
      channel: env.ZOKO_CHANNEL || "whatsapp",
      customer_name: order.customerLabel || "",
      order_name: order.name || "",
      invoice_url: invoiceFileUrl || invoicePreviewUrl,
      total_amount: String(order.totalAmount || 0),
      outstanding_amount: String(order.outstandingAmount || 0),
      currency: order.currency || "MAD"
    };

    let payload: unknown;
    if (env.ZOKO_TEMPLATE_PAYLOAD_JSON) {
      try {
        const parsedJson = JSON.parse(env.ZOKO_TEMPLATE_PAYLOAD_JSON) as unknown;
        payload = replaceTemplatePlaceholders(parsedJson, payloadVars) as unknown;
      } catch {
        return res.status(400).json({
          error: "ZOKO_TEMPLATE_PAYLOAD_JSON invalide (JSON incorrect)."
        });
      }
    } else {
      let templateArgs: unknown[] = [payloadVars.invoice_url];
      if (env.ZOKO_TEMPLATE_ARGS_JSON) {
        try {
          const parsedArgs = JSON.parse(env.ZOKO_TEMPLATE_ARGS_JSON) as unknown;
          const replacedArgs = replaceTemplatePlaceholders(parsedArgs, payloadVars);
          if (Array.isArray(replacedArgs) && replacedArgs.length > 0) {
            templateArgs = replacedArgs;
          }
        } catch {
          // keep default template args
        }
      }

      payload = {
        channel: payloadVars.channel,
        recipient: phone,
        type: env.ZOKO_TEMPLATE_TYPE || "richTemplate",
        templateId: configuredTemplateName,
        templateLanguage: configuredTemplateLanguage,
        templateArgs
      };
    }

    const sendResult = await sendZokoTemplate(payload, configuredTemplateName, configuredTemplateLanguage);
    if (!sendResult.ok) {
      console.warn("[orders] zoko invoice template failed", {
        orderId: order.id,
        orderName: order.name,
        templateChoice,
        configuredTemplateName,
        configuredTemplateLanguage,
        recipient: phone,
        status: sendResult.status || 0,
        providerResponse: sendResult.providerResponse || null
      });
      return res.status(502).json({
        error: sendResult.error || `Envoi template API échoué pour ${invoiceDocumentLabel(templateChoice)}.`,
        status: sendResult.status || 0,
        providerResponse: sendResult.providerResponse || null,
        attempts: sendResult.attempts || null,
        results: sendResults
      });
    }

    console.info("[orders] zoko invoice template sent", {
      orderId: order.id,
      orderName: order.name,
      templateChoice,
      configuredTemplateName: sendResult.usedTemplate || configuredTemplateName,
      configuredTemplateLanguage: sendResult.usedLanguage || configuredTemplateLanguage,
      recipient: phone,
      usedType: sendResult.usedType || null
    });
    sendResults.push({
      templateChoice,
      documentLabel: invoiceDocumentLabel(templateChoice),
      invoiceUrl: payloadVars.invoice_url,
      providerResponse: sendResult.providerResponse,
      usedTemplate: sendResult.usedTemplate,
      usedLanguage: sendResult.usedLanguage,
      usedType: sendResult.usedType
    });
  }

  return res.status(200).json({
    ok: true,
    results: sendResults
  });
});

adminRouter.post("/api/orders/:orderId/send-review-template", async (req, res) => {
  if (!env.ZOKO_API_URL || !env.ZOKO_AUTH_TOKEN) {
    return res.status(400).json({
      error: "Configuration API manquante. Ajoutez ZOKO_API_URL et ZOKO_AUTH_TOKEN dans .env."
    });
  }

  const order = getOrderById(req.params.orderId);
  if (!order) {
    return res.status(404).json({ error: "Commande introuvable." });
  }

  const phone = normalizePhoneForApi(order.customerPhone || "");
  if (!phone) {
    return res.status(400).json({ error: "Numéro client invalide pour envoi API." });
  }

  const configuredTemplateName = String(env.ZOKO_REVIEW_TEMPLATE_NAME || "demander_avis").trim();
  const configuredTemplateLanguage = String(env.ZOKO_REVIEW_TEMPLATE_LANGUAGE || "French").trim();

  const payloadVars = {
    phone,
    channel: env.ZOKO_CHANNEL || "whatsapp",
    customer_name: order.customerLabel || "",
    order_name: order.name || ""
  };

  let payload: unknown;
  if (env.ZOKO_REVIEW_TEMPLATE_PAYLOAD_JSON) {
    try {
      const parsedJson = JSON.parse(env.ZOKO_REVIEW_TEMPLATE_PAYLOAD_JSON) as unknown;
      payload = replaceTemplatePlaceholders(parsedJson, payloadVars) as unknown;
    } catch {
      return res.status(400).json({
        error: "ZOKO_REVIEW_TEMPLATE_PAYLOAD_JSON invalide (JSON incorrect)."
      });
    }
  } else {
    let reviewTemplateArgs: unknown[] = [payloadVars.customer_name];
    if (env.ZOKO_REVIEW_TEMPLATE_ARGS_JSON) {
      try {
        const parsedArgs = JSON.parse(env.ZOKO_REVIEW_TEMPLATE_ARGS_JSON) as unknown;
        const replacedArgs = replaceTemplatePlaceholders(parsedArgs, payloadVars);
        if (Array.isArray(replacedArgs) && replacedArgs.length > 0) {
          reviewTemplateArgs = replacedArgs;
        }
      } catch {
        // keep default template args
      }
    }

    payload = {
      channel: payloadVars.channel,
      recipient: phone,
      type: env.ZOKO_REVIEW_TEMPLATE_TYPE || env.ZOKO_TEMPLATE_TYPE || "buttonTemplate",
      templateId: configuredTemplateName,
      templateLanguage: configuredTemplateLanguage,
      templateArgs: reviewTemplateArgs
    };
  }

  const sendResult = await sendZokoTemplate(payload, configuredTemplateName, configuredTemplateLanguage);
  if (!sendResult.ok) {
    return res.status(502).json({
      error: sendResult.error || "Envoi template API échoué.",
      status: sendResult.status || 0,
      providerResponse: sendResult.providerResponse || null,
      attempts: sendResult.attempts || null
    });
  }
  return res.status(200).json({
    ok: true,
    providerResponse: sendResult.providerResponse,
    usedTemplate: sendResult.usedTemplate,
    usedLanguage: sendResult.usedLanguage,
    usedType: sendResult.usedType
  });
});

adminRouter.get("/api/business", (_req, res) => {
  res.status(200).json(getBusinessProfile());
});

adminRouter.put("/api/business", (req, res) => {
  const parsed = businessSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Données de configuration métier invalides" });
  }

  const updated = updateBusinessProfile(parsed.data);
  return res.status(200).json({ ok: true, businessProfile: updated });
});

adminRouter.get("/api/events", (_req, res) => {
  res.status(200).json({ events: listWebhookEvents() });
});
