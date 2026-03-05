import { createHmac, randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { getDbPool } from "../db/client.js";
import { createMlEvent } from "../db/mlRepo.js";
import {
  applyQuoteDecisionAtomic,
  createQuoteRequestIdempotent,
  getLatestPendingEditQuoteRequestByActor,
  getLatestPendingEditQuoteRequestByLead,
  getQuoteApprovalStats as getQuoteApprovalStatsRepo,
  getQuoteRequestById,
  type QuotePriceOption
} from "../db/quoteApprovalRepo.js";
import { searchCachedProductHandlesByText } from "../db/productPreviewsRepo.js";
import {
  getWhatsAppLeadById,
  listRecentWhatsAppLeadMessages,
  updateLeadQualification,
  updateWhatsAppLeadSignalFlags,
  updateWhatsAppLeadStage,
  type WhatsAppLeadMessage,
  type WhatsAppLeadRecord
} from "../db/whatsappLeadsRepo.js";
import { onMessagePersisted, type MessageTrackingMeta } from "./mlMessageTracking.js";
import { normalizePhoneE164 } from "./phoneCountry.js";
import { extractLatestPrice } from "./priceExtraction.js";
import { getProductPreviews } from "./shopifyProductPreviews.js";
import { applyStageProgression, detectConversationEvents, detectSignalsFromMessages } from "./conversationStageProgression.js";

type TeamDecision = "APPROVE" | "EDIT" | "READY" | "PRICE_OVERRIDE";

type InboundMessageLike = {
  id: string;
  text: string;
  createdAt: string;
  metadata?: Record<string, unknown> | null;
};

type ProductSnapshot = {
  handle: string;
  title: string;
  imageUrl: string | null;
  availability: Record<string, unknown>;
  basePriceAmount: number;
  currency: "USD" | "EUR" | "MAD";
};

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function firstString(values: unknown[]): string {
  for (const value of values) {
    const str = String(value || "").trim();
    if (str) return str;
  }
  return "";
}

function normalizeIsoDate(input: unknown): string {
  if (!input) return new Date().toISOString();
  if (input instanceof Date) {
    const ts = input.getTime();
    return Number.isFinite(ts) ? new Date(ts).toISOString() : new Date().toISOString();
  }
  const parsed = new Date(String(input));
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function isFeatureEnabled(): boolean {
  const raw = String(env.ENABLE_TEAM_QUOTE_APPROVAL || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function isAnalyticsEnabled(): boolean {
  const raw = String(env.ENABLE_TEAM_QUOTE_ANALYTICS || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function allowSameTeamAsLeadForTest(): boolean {
  const raw = String(env.ALLOW_TEAM_SAME_AS_LEAD_FOR_TEST || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function teamQuoteLanguage(): string {
  const rawInput = String(env.TEAM_QUOTE_TEMPLATE_LANG || env.ZOKO_TEMPLATE_LANGUAGE || "fr").trim();
  const raw = rawInput.toLowerCase();
  if (raw === "french") return "French";
  if (raw === "english") return "English";
  if (raw.startsWith("en")) return "en";
  if (raw.startsWith("fr")) return "fr";
  return rawInput || "fr";
}

function normalizeTeamNumber(): string {
  return normalizePhoneE164(String(env.WHATSAPP_TEAM_NUMBER || "").trim());
}

function zokoAuthHeader(): { key: string; value: string } {
  const authHeader = String(env.ZOKO_AUTH_HEADER || "apikey").trim();
  const authPrefix = String(env.ZOKO_AUTH_PREFIX || "").trim();
  const token = String(env.ZOKO_AUTH_TOKEN || "").trim();
  return {
    key: authHeader,
    value: authPrefix ? `${authPrefix} ${token}` : token
  };
}

function extractHandlesFromText(text: string): string[] {
  const src = String(text || "");
  const patterns = [
    /\/products\/([a-z0-9][a-z0-9\-]*)/gi,
    /\/collections\/[^/\s]+\/products\/([a-z0-9][a-z0-9\-]*)/gi
  ];
  const out: string[] = [];
  for (const pattern of patterns) {
    let match = pattern.exec(src);
    while (match) {
      const handle = String(match[1] || "").trim().toLowerCase();
      if (handle) out.push(handle);
      match = pattern.exec(src);
    }
  }
  return Array.from(new Set(out));
}

function extractProductLinksFromText(text: string): Array<{ url: string; handle: string }> {
  const src = String(text || "");
  const linkPattern = /https?:\/\/[^\s]+/gi;
  const out: Array<{ url: string; handle: string }> = [];
  let match = linkPattern.exec(src);
  while (match) {
    const rawUrl = String(match[0] || "").trim();
    try {
      const parsed = new URL(rawUrl);
      const path = String(parsed.pathname || "");
      const handleMatch = path.match(/\/products\/([a-z0-9][a-z0-9\-]*)/i);
      const handle = String(handleMatch?.[1] || "").trim().toLowerCase();
      if (handle) {
        out.push({
          url: `${parsed.origin}${parsed.pathname}`,
          handle
        });
      }
    } catch {
      // ignore malformed URLs
    }
    match = linkPattern.exec(src);
  }
  return out;
}

function textLooksLikeProductQuestion(text: string): boolean {
  const normalized = String(text || "").toLowerCase();
  return [
    "price",
    "prix",
    "disponible",
    "available",
    "availability",
    "stock",
    "combien",
    "how much",
    "article",
    "produit",
    "product"
  ].some((token) => normalized.includes(token));
}

function roundMoney(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value);
}

function normalizeAbsoluteHttpsUrl(raw: string): string | null {
  const value = String(raw || "").trim();
  if (!value) return null;
  const withProtocol = value.startsWith("//") ? `https:${value}` : value;
  try {
    const parsed = new URL(withProtocol);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    const protocol = parsed.protocol === "http:" ? "https:" : parsed.protocol;
    // Meta media URL validation is strict; keep a clean absolute URI.
    // Drop query/hash and encode path to avoid invalid-URI rejections.
    const encodedPath = encodeURI(parsed.pathname || "/");
    return `${protocol}//${parsed.host}${encodedPath}`;
  } catch {
    return null;
  }
}

function buildSignedImageProxyUrl(sourceUrl: string): string | null {
  const normalized = normalizeAbsoluteHttpsUrl(sourceUrl);
  if (!normalized) return null;
  const appUrl = String(env.SHOPIFY_APP_URL || "").trim().replace(/\/+$/, "");
  if (!appUrl) return normalized;
  const secret = String(env.ZOKO_AUTH_TOKEN || "quote_proxy_secret");
  const signature = createHmac("sha256", secret).update(normalized).digest("hex");
  return `${appUrl}/api/quote-approval/image-proxy?u=${encodeURIComponent(normalized)}&s=${signature}`;
}

function formatAmount(amount: number, currency: "USD" | "EUR" | "MAD"): string {
  if (currency === "USD") {
    return `$${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.round(amount))}`;
  }
  if (currency === "EUR") {
    return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(Math.round(amount)).replace(/\u202f/g, " ")}€`;
  }
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(Math.round(amount)).replace(/\u202f/g, " ")} MAD`;
}

export function isQuoteApprovalReadyForClientSend(input: {
  stage?: string | null;
  detectedSignals?: Record<string, unknown> | null;
}): boolean {
  const stage = String(input.stage || "").trim().toUpperCase();
  if (stage === "PRICE_APPROVED_READY_TO_SEND") return true;
  const qa = toRecord(toRecord(input.detectedSignals || {}).quote_approval);
  const price = toRecord(qa.price);
  const recommendation = String(qa.stage_recommendation || "").trim().toUpperCase();
  const approvedAmount = Number(price.approved_amount);
  const approved = price.approved === true || (Number.isFinite(approvedAmount) && approvedAmount > 0);
  return approved && (recommendation === "PRICE_APPROVED_READY_TO_SEND" || !recommendation);
}

export function composeApprovedQuoteClientText(input: {
  language?: "fr" | "en";
  productTitle: string;
  formattedPrice: string;
  productionMode: "MADE_TO_ORDER" | "READY_PIECE";
  deliveryEstimate?: string | null;
}): string {
  const lang = input.language === "en" ? "en" : "fr";
  const deliveryLine = String(input.deliveryEstimate || "").trim();
  if (lang === "en") {
    if (input.productionMode === "READY_PIECE") {
      return [
        "Thank you for your patience.",
        `Product: ${input.productTitle}`,
        `Approved price: ${input.formattedPrice}`,
        "Availability: ready piece (immediate dispatch).",
        deliveryLine || "Estimated dispatch: within 3-5 days."
      ].join("\n");
    }
    return [
      "Thank you for your message.",
      `Product: ${input.productTitle}`,
      `Approved price: ${input.formattedPrice}`,
      "Production mode: made-to-order.",
      deliveryLine || "Estimated lead time: 3 weeks."
    ].join("\n");
  }
  if (input.productionMode === "READY_PIECE") {
    return [
      "Merci pour votre confiance.",
      `Produit : ${input.productTitle}`,
      `Prix valide : ${input.formattedPrice}`,
      "Disponibilite : piece prete (envoi immediat).",
      deliveryLine || "Expedition estimee : sous 3 a 5 jours."
    ].join("\n");
  }
  return [
    "Merci pour votre message.",
    `Produit : ${input.productTitle}`,
    `Prix valide : ${input.formattedPrice}`,
    "Mode de confection : sur mesure.",
    deliveryLine || "Delai estime : 3 semaines."
  ].join("\n");
}

function countryDisplayName(input: unknown): string {
  const raw = String(input || "").trim();
  if (!raw) return "-";
  const iso = raw.toUpperCase();
  const map: Record<string, string> = {
    MA: "Morocco",
    FR: "France",
    ES: "Spain",
    IT: "Italy",
    DE: "Germany",
    GB: "United Kingdom",
    US: "United States",
    CA: "Canada",
    AE: "United Arab Emirates",
    QA: "Qatar",
    SA: "Saudi Arabia"
  };
  return map[iso] || raw;
}

function countryFlagEmoji(input: unknown): string {
  const raw = String(input || "").trim().toUpperCase();
  const code = raw.length === 2 ? raw : "";
  if (!/^[A-Z]{2}$/.test(code)) return "🌍";
  const base = 127397;
  return String.fromCodePoint(code.charCodeAt(0) + base) + String.fromCodePoint(code.charCodeAt(1) + base);
}

function buildPriceOptions(input: { amount: number; currency: "USD" | "EUR" | "MAD" }): QuotePriceOption[] {
  const a = roundMoney(input.amount);
  const b = roundMoney(a * 1.1);
  const c = roundMoney(a * 1.2);
  return [
    {
      id: "A",
      label: "Valider A",
      amount: a,
      currency: input.currency
    },
    {
      id: "B",
      label: "Valider B",
      amount: Math.max(a + 1, b),
      currency: input.currency
    },
    {
      id: "C",
      label: "Valider C",
      amount: Math.max(a + 2, c),
      currency: input.currency
    }
  ];
}

async function fetchProductSnapshot(handle: string, options?: { productUrl?: string | null }): Promise<ProductSnapshot | null> {
  const normalizedHandle = String(handle || "").trim().toLowerCase();
  if (!normalizedHandle) return null;

  const previewMap = await getProductPreviews([normalizedHandle]);
  const preview = previewMap[normalizedHandle] || null;

  const shop = String(env.SHOPIFY_SHOP || "").trim();
  let baseAmount = 0;
  let currency: "USD" | "EUR" | "MAD" = "MAD";
  let source = "preview";
  let imageFromProductJs: string | null = null;
  let imageFromProductPage: string | null = null;

  if (shop) {
    try {
      const res = await fetch(`https://${shop}/products/${normalizedHandle}.js`);
      if (res.ok) {
        const product = (await res.json()) as Record<string, unknown>;
        const variants = Array.isArray(product.variants) ? product.variants : [];
        const featuredImageRaw = String(product.featured_image || "").trim();
        const firstImageRaw = Array.isArray(product.images) && product.images[0]
          ? String(product.images[0] || "").trim()
          : "";
        imageFromProductJs =
          normalizeAbsoluteHttpsUrl(featuredImageRaw) ||
          normalizeAbsoluteHttpsUrl(firstImageRaw) ||
          null;
        const firstVariant = variants[0] && typeof variants[0] === "object" ? (variants[0] as Record<string, unknown>) : {};
        const firstPrice = Number(firstVariant.price);
        if (Number.isFinite(firstPrice) && firstPrice > 0) {
          baseAmount = roundMoney(firstPrice / 100);
        }
        source = "shopify_product_js";
      }
    } catch {
      // keep fallback
    }
  }

  const productUrl = normalizeAbsoluteHttpsUrl(String(options?.productUrl || "").trim());
  if (productUrl && !imageFromProductJs) {
    try {
      const res = await fetch(productUrl, {
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; QuoteApprovalBot/1.0)"
        }
      });
      if (res.ok) {
        const html = await res.text();
        const ogMatch =
          html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
          html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) ||
          html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i) ||
          html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
        const candidate = String(ogMatch?.[1] || "").trim();
        imageFromProductPage = normalizeAbsoluteHttpsUrl(candidate);
        if (imageFromProductPage) {
          source = source === "shopify_product_js" ? "shopify_product_js+product_page_meta" : "product_page_meta";
        }
      }
    } catch {
      // keep fallback
    }
  }

  if (!baseAmount) {
    const titleLower = String(preview?.title || normalizedHandle).toLowerCase();
    if (titleLower.includes("takchita")) {
      baseAmount = 3500;
      currency = "EUR";
    } else if (titleLower.includes("kaftan")) {
      baseAmount = 2800;
      currency = "EUR";
    } else if (titleLower.includes("kimono")) {
      baseAmount = 1800;
      currency = "EUR";
    } else {
      baseAmount = 3000;
      currency = "MAD";
    }
  }

  return {
    handle: normalizedHandle,
    title: String(preview?.title || normalizedHandle.replace(/[-_]+/g, " ")).trim(),
    imageUrl:
      normalizeAbsoluteHttpsUrl(String(preview?.image_url || "").trim()) ||
      imageFromProductJs ||
      imageFromProductPage ||
      null,
    availability: {
      status: "made_to_order",
      made_to_order: true,
      stock_tracking: "disabled",
      source,
      checked_at: new Date().toISOString()
    },
    basePriceAmount: baseAmount,
    currency
  };
}

type ZokoSendResult = {
  ok: boolean;
  status: number | null;
  statusText?: string;
  error?: string;
  body?: string;
};

type TeamQuoteSendDebug = {
  ok: boolean;
  quoteRequestId: string;
  attempts: Array<{
    label: string;
    ok: boolean;
    status: number | null;
    error?: string;
    responseBody?: unknown;
  }>;
};

async function sendRawZokoMessage(payload: Record<string, unknown>): Promise<ZokoSendResult> {
  const apiUrl = String(env.ZOKO_API_URL || "").trim();
  const auth = zokoAuthHeader();
  if (!apiUrl || !auth.value) {
    return { ok: false, status: null, error: "zoko_not_configured" };
  }

  try {
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [auth.key]: auth.value
      },
      body: JSON.stringify(payload)
    });
    const bodyText = await res.text().catch(() => "");
    if (!res.ok) {
      const imageCandidate =
        payload && typeof payload.image === "object" && payload.image
          ? String((payload.image as Record<string, unknown>).link || "")
          : typeof payload.image === "string"
            ? String(payload.image)
            : "";
      console.warn("[quote-approval] zoko send failed", {
        status: res.status,
        statusText: res.statusText,
        body: bodyText.slice(0, 400),
        payloadKeys: Object.keys(payload || {}),
        ...(imageCandidate ? { imageLink: imageCandidate } : {})
      });
    }
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      body: bodyText
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      error: error instanceof Error ? error.message : String(error || "request_failed")
    };
  }
}

async function sendTeamProductImage(input: {
  recipient: string;
  imageUrl: string;
  caption: string;
}): Promise<{ ok: boolean; attempts: TeamQuoteSendDebug["attempts"] }> {
  const normalizedImageUrl = normalizeAbsoluteHttpsUrl(input.imageUrl);
  if (!normalizedImageUrl) {
    return {
      ok: false,
      attempts: [{ label: "image_url_validation", ok: false, status: null, error: "invalid_image_url" }]
    };
  }
  const proxiedImageUrl = buildSignedImageProxyUrl(normalizedImageUrl) || normalizedImageUrl;
  const attempts: Array<Record<string, unknown>> = [
    {
      channel: String(env.ZOKO_CHANNEL || "whatsapp").trim(),
      recipient: input.recipient,
      type: "image",
      image: {
        link: proxiedImageUrl
      },
      message: input.caption
    },
    {
      channel: String(env.ZOKO_CHANNEL || "whatsapp").trim(),
      recipient: input.recipient,
      type: "image",
      image: {
        link: normalizedImageUrl
      },
      message: input.caption
    }
  ];

  const debugAttempts: TeamQuoteSendDebug["attempts"] = [];
  for (let i = 0; i < attempts.length; i += 1) {
    const res = await sendRawZokoMessage(attempts[i]);
    debugAttempts.push({
      label: `image_variant_${i + 1}`,
      ok: res.ok,
      status: res.status,
      ...(res.error ? { error: res.error } : {})
    });
    if (res.ok) return { ok: true, attempts: debugAttempts };
  }
  return { ok: false, attempts: debugAttempts };
}

function formatQuoteOptions(options: QuotePriceOption[]): string {
  return options
    .map((option) => {
      const amount = Number(option.amount || 0);
      const currency = String(option.currency || "MAD").toUpperCase();
      const formatted = currency === "USD"
        ? `$${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.round(amount))}`
        : currency === "EUR"
          ? `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(Math.round(amount)).replace(/\u202f/g, " ")}€`
          : `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(Math.round(amount)).replace(/\u202f/g, " ")} MAD`;
      return `${option.id}: ${formatted}`;
    })
    .join(" | ");
}

function bestSuggestedOption(options: QuotePriceOption[]): QuotePriceOption | null {
  const list = Array.isArray(options) ? options : [];
  return (
    list.find((opt) => String(opt.id || "").toUpperCase() === "A") ||
    list[0] ||
    null
  );
}

function extractNumericAmount(input: string): number | null {
  const text = String(input || "").trim();
  if (!text) return null;
  const m = text.match(/([0-9][0-9\s.,]*)(?:\s*(k|K))?/);
  if (!m) return null;
  let raw = String(m[1] || "").replace(/\s+/g, "");
  const hasK = Boolean(m[2]);
  if (!raw) return null;
  const lastDot = raw.lastIndexOf(".");
  const lastComma = raw.lastIndexOf(",");
  const sep = Math.max(lastDot, lastComma);
  if (sep >= 0) {
    const decimals = raw.length - sep - 1;
    if (decimals <= 2) {
      raw = raw.slice(0, sep).replace(/[.,]/g, "") + "." + raw.slice(sep + 1).replace(/[.,]/g, "");
    } else {
      raw = raw.replace(/[.,]/g, "");
    }
  }
  let amount = Number(raw);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (hasK) amount *= 1000;
  return Math.round(amount);
}

function buildValidationInfoBlock(input: {
  clientName: string;
  productTitle: string;
  suggestedPrice: string;
  currency: string;
}): string {
  return [
    "Validation interne requise",
    "",
    `Client : ${input.clientName}`,
    `Produit : ${input.productTitle}`,
    `Prix suggéré : ${input.suggestedPrice} ${input.currency}`,
    "Mode par défaut : Sur mesure"
  ].join("\n");
}

function buildTeamTemplateArgs(input: {
  templateName: string;
  headerImageUrl: string;
  quoteRequestId: string;
  clientName: string;
  clientCountry: string;
  productTitle: string;
  suggestedPrice: string;
  optionA: string;
  optionB: string;
  optionC: string;
}): string[][] {
  const template = String(input.templateName || "").trim().toLowerCase();
  const fullName = String(input.clientName || "Client").trim() || "Client";
  const flag = countryFlagEmoji(input.clientCountry);
  const qaApprove = `qa:${input.quoteRequestId}:APPROVE`;
  const qaEdit = `qa:${input.quoteRequestId}:EDIT`;
  const qaReady = `qa:${input.quoteRequestId}:READY`;

  if (template === "team_quote_approval_v2_new") {
    // Try multiple argument shapes to match Zoko template parser:
    // with/without header media arg and with/without dynamic quick-reply payload args.
    return [
      [input.headerImageUrl, fullName, flag, input.productTitle, input.suggestedPrice, qaApprove, qaEdit, qaReady],
      [input.headerImageUrl, fullName, flag, input.productTitle, input.suggestedPrice],
      [fullName, flag, input.productTitle, input.suggestedPrice, qaApprove, qaEdit, qaReady],
      [fullName, flag, input.productTitle, input.suggestedPrice]
    ];
  }

  if (template === "team_quote_approval_v2") {
    // v2 needs 9 args in Zoko:
    // 1 header image URL + 2..6 body vars + 7..9 quick-reply payload vars.
    return [[
      input.headerImageUrl,
      fullName,
      countryDisplayName(input.clientCountry),
      input.optionA,
      input.optionB,
      input.optionC,
      `qa:${input.quoteRequestId}:A`,
      `qa:${input.quoteRequestId}:B`,
      `qa:${input.quoteRequestId}:C`
    ]];
  }

  // Legacy template compatibility.
  return [[
    input.headerImageUrl,
    fullName,
    countryDisplayName(input.clientCountry),
    input.optionA,
    input.optionB,
    input.optionC,
    qaApprove,
    qaEdit,
    qaReady
  ]];
}

function availabilityLabel(status: string): string {
  if (status === "in_stock") return "en stock";
  if (status === "out") return "indisponible";
  if (status === "made_to_order") return "sur commande";
  return status || "inconnu";
}

async function sendTeamQuoteApprovalTemplate(input: {
  templateName: string;
  quoteRequestId: string;
  recipient: string;
  clientName: string;
  clientCountry: string;
  priceOptions: QuotePriceOption[];
  productImageUrl: string | null;
}): Promise<{
  ok: boolean;
  status: number | null;
  error?: string;
  responseBody?: unknown;
  requestPayload?: Record<string, unknown>;
}> {
  const templateName = String(input.templateName || "").trim();
  const apiUrl = String(env.ZOKO_SEND_TEMPLATE_API_URL || env.ZOKO_API_URL || "").trim();
  const auth = zokoAuthHeader();
  if (!templateName) return { ok: false, status: null, error: "missing_template_name" };
  if (!apiUrl || !auth.value) return { ok: false, status: null, error: "zoko_not_configured" };

  const lang = teamQuoteLanguage().startsWith("en") ? "en" : "fr";
  const optionA = input.priceOptions.find((opt) => opt.id === "A");
  const optionB = input.priceOptions.find((opt) => opt.id === "B");
  const optionC = input.priceOptions.find((opt) => opt.id === "C");
  const fallbackAmount = Number(optionB?.amount || optionA?.amount || 0);
  const fallbackCurrency = (optionB?.currency || optionA?.currency || "MAD") as "USD" | "EUR" | "MAD";
  const imageUrl = normalizeAbsoluteHttpsUrl(String(input.productImageUrl || "").trim());
  if (!imageUrl) {
    return { ok: false, status: null, error: "missing_template_image_url" };
  }
  const argsVariants = buildTeamTemplateArgs({
    templateName,
    headerImageUrl: imageUrl,
    quoteRequestId: input.quoteRequestId,
    clientName: String(input.clientName || "Client").trim() || "Client",
    clientCountry: countryDisplayName(input.clientCountry),
    productTitle: String((await getQuoteRequestById(input.quoteRequestId))?.productTitle || "Produit"),
    suggestedPrice: optionA ? formatAmount(Number(optionA.amount || 0), optionA.currency) : "-",
    optionA: optionA ? formatAmount(Number(optionA.amount || 0), optionA.currency) : "-",
    optionB: optionB ? formatAmount(Number(optionB.amount || 0), optionB.currency) : "-",
    optionC: optionC
      ? formatAmount(Number(optionC.amount || 0), optionC.currency)
      : (fallbackAmount > 0 ? formatAmount(Math.round(fallbackAmount * 1.2), fallbackCurrency) : "-")
  });

  const sendOnce = async (requestPayload: Record<string, unknown>) => {
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [auth.key]: auth.value
      },
      body: JSON.stringify(requestPayload)
    });
    const raw = await res.text().catch(() => "");
    let parsed: unknown = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = raw;
    }
    return { ok: res.ok, status: res.status, parsed };
  };

  try {
    for (const args of argsVariants) {
      const payload: Record<string, unknown> = {
        channel: String(env.ZOKO_CHANNEL || "whatsapp").trim(),
        recipient: input.recipient,
        type: "buttonTemplate",
        templateId: templateName,
        templateLanguage: lang,
        templateArgs: args
      };
      const primary = await sendOnce(payload);
      if (primary.ok) {
        return {
          ok: true,
          status: primary.status,
          responseBody: primary.parsed,
          requestPayload: payload
        };
      }
      const primaryMessage =
        primary.parsed && typeof primary.parsed === "object"
          ? String((primary.parsed as Record<string, unknown>).message || "")
          : "";
      if (!/not a valid uri|valid URI/i.test(primaryMessage)) {
        return {
          ok: false,
          status: primary.status,
          error: "zoko_template_send_failed",
          responseBody: primary.parsed,
          requestPayload: payload
        };
      }
    }

    return {
      ok: false,
      status: 400,
      error: "zoko_template_send_failed",
      responseBody: { message: "all_template_arg_variants_failed" }
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      error: error instanceof Error ? error.message : String(error || "template_send_failed")
    };
  }
}

async function sendTeamQuoteMessageInternal(quoteRequestId: string): Promise<TeamQuoteSendDebug> {
  const attempts: TeamQuoteSendDebug["attempts"] = [];
  const request = await getQuoteRequestById(quoteRequestId);
  if (!request) return { ok: false, quoteRequestId, attempts: [{ label: "load_quote_request", ok: false, status: null, error: "quote_request_not_found" }] };

  const teamNumber = normalizeTeamNumber();
  if (!teamNumber) {
    console.warn("[quote-approval] WHATSAPP_TEAM_NUMBER missing; skipping team send", { quoteRequestId });
    return { ok: false, quoteRequestId, attempts: [{ label: "validate_team_number", ok: false, status: null, error: "missing_team_number" }] };
  }
  const lead = await getWhatsAppLeadById(request.leadId);
  const leadPhone = normalizePhoneE164(String(lead?.phoneNumber || ""));
  if (leadPhone && leadPhone === teamNumber && !allowSameTeamAsLeadForTest()) {
    console.warn("[quote-approval] team number matches lead phone; skipping team send", {
      quoteRequestId,
      leadId: request.leadId,
      teamNumber
    });
    return { ok: false, quoteRequestId, attempts: [{ label: "validate_team_number", ok: false, status: null, error: "team_number_equals_lead_phone" }] };
  }

  const optionA = bestSuggestedOption(request.priceOptions);
  const amount = Number(optionA?.amount || 0);
  const currency = String(optionA?.currency || "MAD").toUpperCase();
  const infoBlock = buildValidationInfoBlock({
    clientName: String(lead?.clientName || "Client").trim() || "Client",
    productTitle: request.productTitle,
    suggestedPrice: Number.isFinite(amount) && amount > 0 ? String(Math.round(amount)) : "-",
    currency
  });
  const introTextPayload: Record<string, unknown> = {
    channel: String(env.ZOKO_CHANNEL || "whatsapp").trim(),
    recipient: teamNumber,
    type: "text",
    message: infoBlock
  };
  const teamQuoteTemplateName = String(
    env.TEAM_QUOTE_TEMPLATE_NAME || env.ZOKO_TEAM_QUOTE_TEMPLATE_NAME || "team_quote_approval_v2_new"
  ).trim();
  if (teamQuoteTemplateName) {
    const templateSend = await sendTeamQuoteApprovalTemplate({
      templateName: teamQuoteTemplateName,
      quoteRequestId: request.id,
      recipient: teamNumber,
      clientName: String(lead?.clientName || "Client"),
      clientCountry: String(lead?.country || "-"),
      priceOptions: request.priceOptions,
      productImageUrl: request.productImageUrl
    });
    attempts.push({
      label: "template_buttonTemplate",
      ok: templateSend.ok,
      status: templateSend.status ?? (templateSend.ok ? 200 : null),
      ...(templateSend.error ? { error: templateSend.error } : {}),
      ...(templateSend.responseBody !== undefined ? { responseBody: templateSend.responseBody } : {})
    });
    if (templateSend.ok) {
      return { ok: true, quoteRequestId, attempts };
    }
  } else {
    const introRes = await sendRawZokoMessage(introTextPayload);
    attempts.push({
      label: "info_text",
      ok: introRes.ok,
      status: introRes.status,
      ...(introRes.error ? { error: introRes.error } : {})
    });
  }

  const interactivePayloads: Array<Record<string, unknown>> = [
    {
      channel: String(env.ZOKO_CHANNEL || "whatsapp").trim(),
      recipient: teamNumber,
      type: "interactive_button",
      message: "Choisir une action",
      interactiveButton: [
        { id: `qa:${quoteRequestId}:APPROVE`, title: "💰 Valider prix suggéré" },
        { id: `qa:${quoteRequestId}:EDIT`, title: "✏️ Modifier prix" },
        { id: `qa:${quoteRequestId}:READY`, title: "⚡ Pièce prête" }
      ]
    },
    {
      channel: String(env.ZOKO_CHANNEL || "whatsapp").trim(),
      recipient: teamNumber,
      type: "text",
      message:
        "Actions fallback:\n" +
        `qa:${quoteRequestId}:APPROVE\nqa:${quoteRequestId}:EDIT\nqa:${quoteRequestId}:READY`
    }
  ];

  for (let i = 0; i < interactivePayloads.length; i += 1) {
    const res = await sendRawZokoMessage(interactivePayloads[i]);
    attempts.push({
      label: i === 0 ? "interactive_button" : "text_fallback",
      ok: res.ok,
      status: res.status,
      ...(res.error ? { error: res.error } : {})
    });
    if (res.ok) {
      return { ok: true, quoteRequestId, attempts };
    }
  }

  return { ok: false, quoteRequestId, attempts };
}

export async function sendTeamQuoteMessage(quoteRequestId: string): Promise<boolean> {
  if (!isFeatureEnabled()) return false;
  const out = await sendTeamQuoteMessageInternal(quoteRequestId);
  return out.ok;
}

export async function sendTeamQuoteMessageDebug(quoteRequestId: string): Promise<TeamQuoteSendDebug> {
  if (!isFeatureEnabled()) {
    return {
      ok: false,
      quoteRequestId,
      attempts: [{ label: "feature_flag", ok: false, status: null, error: "feature_disabled" }]
    };
  }
  return sendTeamQuoteMessageInternal(quoteRequestId);
}

export async function sendTeamQuoteTemplateOnlyDebug(quoteRequestId: string): Promise<{
  ok: boolean;
  quoteRequestId: string;
  error?: string;
  status?: number | null;
  responseBody?: unknown;
  requestPayload?: Record<string, unknown>;
}> {
  if (!isFeatureEnabled()) {
    return { ok: false, quoteRequestId, error: "feature_disabled", status: null };
  }
  const request = await getQuoteRequestById(quoteRequestId);
  if (!request) return { ok: false, quoteRequestId, error: "quote_request_not_found", status: null };
  const teamNumber = normalizeTeamNumber();
  if (!teamNumber) return { ok: false, quoteRequestId, error: "missing_team_number", status: null };
  const lead = await getWhatsAppLeadById(request.leadId);
  const templateName = String(env.TEAM_QUOTE_TEMPLATE_NAME || env.ZOKO_TEAM_QUOTE_TEMPLATE_NAME || "").trim();
  const sent = await sendTeamQuoteApprovalTemplate({
    templateName,
    quoteRequestId: request.id,
    recipient: teamNumber,
    clientName: String(lead?.clientName || "Client"),
    clientCountry: String(lead?.country || "-"),
    priceOptions: request.priceOptions,
    productImageUrl: request.productImageUrl
  });
  return {
    ok: sent.ok,
    quoteRequestId,
    ...(sent.error ? { error: sent.error } : {}),
    status: sent.status,
    responseBody: sent.responseBody,
    requestPayload: sent.requestPayload
  };
}

async function sendTeamDecisionConfirmation(input: {
  message: string;
  amount?: number | null;
  currency?: "USD" | "EUR" | "MAD" | null;
}): Promise<void> {
  const teamNumber = normalizeTeamNumber();
  if (!teamNumber) return;
  await sendRawZokoMessage({
    channel: String(env.ZOKO_CHANNEL || "whatsapp").trim(),
    recipient: teamNumber,
    type: "text",
    message: input.message
  });
}

async function recomputeLeadAnalyzerState(leadId: string): Promise<void> {
  const lead = await getWhatsAppLeadById(leadId);
  if (!lead) return;

  const recent = await listRecentWhatsAppLeadMessages(lead.id, 30);
  const signalDetection = detectSignalsFromMessages(
    recent.map((m) => ({
      id: m.id,
      direction: m.direction,
      text: m.text,
      createdAt: m.createdAt
    })),
    lead
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

  const refreshed = await getWhatsAppLeadById(lead.id);
  if (!refreshed) return;
  const progression = applyStageProgression(
    refreshed,
    detectConversationEvents(
      recent.map((m) => ({
        id: m.id,
        direction: m.direction,
        text: m.text,
        createdAt: m.createdAt
      })),
      refreshed
    ),
    {
      paymentReceived: refreshed.paymentReceived,
      depositPaid: refreshed.depositPaid,
      hasPaidShopifyOrder: refreshed.stage === "CONVERTED",
      shopifyFinancialStatus: refreshed.shopifyFinancialStatus
    }
  );

  if (progression.changed && String(refreshed.channelType || "API").toUpperCase() !== "SHARED") {
    await updateWhatsAppLeadStage({
      id: refreshed.id,
      stage: progression.nextStage,
      stageAuto: true,
      stageConfidence: progression.confidence == null ? null : progression.confidence / 100,
      stageAutoReason: progression.reason || "conversation_progression",
      stageAutoSourceMessageId: progression.sourceMessageId,
      stageAutoConfidence: progression.confidence,
      source: "quote_approval_auto"
    });
  }
}

async function updateLeadQuoteFacts(input: {
  lead: WhatsAppLeadRecord;
  quoteRequestId: string;
  productHandle: string;
  productTitle: string;
  productImageUrl: string | null;
  decision: TeamDecision;
  approvedAmount: number | null;
  approvedCurrency: "USD" | "EUR" | "MAD" | null;
  approvedOptionId: string | null;
}): Promise<void> {
  const existing = toRecord(input.lead.detectedSignals || {});
  const existingQa = toRecord(existing.quote_approval);
  const existingPrice = toRecord(existingQa.price);
  const isReadyPiece =
    input.decision === "READY" ||
    String(existingQa.production_mode || "").toUpperCase() === "READY_PIECE";
  const approvedAmount =
    input.approvedAmount != null && Number.isFinite(Number(input.approvedAmount))
      ? Number(input.approvedAmount)
      : (existingPrice.approved_amount == null ? null : Number(existingPrice.approved_amount));
  const approvedCurrencyRaw =
    String(input.approvedCurrency || existingPrice.approved_currency || "").toUpperCase();
  const approvedCurrency =
    approvedCurrencyRaw === "USD" || approvedCurrencyRaw === "EUR" || approvedCurrencyRaw === "MAD"
      ? (approvedCurrencyRaw as "USD" | "EUR" | "MAD")
      : null;
  const stageRecommendation =
    input.decision === "EDIT"
      ? "PRICE_EDIT_REQUIRED"
      : approvedAmount != null
        ? "PRICE_APPROVED_READY_TO_SEND"
        : undefined;
  const next = {
    ...existing,
    quote_approval: {
      quote_request_id: input.quoteRequestId,
      ...(stageRecommendation ? { stage_recommendation: stageRecommendation } : {}),
      product: {
        handle: input.productHandle,
        title: input.productTitle,
        image_url: input.productImageUrl
      },
      production_mode: isReadyPiece ? "READY_PIECE" : "MADE_TO_ORDER",
      ...(isReadyPiece ? { delivery_type: "IMMEDIATE" } : {}),
      price: {
        approved: approvedAmount != null,
        approved_amount: approvedAmount,
        approved_currency: approvedCurrency,
        option_id: input.approvedOptionId,
        source: input.decision === "PRICE_OVERRIDE" ? "manager_override" : "team_approved"
      },
      approved_at: new Date().toISOString()
    }
  };

  await updateLeadQualification({
    id: input.lead.id,
    detectedSignals: next as any,
    recommendedStage: input.lead.recommendedStage,
    recommendedStageReason: stageRecommendation || input.lead.recommendedStageReason,
    recommendedStageConfidence: stageRecommendation === "PRICE_APPROVED_READY_TO_SEND" ? 0.95 : 0.8
  });
}

async function triggerAnalyzerEntrypoint(leadId: string, text: string, source: MessageTrackingMeta["source"]): Promise<void> {
  const synthetic: WhatsAppLeadMessage = {
    id: randomUUID(),
    leadId,
    direction: "OUT",
    text,
    provider: "system",
    messageType: "text",
    templateName: null,
    externalId: null,
    metadata: {
      quote_approval: true,
      synthetic: true
    },
    createdAt: new Date().toISOString()
  };

  await onMessagePersisted(leadId, synthetic, {
    source,
    ui_source: "team_quote_approval"
  });
  await recomputeLeadAnalyzerState(leadId);
}

async function ensureLeadDefaultProductionMode(lead: WhatsAppLeadRecord): Promise<void> {
  const existing = toRecord(lead.detectedSignals || {});
  const qa = toRecord(existing.quote_approval);
  if (String(qa.production_mode || "").trim()) return;
  const next = {
    ...existing,
    quote_approval: {
      ...qa,
      production_mode: "MADE_TO_ORDER"
    }
  };
  await updateLeadQualification({
    id: lead.id,
    detectedSignals: next as any,
    recommendedStage: lead.recommendedStage,
    recommendedStageReason: lead.recommendedStageReason,
    recommendedStageConfidence: lead.recommendedStageConfidence
  });
}

export async function applyTeamDecision(params: {
  quoteRequestId: string;
  decision: TeamDecision;
  actor: string;
  overrideAmount?: number | null;
  overrideCurrency?: "USD" | "EUR" | "MAD" | null;
  skipTeamConfirmation?: boolean;
}): Promise<{ ok: boolean; leadId?: string; status?: "PENDING" | "APPROVED" | "REJECTED"; reason?: string }> {
  if (!isFeatureEnabled()) return { ok: false, reason: "feature_disabled" };
  const actor = String(params.actor || "team").trim() || "team";
  const atomic = await applyQuoteDecisionAtomic({
    quoteRequestId: params.quoteRequestId,
    decision: params.decision,
    actor,
    analyticsEnabled: isAnalyticsEnabled(),
    overrideAmount: params.overrideAmount,
    overrideCurrency: params.overrideCurrency || null
  });
  if (!atomic.ok) return { ok: false, reason: "quote_request_not_found" };

  const quoteRequest = atomic.record;
  if (!atomic.applied) {
    return {
      ok: true,
      leadId: quoteRequest.leadId,
      status: quoteRequest.status
    };
  }

  const lead = await getWhatsAppLeadById(quoteRequest.leadId);
  if (lead) {
    await updateLeadQuoteFacts({
      lead,
      quoteRequestId: quoteRequest.id,
      productHandle: quoteRequest.productHandle,
      productTitle: quoteRequest.productTitle,
      productImageUrl: quoteRequest.productImageUrl,
      decision: params.decision,
      approvedAmount: quoteRequest.approvedPriceAmount,
      approvedCurrency: quoteRequest.approvedCurrency,
      approvedOptionId: quoteRequest.approvedOptionId
    });
  }

  await createMlEvent({
    eventType: "INFERENCE",
    leadId: quoteRequest.leadId,
    source: "SYSTEM",
    payload: {
      inference: "team_quote_decision",
      quote_request_id: quoteRequest.id,
      decision: params.decision,
      amount: quoteRequest.approvedPriceAmount,
      currency: quoteRequest.approvedCurrency,
      product_handle: quoteRequest.productHandle,
      decision_time_seconds: atomic.decisionTimeSeconds
    }
  });

  await triggerAnalyzerEntrypoint(
    quoteRequest.leadId,
    params.decision === "EDIT"
      ? `TEAM_QUOTE_EDIT_REQUIRED ${quoteRequest.productHandle}`
      : params.decision === "READY"
        ? `TEAM_READY_PIECE ${quoteRequest.productHandle}`
        : `TEAM_QUOTE_APPROVED ${quoteRequest.productHandle} ${quoteRequest.approvedPriceAmount || ""} ${quoteRequest.approvedCurrency || ""}`,
    "OUTBOUND_MANUAL"
  );

  // Intentionally disabled: no automatic internal confirmation message after team decision.

  return {
    ok: true,
    leadId: quoteRequest.leadId,
    status: quoteRequest.status
  };
}

export function parseTeamDecisionWebhookPayload(body: Record<string, unknown>): {
  parsed: {
    quoteRequestId: string;
    decision: TeamDecision;
    actor: string;
  } | null;
  malformed: boolean;
  error?: string;
  actor?: string;
} {
  if (!isFeatureEnabled()) return { parsed: null, malformed: false };
  const data = toRecord(body.data);
  const payload = toRecord(body.payload);
  const event = toRecord(body.event);
  const message = toRecord(body.message);
  const interactive = toRecord(message.interactive);
  const buttonReply = toRecord(interactive.button_reply);
  const context = toRecord(message.context);

  const actorRaw = firstString([
    body.from,
    body.phone,
    body.phone_number,
    message.from,
    data.from,
    payload.from,
    event.from,
    context.from,
    firstString([toRecord(body.sender).phone, toRecord(body.sender).phone_number])
  ]);
  const actor = normalizePhoneE164(actorRaw);
  const team = normalizeTeamNumber();
  if (!team) return { parsed: null, malformed: false };
  if (actor && actor !== team) return { parsed: null, malformed: false };

  const directId = firstString([
    buttonReply.id,
    buttonReply.payload,
    message.button_payload,
    message.button_reply_id,
    body.button_payload,
    body.button_reply_id,
    data.button_payload,
    payload.button_payload,
    event.button_payload,
    body.interactive_reply_id,
    body.reply_id,
    body.payload_id
  ]);
  const deepCombined = JSON.stringify(body || {});
  const deepMatch = deepCombined.match(/qa:([0-9a-f\-]{36}):(APPROVE|EDIT|READY|A|B|C)/i);
  const textFallback = firstString([
    buttonReply.title,
    message.text,
    body.text,
    data.text,
    payload.text
  ]);
  const combined = `${directId} ${textFallback} ${deepMatch ? deepMatch[0] : ""}`.trim();
  if (!combined) {
    return { parsed: null, malformed: true, error: "team_payload_empty", actor: actor || team };
  }

  const qaMatch = combined.match(/qa:([0-9a-f\-]{36}):(A|B|C)/i);
  const modernMatch = combined.match(/qa:([0-9a-f\-]{36}):(APPROVE|EDIT|READY)/i);
  const target = modernMatch || qaMatch || deepMatch;
  if (!target) {
    return { parsed: null, malformed: true, error: "team_payload_missing_qa_token", actor: actor || team };
  }

  const decisionRaw = String(target[2] || "").trim().toUpperCase();
  const decision =
    decisionRaw === "A"
      ? "APPROVE"
      : decisionRaw === "B"
        ? "EDIT"
        : decisionRaw === "C"
          ? "READY"
          : (decisionRaw as TeamDecision);

  return {
    parsed: {
      quoteRequestId: String(target[1] || "").trim(),
      decision,
      actor: actor || team
    },
    malformed: false
  };
}

export function parseTeamDecisionFromWebhookPayload(body: Record<string, unknown>): {
  quoteRequestId: string;
  decision: TeamDecision;
  actor: string;
} | null {
  const parsed = parseTeamDecisionWebhookPayload(body);
  return parsed.parsed;
}

export async function createQuoteRequestsFromInbound(
  leadId: string,
  inboundMessage: InboundMessageLike
): Promise<{ created: number; quoteRequestIds: string[] }> {
  if (!isFeatureEnabled()) return { created: 0, quoteRequestIds: [] };

  const text = String(inboundMessage.text || "").trim();
  if (!text) return { created: 0, quoteRequestIds: [] };

  const productLinks = extractProductLinksFromText(text);
  const urlByHandle = new Map<string, string>();
  for (const item of productLinks) {
    if (!urlByHandle.has(item.handle)) urlByHandle.set(item.handle, item.url);
  }
  const byLink = Array.from(new Set(productLinks.map((item) => item.handle).concat(extractHandlesFromText(text))));
  if (!byLink.length && !textLooksLikeProductQuestion(text)) return { created: 0, quoteRequestIds: [] };
  const byCache = byLink.length ? [] : await searchCachedProductHandlesByText(text, 4);
  const handles = Array.from(new Set([...(byLink || []), ...(byCache || [])])).filter(Boolean);

  if (!handles.length) return { created: 0, quoteRequestIds: [] };

  const createdIds: string[] = [];
  for (const handle of handles) {
    const snapshot = await fetchProductSnapshot(handle, { productUrl: urlByHandle.get(handle) || null });
    if (!snapshot) continue;

    const options = buildPriceOptions({ amount: snapshot.basePriceAmount, currency: snapshot.currency });
    const { record: request, created } = await createQuoteRequestIdempotent({
      leadId,
      productHandle: snapshot.handle,
      productTitle: snapshot.title,
      productImageUrl: snapshot.imageUrl,
      availability: {
        ...snapshot.availability,
        inbound_message_id: inboundMessage.id,
        inbound_created_at: normalizeIsoDate(inboundMessage.createdAt)
      },
      priceOptions: options,
      withinMinutes: 5
    });
    if (!created) continue;
    createdIds.push(request.id);

    const lead = await getWhatsAppLeadById(leadId);
    if (lead) {
      await ensureLeadDefaultProductionMode(lead);
    }

    const sent = await sendTeamQuoteMessageInternal(request.id);
    if (!sent.ok) {
      console.warn("[quote-approval] failed to send team quote message", {
        quoteRequestId: request.id,
        leadId,
        handle,
        attempts: sent.attempts
      });
    }
  }

  return { created: createdIds.length, quoteRequestIds: createdIds };
}

export async function runQuoteApprovalScenario(input: {
  leadId: string;
  inboundText: string;
  approveDecision?: TeamDecision;
}): Promise<{ ok: boolean; created: number; approved?: TeamDecision | null }> {
  const created = await createQuoteRequestsFromInbound(input.leadId, {
    id: randomUUID(),
    text: input.inboundText,
    createdAt: new Date().toISOString()
  });

  if (!created.quoteRequestIds.length || !input.approveDecision) {
    return { ok: true, created: created.created, approved: null };
  }

  const decision = input.approveDecision;
  const actor = normalizeTeamNumber() || "team";
  await applyTeamDecision({
    quoteRequestId: created.quoteRequestIds[0],
    decision,
    actor
  });

  return {
    ok: true,
    created: created.created,
    approved: decision
  };
}

export async function getQuoteApprovalStats(rangeDays: number): Promise<{
  approval_rate: number;
  rejection_rate: number;
  avg_decision_time_seconds: number;
  count: number;
}> {
  if (!isAnalyticsEnabled()) {
    throw new Error("quote_analytics_disabled");
  }
  const stats = await getQuoteApprovalStatsRepo(rangeDays);
  return {
    approval_rate: stats.approvalRate,
    rejection_rate: stats.rejectionRate,
    avg_decision_time_seconds: stats.avgDecisionTimeSeconds,
    count: stats.count
  };
}

export async function applyTeamPriceOverrideFromMessage(input: {
  actor: string;
  text: string;
}): Promise<{ ok: boolean; applied: boolean; reason?: string }> {
  if (!isFeatureEnabled()) return { ok: false, applied: false, reason: "feature_disabled" };
  const actor = normalizePhoneE164(String(input.actor || "").trim());
  const team = normalizeTeamNumber();
  if (!actor || !team || actor !== team) return { ok: true, applied: false, reason: "not_team_actor" };
  const extracted = extractLatestPrice(String(input.text || ""));
  const amount = extracted?.amount || extractNumericAmount(input.text);
  if (!amount) return { ok: true, applied: false, reason: "not_numeric" };

  const pending = await getLatestPendingEditQuoteRequestByActor(actor);
  if (!pending) return { ok: true, applied: false, reason: "no_pending_edit_quote" };

  const result = await applyTeamDecision({
    quoteRequestId: pending.id,
    decision: "PRICE_OVERRIDE",
    actor,
    overrideAmount: amount,
    overrideCurrency: extracted?.currency || null
  });
  return { ok: result.ok, applied: result.ok, reason: result.reason };
}

export async function applyTeamPriceOverrideFromLeadOutbound(input: {
  leadId: string;
  text: string;
  actor?: string | null;
}): Promise<{ ok: boolean; applied: boolean; reason?: string; quoteRequestId?: string }> {
  if (!isFeatureEnabled()) return { ok: false, applied: false, reason: "feature_disabled" };
  const leadId = String(input.leadId || "").trim();
  if (!leadId) return { ok: false, applied: false, reason: "invalid_lead_id" };

  const extracted = extractLatestPrice(String(input.text || ""));
  const amount = extracted?.amount || extractNumericAmount(input.text);
  if (!amount) return { ok: true, applied: false, reason: "not_numeric" };

  const pending = await getLatestPendingEditQuoteRequestByLead(leadId);
  if (!pending) return { ok: true, applied: false, reason: "no_pending_edit_quote" };

  const result = await applyTeamDecision({
    quoteRequestId: pending.id,
    decision: "PRICE_OVERRIDE",
    actor: String(input.actor || "manager_ui").trim() || "manager_ui",
    overrideAmount: amount,
    overrideCurrency: extracted?.currency || null,
    skipTeamConfirmation: true
  });
  return {
    ok: result.ok,
    applied: result.ok,
    reason: result.reason,
    quoteRequestId: pending.id
  };
}
