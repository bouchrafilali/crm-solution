import { Router } from "express";
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
import { buildOrderInvoicePdf } from "../services/invoicePdf.js";
import { uploadPdfToShopifyFiles } from "../services/shopifyFiles.js";

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

const shippingStatusSchema = z.enum(["in_progress", "ready", "shipped"]);
const articleStatusSchema = z.enum(["pending", "in_progress", "prepared", "shipped"]);
const invoiceTemplateSchema = z.enum(["classic", "coin", "showroom_receipt", "international_invoice"]);

const sendInvoiceTemplateSchema = z.object({
  templateChoice: invoiceTemplateSchema.optional()
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

function normalizePhoneForApi(phone: string): string {
  const digits = String(phone || "").replace(/[^0-9]/g, "");
  if (digits.length < 8 || digits.length > 15) return "";
  return digits;
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
  const authHeader = String(env.ZOKO_AUTH_HEADER || "apikey").trim();
  const authPrefix = String(env.ZOKO_AUTH_PREFIX || "").trim();
  const tokenValue = authPrefix ? `${authPrefix} ${env.ZOKO_AUTH_TOKEN}` : env.ZOKO_AUTH_TOKEN;

  const allowInsecureTls = String(env.ZOKO_ALLOW_INSECURE_TLS || "").toLowerCase() === "true";
  const previousTlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  if (allowInsecureTls) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
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

          const apiRes = await fetch(env.ZOKO_API_URL as string, {
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
    if (allowInsecureTls) {
      if (typeof previousTlsSetting === "string") {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTlsSetting;
      } else {
        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      }
    }
    clearTimeout(timeoutId);
  }
}

adminRouter.get("/", (req, res) => {
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
      font-family: "Avenir Next", "Segoe UI", sans-serif;
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
    .kpi-chart {
      margin-top: 10px;
      height: 220px;
      border-radius: 8px;
      background: transparent;
      border: 1px solid #eceef0;
      overflow: visible;
      position: relative;
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
      grid-template-columns: auto 1fr 1fr 1fr;
      gap: 10px;
      margin: 12px 0 16px;
    }
    .sync-action {
      display: flex;
      align-items: end;
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
            <div id="kpiRevenueChart" class="kpi-chart"></div>
          </div>
          <div class="kpi-middle">
            <div class="kpi">
              <div class="kpi-title">Nombre de commandes</div>
              <div id="kpiOrdersCount" class="kpi-value">0</div>
              <div id="kpiArticlesSummary" class="kpi-sub"><span class="kpi-muted">-</span></div>
            </div>
            <div class="kpi">
              <div class="kpi-title">Commandes en cours</div>
              <div id="kpiInProgress" class="kpi-value">0</div>
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
              <div class="kpi-title">Commandes livrées</div>
              <div id="kpiShipped" class="kpi-value">0</div>
            </div>
          </div>
        </div>
      </div>
      <div class="sync-grid">
        <div class="sync-action">
          <button id="syncBtn">Synchroniser les commandes</button>
        </div>
        <div>
          <label for="presetRange">Période</label>
          <select id="presetRange">
            <option value="year">Année en cours</option>
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
        </div>
        <div>
          <label for="syncFrom">Du</label>
          <input id="syncFrom" type="date" />
        </div>
        <div>
          <label for="syncTo">Au</label>
          <input id="syncTo" type="date" />
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
        <div class="status">Choisissez le format de compte puis complétez les champs à afficher dans la facture.</div>
        <div style="margin-top:10px;">
          <label for="bankTemplateSelect">Modèle de facture</label>
          <select id="bankTemplateSelect">
            <option value="classic">Version 1 (Facture)</option>
          </select>
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
          <div class="modal-preview-head">Aperçu de la facture</div>
          <iframe id="bankModalPreviewFrame" class="modal-preview-frame"></iframe>
        </div>
        <div class="modal-actions">
          <button id="bankModalCancelBtn" type="button" class="btn-secondary">Annuler</button>
          <button id="bankModalPreviewBtn" type="button" class="btn-secondary">Aperçu</button>
          <button id="bankModalConfirmBtn" type="button">Utiliser pour la facture</button>
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
    const syncBtn = document.getElementById("syncBtn");
    const syncStatusEl = document.getElementById("syncStatus");
    const ordersListEl = document.getElementById("ordersList");
    const deliveryQueueListEl = document.getElementById("deliveryQueueList");
    const orderDetailEl = document.getElementById("orderDetail");
    const kpiRevenueTotalEl = document.getElementById("kpiRevenueTotal");
    const kpiRevenueBreakdownEl = document.getElementById("kpiRevenueBreakdown");
    const kpiRevenueChartEl = document.getElementById("kpiRevenueChart");
    const kpiRevenueCardEl = kpiRevenueTotalEl ? kpiRevenueTotalEl.closest(".kpi") : null;
    const kpiUnpaidTotalEl = document.getElementById("kpiUnpaidTotal");
    const kpiUnpaidBreakdownEl = document.getElementById("kpiUnpaidBreakdown");
    const kpiUnpaidCardEl = kpiUnpaidTotalEl ? kpiUnpaidTotalEl.closest(".kpi") : null;
    const kpiOrdersCountEl = document.getElementById("kpiOrdersCount");
    const kpiArticlesSummaryEl = document.getElementById("kpiArticlesSummary");
    const kpiInProgressEl = document.getElementById("kpiInProgress");
    const kpiUnpaidEl = document.getElementById("kpiUnpaid");
    const kpiShippedEl = document.getElementById("kpiShipped");
    const bankModalEl = document.getElementById("bankDetailsModal");
    const bankProfileTypeEl = document.getElementById("bankProfileType");
    const bankTemplateSelectEl = document.getElementById("bankTemplateSelect");
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

    function applyPreset(value) {
      const today = todayString();
      let from = today;
      let to = today;
      switch (value) {
        case "year":
          from = startOfYear();
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
      const paidAmount = Math.max(0, Number(order.totalAmount || 0) - Number(order.outstandingAmount || 0));
      const isFullyPaid = Number(order.outstandingAmount || 0) <= 0;
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

      const hasOutstanding = Number(order.outstandingAmount || 0) > 0;
      const outstandingRow = hasOutstanding
        ? "<tr><td colspan='2' style='text-align:right;padding:12px;border-top:1px solid #f0f0f0;'><strong>Montant impayé</strong></td><td style='text-align:right;padding:12px;border-top:1px solid #f0f0f0;color:#b41c18;'><strong>" + formatMoney(order.outstandingAmount || 0, order.currency) + "</strong></td></tr>"
        : "";
      const coinOutstandingRow = hasOutstanding ? "<tr><td colspan='2' style='text-align:right;padding:12px;border-top:1px solid #f0e6d5;'><strong>Montant impayé</strong></td><td style='text-align:right;padding:12px;border-top:1px solid #f0e6d5;color:#b41c18;'><strong>" + formatMoney(order.outstandingAmount || 0, order.currency) + "</strong></td></tr>" : "";
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
        "<tr><td colspan='2' style='text-align:right;padding:10px 12px;'>Sous-total</td><td style='text-align:right;padding:10px 12px;'>" + formatMoney(order.totalAmount || 0, order.currency) + "</td></tr>" +
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
        "<tr><td colspan='2' style='text-align:right;padding:10px 12px;'>Sous-total</td><td style='text-align:right;padding:10px 12px;'>" + formatMoney(order.totalAmount || 0, order.currency) + "</td></tr>" +
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
        "<!doctype html><html><head><meta charset='utf-8' /><title>Showroom Receipt " + escapeHtml(order.name) + "</title>" +
        "<style>@page{size:A4;margin:12mm}body{margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;color:#111;background:#fff}" +
        ".page{padding:8mm 6mm}.head{text-align:center;margin-bottom:16px}.brand{font-family:Georgia,'Times New Roman',serif;letter-spacing:.08em;font-size:20px;text-transform:uppercase;font-weight:600}" +
        ".meta{margin-top:6px;color:#666;font-size:12px}.title{margin-top:10px;font-size:13px;letter-spacing:.08em;text-transform:uppercase}" +
        ".grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:14px 0}.card{border:1px solid #e8e8e8;border-radius:10px;padding:12px}" +
        ".card h3{margin:0 0 8px;color:#666;font-size:12px;text-transform:uppercase;letter-spacing:.07em}.r{display:grid;grid-template-columns:42% 58%;gap:6px;font-size:12.5px;margin-bottom:6px}" +
        ".k{color:#666}.v{font-weight:600}table{width:100%;border-collapse:collapse;font-size:13px}.th{color:#666;font-size:11px;text-transform:uppercase;letter-spacing:.07em;border-bottom:1px solid #e8e8e8}" +
        "th,td{padding:9px 10px;border-bottom:1px solid #ededed;text-align:left}td.a{text-align:right}.tot{margin-top:12px;border:1px solid #e8e8e8;border-radius:10px;padding:10px;max-width:360px;margin-left:auto}" +
        ".line{display:flex;justify-content:space-between;padding:4px 0;font-size:13px}.strong{font-weight:700}</style></head><body><div class='page'>" +
        "<div class='head'><div class='brand'>Maison Bouchra Filali Lahlou</div><div class='meta'>Casablanca, Morocco • contact@bouchrafilalilahlou.com • www.bouchrafilalilahlou.com</div><div class='title'>Showroom Receipt</div></div>" +
        "<div class='grid'><div class='card'><h3>Order</h3>" +
        "<div class='r'><div class='k'>Number</div><div class='v'>" + escapeHtml(order.name) + "</div></div>" +
        "<div class='r'><div class='k'>Date</div><div class='v'>" + dateLabel + " " + dateTimeLabel + "</div></div>" +
        "<div class='r'><div class='k'>Payment Status</div><div class='v'>" + escapeHtml(financialLabel) + "</div></div>" +
        "<div class='r'><div class='k'>Payment Method</div><div class='v'>" + paymentGateway + "</div></div>" +
        "</div><div class='card'><h3>Client</h3>" +
        "<div class='r'><div class='k'>Name</div><div class='v'>" + escapeHtml(order.customerLabel || "Client inconnu") + "</div></div>" +
        "<div class='r'><div class='k'>Phone</div><div class='v'>" + escapeHtml(order.customerPhone || "-") + "</div></div>" +
        "<div class='r'><div class='k'>Email</div><div class='v'>" + escapeHtml(order.customerEmail || "-") + "</div></div>" +
        "<div class='r'><div class='k'>Address</div><div class='v'>" + shippingAddress + "</div></div>" +
        "</div></div>" +
        "<table><thead><tr class='th'><th style='width:72px'>Qty</th><th>Article</th><th style='width:180px;text-align:right'>Amount</th></tr></thead><tbody>" +
        rows +
        "</tbody></table>" +
        "<div class='tot'>" +
          "<div class='line'><span>Subtotal</span><span>" + formatMoney(order.totalAmount || 0, order.currency) + "</span></div>" +
          "<div class='line'><span>Total paid</span><span>" + formatMoney(paidAmount, order.currency) + "</span></div>" +
          (hasOutstanding ? "<div class='line strong'><span>Balance due</span><span>" + formatMoney(order.outstandingAmount || 0, order.currency) + "</span></div>" : "<div class='line strong'><span>Balance due</span><span>-</span></div>") +
        "</div>" +
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
        "<div class='totals'><div class='line'><span>Subtotal</span><span>" + formatMoney(order.totalAmount || 0, order.currency) + "</span></div><div class='line'><span>Paid</span><span>" + formatMoney(paidAmount, order.currency) + "</span></div>" +
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

    function openInvoiceModal(order, showBankSection) {
      return new Promise((resolve) => {
        const existing = order.bankDetails || {};
        bankProfileTypeEl.value = guessBankProfile(existing);
        bankTemplateSelectEl.value = "classic";
        bankBeneficiaryNameEl.value = existing.beneficiaryName || "";
        bankNameInputEl.value = existing.bankName || "";
        swiftInputEl.value = existing.swiftBic || "";
        routingInputEl.value = existing.routingNumber || "";
        accountInputEl.value = existing.accountNumber || "";
        bankAddressInputEl.value = existing.bankAddress || "";
        referenceInputEl.value = existing.paymentReference || order.name || "";
        applyBankProfileUI(bankProfileTypeEl.value);
        bankFieldsGroupEl.classList.toggle("hidden", !showBankSection);
        bankProfileGroupEl.classList.toggle("hidden", !showBankSection);
        bankModalPreviewWrap.classList.add("hidden");
        bankModalPreviewFrame.removeAttribute("src");
        bankModalEl.classList.remove("hidden");

        const cleanup = () => {
          bankModalConfirmBtn.onclick = null;
          bankModalCancelBtn.onclick = null;
          bankModalPreviewBtn.onclick = null;
          bankProfileTypeEl.onchange = null;
          if (invoicePreviewBlobUrl) {
            URL.revokeObjectURL(invoicePreviewBlobUrl);
            invoicePreviewBlobUrl = "";
          }
        };

        bankProfileTypeEl.onchange = () => applyBankProfileUI(bankProfileTypeEl.value);
        bankModalCancelBtn.onclick = () => {
          bankModalEl.classList.add("hidden");
          cleanup();
          resolve(null);
        };
        bankModalPreviewBtn.onclick = () => {
          const currentSelection = {
            bankDetails:
              showBankSection
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
            templateChoice: bankTemplateSelectEl.value
          };
          const html = buildInvoiceHtml(order, currentSelection.bankDetails, currentSelection.templateChoice);
          if (invoicePreviewBlobUrl) {
            URL.revokeObjectURL(invoicePreviewBlobUrl);
            invoicePreviewBlobUrl = "";
          }
          const blob = new Blob([html], { type: "text/html" });
          invoicePreviewBlobUrl = URL.createObjectURL(blob);
          bankModalPreviewFrame.src = invoicePreviewBlobUrl;
          bankModalPreviewWrap.classList.remove("hidden");
        };
        bankModalConfirmBtn.onclick = () => {
          const selected = {
            bankDetails:
              showBankSection
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
            templateChoice: bankTemplateSelectEl.value
          };
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

    function renderRevenueChart(data) {
      if (!kpiRevenueChartEl) return;
      const width = 640;
      const height = 220;
      const margin = { top: 18, right: 14, bottom: 38, left: 56 };
      const plotWidth = width - margin.left - margin.right;
      const plotHeight = height - margin.top - margin.bottom;
      const today = new Date();
      const daySeries = [];
      for (let i = 34; i >= 0; i -= 1) {
        const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
        daySeries.push({
          key: d.toISOString().slice(0, 10),
          value: 0
        });
      }

      const bucket = new Map(daySeries.map((entry) => [entry.key, entry]));
      data.forEach((order) => {
        const key = String(order.createdAt || "").slice(0, 10);
        const target = bucket.get(key);
        if (!target) return;
        target.value += Math.max(0, Number(order.totalAmount || 0));
      });

      const values = daySeries.map((entry) => entry.value);
      const maxValue = Math.max(...values, 0);
      const defaultCurrency = String((data[0] && data[0].currency) || "MAD").toUpperCase();
      const formatAxisMoney = (value) => {
        if (value <= 0) return "0 " + defaultCurrency;
        if (value >= 1000) {
          return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(value / 1000) + " k " + defaultCurrency;
        }
        return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(value) + " " + defaultCurrency;
      };
      if (maxValue <= 0) {
        kpiRevenueChartEl.innerHTML =
          "<svg viewBox='0 0 640 220' preserveAspectRatio='none'>" +
            "<line x1='56' y1='182' x2='626' y2='182' stroke='#e4e7ea' stroke-width='1'/>" +
            "<text x='320' y='112' text-anchor='middle' fill='#9aa0a6' font-size='13'>Pas encore de ventes sur 35 jours</text>" +
          "</svg>";
        return;
      }

      const stepX = daySeries.length > 1 ? plotWidth / (daySeries.length - 1) : plotWidth;
      const points = values.map((value, index) => {
        const x = margin.left + stepX * index;
        const y = margin.top + (1 - value / maxValue) * plotHeight;
        return [x, y];
      });
      const linePath = points
        .map((point, index) => (index === 0 ? "M " + point[0] + " " + point[1] : "L " + point[0] + " " + point[1]))
        .join(" ");

      const yTicks = [0, maxValue / 3, (maxValue * 2) / 3, maxValue];
      let yTickSvg = "";
      yTicks.forEach((value) => {
        const y = margin.top + (1 - value / maxValue) * plotHeight;
        yTickSvg +=
          "<line x1='" + margin.left + "' y1='" + y + "' x2='" + (margin.left + plotWidth) + "' y2='" + y + "' stroke='#e7eaed' stroke-width='1'/>" +
          "<text x='6' y='" + (y + 4) + "' fill='#8a8f95' font-size='11'>" + formatAxisMoney(value) + "</text>";
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
          "<path d='" + linePath + "' fill='none' stroke='#008060' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'/>" +
          "<line id='revHoverLine' x1='0' y1='" + margin.top + "' x2='0' y2='" + (margin.top + plotHeight) + "' stroke='#d0d4d8' stroke-width='1' visibility='hidden'/>" +
          "<circle id='revHoverDot' cx='0' cy='0' r='4' fill='#008060' stroke='#ffffff' stroke-width='2' visibility='hidden'/>" +
          xTickSvg +
        "</svg>" +
        "<div id='revChartTooltip' class='kpi-chart-tooltip'>" +
          "<div class='title'>Ventes totales</div>" +
          "<div class='meta'><span class='dot'></span><span class='date'></span></div>" +
          "<div class='amount'></div>" +
        "</div>";

      const svg = kpiRevenueChartEl.querySelector("svg");
      const hoverLine = kpiRevenueChartEl.querySelector("#revHoverLine");
      const hoverDot = kpiRevenueChartEl.querySelector("#revHoverDot");
      const tooltip = kpiRevenueChartEl.querySelector("#revChartTooltip");
      const tooltipDate = tooltip.querySelector(".date");
      const tooltipAmount = tooltip.querySelector(".amount");

      function hideTooltip() {
        hoverLine.setAttribute("visibility", "hidden");
        hoverDot.setAttribute("visibility", "hidden");
        tooltip.style.display = "none";
      }

      function showAt(clientX) {
        const rect = svg.getBoundingClientRect();
        const localX = Math.max(margin.left, Math.min(margin.left + plotWidth, ((clientX - rect.left) / rect.width) * width));
        const index = Math.max(0, Math.min(daySeries.length - 1, Math.round((localX - margin.left) / stepX)));
        const point = points[index];
        const seriesItem = daySeries[index];
        const x = point[0];
        const y = point[1];

        hoverLine.setAttribute("x1", String(x));
        hoverLine.setAttribute("x2", String(x));
        hoverLine.setAttribute("visibility", "visible");
        hoverDot.setAttribute("cx", String(x));
        hoverDot.setAttribute("cy", String(y));
        hoverDot.setAttribute("visibility", "visible");

        const showDate = new Date(seriesItem.key + "T00:00:00").toLocaleDateString("fr-FR", {
          day: "numeric",
          month: "short",
          year: "numeric"
        });
        tooltipDate.textContent = showDate;
        tooltipAmount.textContent = formatMoney(seriesItem.value, defaultCurrency);
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

    function buildDeliveryTurns(data) {
      const candidates = data.filter((order) => order.shippingStatus !== "shipped");
      return candidates.sort((a, b) => {
        const shipA = a.shippingDate ? new Date(a.shippingDate).getTime() : Number.POSITIVE_INFINITY;
        const shipB = b.shippingDate ? new Date(b.shippingDate).getTime() : Number.POSITIVE_INFINITY;
        if (shipA !== shipB) return shipA - shipB;
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      });
    }

    function updateKpis(data) {
      const unpaidCount = data.filter((order) => Number(order.outstandingAmount || 0) > 0).length;
      const shippedCount = data.filter((order) => String(order.shippingStatus) === "shipped").length;
      const inProgressCount = data.filter((order) => String(order.shippingStatus) !== "shipped").length;
      const revenueByCurrency = new Map();
      const totalsByCurrency = new Map();
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
        }

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
        const totalMadApprox = revenueEntries.reduce(
          (sum, [currency, amount]) => sum + toMadApprox(amount, currency),
          0
        );
        kpiRevenueTotalEl.textContent = "≃ " + formatMoney(totalMadApprox, "MAD");
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
      kpiUnpaidEl.textContent = String(unpaidCount);
      kpiShippedEl.textContent = String(shippedCount);
      kpiInProgressEl.textContent = String(inProgressCount);
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
      const res = await fetch("/admin/api/orders");
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

      if (!selectedOrderId || !orders.some((order) => order.id === selectedOrderId)) {
        selectedOrderId = orders[0].id;
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
      orders.forEach((order) => {
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

      renderDeliveryQueue(orders);

      const selected = orders.find((order) => order.id === selectedOrderId);
      if (selected) renderOrderDetail(selected);
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
      const paymentInfoRows = [
        "<div class='info-item'><div class='info-label'>Statut</div><div class='info-value'>" +
          paymentLabel(order) +
          "</div></div>",
        "<div class='info-item'><div class='info-label'>Reste à payer</div><div class='info-value'>" +
          remainingAmountLabel(order) +
          "</div></div>",
        "<div class='info-item'><div class='info-label'>Total</div><div class='info-value'>" +
          formatMoney(order.totalAmount || 0, order.currency) +
          "</div></div>"
      ];
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
              "<button type='button' id='invoiceBtn' class='save-order-btn' style='margin-top:0;'>Imprimer la facture</button>" +
              "<button type='button' id='whatsappBtn' class='save-order-btn' style='margin-top:0;'>Envoyer facture via WhatsApp</button>" +
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
      const whatsappBtn = detail.querySelector("#whatsappBtn");
      const invoiceBtn = detail.querySelector("#invoiceBtn");

      whatsappBtn.addEventListener("click", async () => {
        try {
          syncStatusEl.textContent = "Préparation de l’envoi facture...";
          const modalResult = await openInvoiceModal(order, needsBankDetails);
          if (!modalResult) {
            syncStatusEl.textContent = "Envoi annulé.";
            return;
          }

          if (modalResult.bankDetails) {
            await fetch("/admin/api/orders/" + encodeURIComponent(order.id), {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ bankDetails: modalResult.bankDetails })
            });
          }

          syncStatusEl.textContent = "Envoi API en cours...";
          const sendRes = await fetch("/admin/api/orders/" + encodeURIComponent(order.id) + "/send-invoice-template", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ templateChoice: modalResult.templateChoice || "classic" })
          });
          const parsed = await readJsonSafe(sendRes);
          if (!sendRes.ok) {
            const errMsg = extractApiErrorMessage(parsed, "Réponse invalide API.");
            syncStatusEl.textContent = "Envoi API échoué: " + errMsg;
            return;
          }
          syncStatusEl.textContent = "Facture envoyée via API template.";
        } catch (error) {
          syncStatusEl.textContent =
            "Envoi API échoué: " +
            (error instanceof Error ? error.message : "Erreur inattendue");
        }
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

      invoiceBtn.addEventListener("click", async () => {
        const modalResult = await openInvoiceModal(order, needsBankDetails);
        if (!modalResult) return;
        if (modalResult.bankDetails) {
          await fetch("/admin/api/orders/" + encodeURIComponent(order.id), {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ bankDetails: modalResult.bankDetails })
          });
        }
        const html = buildInvoiceHtml(order, modalResult.bankDetails, modalResult.templateChoice);
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
      if (syncInFlight) {
        syncQueued = true;
        return;
      }
      syncInFlight = true;
      syncQueued = false;
      const runId = ++syncRunId;
      syncBtn.disabled = true;
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
        syncBtn.disabled = false;
        if (syncQueued) syncOrders();
        return;
      }

      const parsed = await readJsonSafe(res);
      if (!parsed.ok) {
        if (runId === syncRunId) {
          syncStatusEl.textContent = "Échec de la synchronisation";
        }
        syncInFlight = false;
        syncBtn.disabled = false;
        if (syncQueued) syncOrders();
        return;
      }

      if (runId === syncRunId) {
        syncStatusEl.textContent = "Synchronisées: " + parsed.data.syncedOrders + " commande(s)";
        await loadOrders();
      }
      syncInFlight = false;
      syncBtn.disabled = false;
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
      }
      scheduleSync(180);
    });

    syncFromEl.addEventListener("change", () => {
      presetRangeEl.value = "custom";
      scheduleSync();
    });

    syncToEl.addEventListener("change", () => {
      presetRangeEl.value = "custom";
      scheduleSync();
    });

    syncBtn.addEventListener("click", (e) => {
      e.preventDefault();
      syncOrders();
    });

    presetRangeEl.value = "year";
    applyPreset("year");
    syncOrders();
  </script>
</body>
</html>`);
});

adminRouter.get("/invoices", (req, res) => {
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
    body { margin: 0; font-family: "Inter", "Helvetica Neue", Helvetica, Arial, sans-serif; background: var(--bg); color: var(--text); }
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
            <div class="row"><strong>Total TTC</strong><strong id="totalView">0</strong></div>
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
          "<tr><td colspan='2' style='text-align:right;padding:12px;border-top:1px solid #f0f0f0;'><strong>Total TTC</strong></td><td style='text-align:right;padding:12px;border-top:1px solid #f0f0f0;'><strong>" + fmtMoney(data.total, data.currency) + "</strong></td></tr>" +
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
          "<tr><td class='lbl'><strong>Total TTC</strong></td><td class='val'><strong>" + fmtMoney(data.total, data.currency) + "</strong></td></tr>" +
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

adminRouter.get("/api/orders", (_req, res) => {
  res.status(200).json({ orders: listOrdersForQueue() });
});

adminRouter.get("/api/orders/:orderId", (req, res) => {
  const order = getOrderById(req.params.orderId);
  if (!order) return res.status(404).json({ error: "Commande introuvable" });
  return res.status(200).json(order);
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
    const orders = await fetchOrdersForPeriod(range.from.toISOString(), range.toExclusive.toISOString());
    addManyOrderSnapshots(orders, { pruneMissing: true });
    return res.status(200).json({ ok: true, syncedOrders: orders.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Échec de la synchronisation";
    return res.status(500).json({ error: message });
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

  const phone = normalizePhoneForApi(order.customerPhone || "");
  if (!phone) {
    return res.status(400).json({ error: "Numéro client invalide pour envoi API." });
  }

  const templateChoice = parsed.data.templateChoice ?? "classic";
  const expMs = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const exp = String(expMs);
  const sig = signInvoiceLink(order.id, exp, templateChoice);
  const invoicePreviewUrl = `${env.SHOPIFY_APP_URL}/admin/public/invoices/${encodeURIComponent(order.id)}?template=${encodeURIComponent(
    templateChoice
  )}&exp=${encodeURIComponent(exp)}&sig=${encodeURIComponent(sig)}`;

  const orderNumberOnly = String(order.name || "0000")
    .replace(/[^0-9]/g, "")
    .trim() || "0000";
  const timestampCode = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const randomCode = Math.random().toString(36).slice(2, 10).toUpperCase();
  const pdfFilename = `BFL-REF-${timestampCode}-${orderNumberOnly}-${randomCode}.pdf`;
  let invoiceFileUrl = "";
  try {
    const pdfBuffer = await buildOrderInvoicePdf(order, templateChoice);
    invoiceFileUrl = await uploadPdfToShopifyFiles(pdfFilename, pdfBuffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : "PDF generation/upload failed";
    return res.status(502).json({ error: `PDF Shopify Files échoué: ${message}` });
  }

  const configuredTemplateName = String(env.ZOKO_TEMPLATE_NAME || "invoice_notification").trim();
  const configuredTemplateLanguage = String(env.ZOKO_TEMPLATE_LANGUAGE || "fr").trim();

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
    invoiceUrl: payloadVars.invoice_url,
    usedTemplate: sendResult.usedTemplate,
    usedLanguage: sendResult.usedLanguage,
    usedType: sendResult.usedType
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
