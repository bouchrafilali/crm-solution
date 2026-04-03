import express from "express";
import crypto from "node:crypto";
import { env } from "./config/env.js";
import { connectDbWithRetry, initDb, isDbEnabled } from "./db/db.js";
import { listPersistedOrderPayloads } from "./db/ordersRepo.js";
import { adminRouter, startAppointmentsReminderWorker } from "./routes/admin.js";
import { healthRouter } from "./routes/health.js";
import { whatsappLabRouter } from "./routes/whatsappLab.js";
import { whatsappRouter } from "./routes/whatsappIntelligence.js";
import { zokoWebhookRouter } from "./routes/zokoWebhook.js";
import { registerOrdersDeleteWebhook, webhooksRouter } from "./routes/webhooks.js";
import { blueprintV2Router } from "./routes/blueprintV2.js";
import { mlAutomationRouter } from "./routes/mlAutomation.js";
import { agentControlCenterV1Router } from "./routes/agentControlCenterV1.js";
import { shopifyFilesUploadRouter } from "./routes/shopifyFilesUpload.js";
import { shoppingBrainRouter } from "./routes/shoppingBrain.js";
import { addManyOrderSnapshots } from "./services/orderSnapshots.js";
import { startZokoHistorySyncWorker } from "./services/zokoHistorySyncWorker.js";
import { startAuto24hFollowupWorker } from "./services/autoFollowUpRule.js";
import { startOperatorLearningLoopWorker } from "./services/operatorLearningLoopService.js";
import "./shopify/client.js";

const app = express();
app.use(express.json({
  limit: "10mb",
  verify: (req, _res, buf) => {
    (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
  }
}));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.use((req, res, next) => {
  const shopParam = typeof req.query.shop === "string" ? req.query.shop : "";
  const isValidShop = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shopParam);
  const frameAncestors = ["'self'", "https://admin.shopify.com", isValidShop ? `https://${shopParam}` : "https://*.myshopify.com"];

  res.setHeader("Content-Security-Policy", `frame-ancestors ${frameAncestors.join(" ")};`);
  next();
});

function isShopifyLaunch(req: express.Request): boolean {
  const hasHost = typeof req.query.host === "string" && req.query.host.trim().length > 0;
  const hasShop = typeof req.query.shop === "string" && req.query.shop.trim().length > 0;
  const embedded = typeof req.query.embedded === "string" ? req.query.embedded.trim().toLowerCase() : "";
  return hasHost || hasShop || embedded === "1" || embedded === "true";
}

const SHOPIFY_EMBEDDED_ACCESS_COOKIE = "__shopify_embedded_access";
const SHOPIFY_EMBEDDED_ACCESS_TTL_SECONDS = 12 * 60 * 60;
const SHOPIFY_EMBEDDED_ACCESS_QUERY = "ea";

function buildAdminNavSuffix(req: express.Request): string {
  const host = typeof req.query.host === "string" ? req.query.host : "";
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  const embedded = typeof req.query.embedded === "string" ? req.query.embedded : "";
  const embeddedAccess = typeof req.query[SHOPIFY_EMBEDDED_ACCESS_QUERY] === "string" ? req.query[SHOPIFY_EMBEDDED_ACCESS_QUERY] : "";
  const params = new URLSearchParams();
  if (host) params.set("host", host);
  if (shop) params.set("shop", shop);
  if (embedded) params.set("embedded", embedded);
  if (embeddedAccess) params.set(SHOPIFY_EMBEDDED_ACCESS_QUERY, embeddedAccess);
  const query = params.toString();
  return query ? `?${query}` : "";
}

function isTruthyFlag(value: string | undefined): boolean {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isLocalRequestIp(ip: string | undefined): boolean {
  const value = String(ip || "").trim().toLowerCase();
  return value === "127.0.0.1"
    || value === "::1"
    || value === "::ffff:127.0.0.1"
    || value === "localhost";
}

function isAdminAuthEnabled(): boolean {
  const configured = String(env.ADMIN_AUTH_ENABLED || "").trim().toLowerCase();
  if (configured) {
    return isTruthyFlag(configured);
  }
  return String(env.NODE_ENV || "").trim().toLowerCase() === "production";
}

function shouldBypassAdminAuth(req: express.Request): boolean {
  if (!isTruthyFlag(env.ADMIN_AUTH_BYPASS_LOCALHOST)) return false;
  return isLocalRequestIp(req.ip) || isLocalRequestIp(req.socket?.remoteAddress);
}

function unauthorized(res: express.Response): void {
  res.setHeader("WWW-Authenticate", 'Basic realm="Admin Area", charset="UTF-8"');
  res.status(401).send("Authentication required.");
}

function base64UrlEncode(value: Buffer): string {
  return value.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Buffer {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const paddingLength = normalized.length % 4 === 0 ? 0 : 4 - (normalized.length % 4);
  return Buffer.from(normalized + "=".repeat(paddingLength), "base64");
}

function parseCookieHeader(header: string | undefined): Map<string, string> {
  const values = new Map<string, string>();
  const source = String(header || "");
  if (!source) return values;
  for (const chunk of source.split(";")) {
    const separator = chunk.indexOf("=");
    if (separator <= 0) continue;
    const key = chunk.slice(0, separator).trim();
    const value = chunk.slice(separator + 1).trim();
    if (key) values.set(key, value);
  }
  return values;
}

function readCookie(req: express.Request, name: string): string {
  return parseCookieHeader(req.get("cookie")).get(name) || "";
}

function extractHostname(value: string | undefined): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? new URL(raw) : new URL(`https://${raw}`);
    return url.hostname.trim().toLowerCase();
  } catch {
    return "";
  }
}

function isTrustedShopifyHostname(value: string | undefined): boolean {
  const hostname = extractHostname(value).replace(/:\d+$/g, "");
  return hostname === "admin.shopify.com"
    || hostname.endsWith(".shopify.com")
    || hostname.endsWith(".myshopify.com")
    || hostname.endsWith(".shopifyapps.com");
}

function decodeShopifyHostParam(value: string | undefined): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    return base64UrlDecode(raw).toString("utf8").trim();
  } catch {
    return "";
  }
}

function hasTrustedShopifyLaunchParams(req: express.Request): boolean {
  const decodedHost = decodeShopifyHostParam(typeof req.query.host === "string" ? req.query.host : "");
  const requestShop = normalizeShopDomain(typeof req.query.shop === "string" ? req.query.shop : "");
  return !!requestShop && isTrustedShopifyHostname(decodedHost);
}

function isEmbeddedShopifyHtmlRequest(req: express.Request): boolean {
  if (!isShopifyLaunch(req)) return false;
  const method = String(req.method || "").trim().toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;
  const accept = String(req.get("accept") || "").toLowerCase();
  const fetchDest = String(req.get("sec-fetch-dest") || "").trim().toLowerCase();
  const wantsHtml = accept.includes("text/html") || fetchDest === "document" || fetchDest === "iframe";
  if (!wantsHtml) return false;
  return hasTrustedShopifyLaunchParams(req);
}

function isShopifyHtmlLaunchRequest(req: express.Request): boolean {
  if (!isShopifyLaunch(req)) return false;
  const method = String(req.method || "").trim().toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;
  const accept = String(req.get("accept") || "").toLowerCase();
  const fetchDest = String(req.get("sec-fetch-dest") || "").trim().toLowerCase();
  return accept.includes("text/html") || fetchDest === "document" || fetchDest === "iframe";
}

function normalizeShopDomain(value: string | undefined): string {
  const raw = String(value || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(raw) ? raw : "";
}

function hashUserAgent(req: express.Request): string {
  return crypto.createHash("sha256").update(String(req.get("user-agent") || "")).digest("hex");
}

function signEmbeddedAccessPayload(encodedPayload: string): string {
  return base64UrlEncode(
    crypto.createHmac("sha256", env.SHOPIFY_API_SECRET)
      .update("shopify-embedded-access:")
      .update(encodedPayload)
      .digest()
  );
}

function createEmbeddedAccessValue(req: express.Request): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    shop: normalizeShopDomain(typeof req.query.shop === "string" ? req.query.shop : ""),
    ua: hashUserAgent(req),
    iat: now,
    exp: now + SHOPIFY_EMBEDDED_ACCESS_TTL_SECONDS
  };
  const encodedPayload = base64UrlEncode(Buffer.from(JSON.stringify(payload), "utf8"));
  const signature = signEmbeddedAccessPayload(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

function issueEmbeddedAccessCookie(req: express.Request, res: express.Response, tokenValue?: string): string {
  const value = tokenValue || createEmbeddedAccessValue(req);
  const isProduction = String(env.NODE_ENV || "").trim().toLowerCase() === "production";

  res.cookie(SHOPIFY_EMBEDDED_ACCESS_COOKIE, value, {
    httpOnly: true,
    path: "/",
    maxAge: SHOPIFY_EMBEDDED_ACCESS_TTL_SECONDS * 1000,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax"
  });
  return value;
}

function readEmbeddedAccessTokenFromRequest(req: express.Request): string {
  const direct = typeof req.query[SHOPIFY_EMBEDDED_ACCESS_QUERY] === "string"
    ? req.query[SHOPIFY_EMBEDDED_ACCESS_QUERY]
    : "";
  if (direct) return String(direct);

  const referrer = String(req.get("referer") || "").trim();
  if (referrer) {
    try {
      const url = new URL(referrer);
      const fromReferrer = url.searchParams.get(SHOPIFY_EMBEDDED_ACCESS_QUERY) || "";
      if (fromReferrer) return fromReferrer;
    } catch {
      // ignore malformed referrer
    }
  }

  return readCookie(req, SHOPIFY_EMBEDDED_ACCESS_COOKIE);
}

function hasDirectEmbeddedAccessQuery(req: express.Request): boolean {
  return typeof req.query[SHOPIFY_EMBEDDED_ACCESS_QUERY] === "string"
    && req.query[SHOPIFY_EMBEDDED_ACCESS_QUERY].trim().length > 0;
}

function hasValidEmbeddedAccessToken(req: express.Request): boolean {
  const raw = readEmbeddedAccessTokenFromRequest(req);
  if (!raw) return false;
  const separator = raw.lastIndexOf(".");
  if (separator <= 0) return false;
  const encodedPayload = raw.slice(0, separator);
  const signature = raw.slice(separator + 1);
  const expectedSignature = signEmbeddedAccessPayload(encodedPayload);
  const providedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (providedBuffer.length !== expectedBuffer.length) return false;
  if (!crypto.timingSafeEqual(providedBuffer, expectedBuffer)) return false;

  try {
    const parsed = JSON.parse(base64UrlDecode(encodedPayload).toString("utf8")) as {
      exp?: number;
      ua?: string;
      shop?: string;
    };
    const expiresAt = Number(parsed.exp || 0);
    if (!Number.isFinite(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) {
      return false;
    }
    if (String(parsed.ua || "") !== hashUserAgent(req)) {
      return false;
    }
    const expectedShop = normalizeShopDomain(String(parsed.shop || ""));
    if (!expectedShop) return false;
    const requestShop = normalizeShopDomain(typeof req.query.shop === "string" ? req.query.shop : "");
    if (requestShop && requestShop !== expectedShop) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function withEmbeddedAccessQuery(req: express.Request, tokenValue: string): string {
  const baseUrl = `${req.protocol}://${req.get("host") || "localhost"}`;
  const current = new URL(req.originalUrl || req.url, baseUrl);
  current.searchParams.set(SHOPIFY_EMBEDDED_ACCESS_QUERY, tokenValue);
  return current.pathname + current.search;
}

function parseBasicAuth(header: string | undefined): { username: string; password: string } | null {
  const value = String(header || "").trim();
  if (!value.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(value.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return null;
    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1)
    };
  } catch {
    return null;
  }
}

function areValidAdminCredentials(username: string, password: string): boolean {
  const expectedUsername = String(env.ADMIN_AUTH_USERNAME || "");
  const expectedPassword = String(env.ADMIN_AUTH_PASSWORD || "");
  if (!expectedUsername || !expectedPassword) return false;

  const safeEquals = (left: string, right: string): boolean => {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    if (leftBuffer.length !== rightBuffer.length) return false;
    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
  };

  return safeEquals(username, expectedUsername) && safeEquals(password, expectedPassword);
}

function enforceAdminBasicAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!isAdminAuthEnabled()) {
    next();
    return;
  }

  if (shouldBypassAdminAuth(req)) {
    next();
    return;
  }

  if (hasValidEmbeddedAccessToken(req)) {
    next();
    return;
  }

  const expectedUsername = String(env.ADMIN_AUTH_USERNAME || "");
  const expectedPassword = String(env.ADMIN_AUTH_PASSWORD || "");
  if (!expectedUsername || !expectedPassword) {
    console.error("[auth] admin auth enabled but credentials are not configured");
    res.status(503).send("Admin authentication is not configured.");
    return;
  }

  const provided = parseBasicAuth(req.get("authorization"));
  if (!provided) {
    unauthorized(res);
    return;
  }
  if (!areValidAdminCredentials(provided.username, provided.password)) {
    unauthorized(res);
    return;
  }

  next();
}

function adminAccessMiddleware(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (req.path.startsWith("/public/invoices/")) {
    next();
    return;
  }

  if (isShopifyHtmlLaunchRequest(req)) {
    const existingToken = readEmbeddedAccessTokenFromRequest(req);
    const hasValidToken = hasValidEmbeddedAccessToken(req);

    if (hasValidToken && existingToken) {
      issueEmbeddedAccessCookie(req, res, existingToken);
      if (!hasDirectEmbeddedAccessQuery(req)) {
        res.redirect(302, withEmbeddedAccessQuery(req, existingToken));
        return;
      }
      next();
      return;
    }

    if (isEmbeddedShopifyHtmlRequest(req)) {
      const tokenValue = createEmbeddedAccessValue(req);
      issueEmbeddedAccessCookie(req, res, tokenValue);
      res.redirect(302, withEmbeddedAccessQuery(req, tokenValue));
      return;
    }

    const provided = parseBasicAuth(req.get("authorization"));
    if (provided && areValidAdminCredentials(provided.username, provided.password)) {
      const tokenValue = createEmbeddedAccessValue(req);
      issueEmbeddedAccessCookie(req, res, tokenValue);
      res.redirect(302, withEmbeddedAccessQuery(req, tokenValue));
      return;
    }
  }

  enforceAdminBasicAuth(req, res, next);
}

function protectedApiAccessMiddleware(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const originalPath = req.originalUrl.split("?")[0] || req.originalUrl;
  const isProtectedPath = originalPath.startsWith("/api/whatsapp")
    || originalPath.startsWith("/api/ai")
    || originalPath.startsWith("/api/workflow")
    || originalPath.startsWith("/api/products/previews")
    || originalPath.startsWith("/api/leads/");

  if (!isProtectedPath) {
    next();
    return;
  }

  enforceAdminBasicAuth(req, res, next);
}

function renderAdminControlCenterPage(navSuffix: string): string {
  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Centre de Contrôle — Maison BFL</title>
  <style>
    :root{
      --bg:#f6f6f7;
      --panel:#ffffff;
      --panel-soft:#fafbfb;
      --text:#202223;
      --muted:#6d7175;
      --line:#e1e3e5;
      --line-strong:#c9cccf;
      --accent:#2c6ecb;
      --accent-soft:#eef4ff;
      --success:#008060;
      --secondary:#8c9196;
    }
    *{box-sizing:border-box}
    html{
      -webkit-text-size-adjust:100%;
      text-size-adjust:100%;
    }
    body{
      margin:0;
      font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","SF Pro Display","Segoe UI",Roboto,Inter,Arial,sans-serif;
      color:var(--text);
      background:var(--bg);
      min-height:100vh;
      min-height:100dvh;
      padding-left:max(0px, env(safe-area-inset-left));
      padding-right:max(0px, env(safe-area-inset-right));
      padding-bottom:max(0px, env(safe-area-inset-bottom));
    }
    .wrap{max-width:1180px;margin:0 auto;padding:24px 18px 40px}
    .hero{
      border:1px solid var(--line);
      border-radius:20px;
      background:var(--panel);
      padding:22px;
      box-shadow:0 1px 0 rgba(0,0,0,.02);
    }
    .hero-kicker{
      font-size:12px;
      letter-spacing:.08em;
      text-transform:uppercase;
      font-weight:700;
      color:var(--muted);
    }
    .hero h1{
      margin:8px 0 6px;
      font-size:32px;
      line-height:1.04;
      letter-spacing:-.03em;
    }
    .hero p{
      margin:0;
      max-width:760px;
      color:var(--muted);
      font-size:15px;
      line-height:1.5;
    }
    .hero-actions{
      margin-top:18px;
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:12px;
      flex-wrap:wrap;
    }
    .search{
      width:min(360px,100%);
      max-width:100%;
      border:1px solid var(--line-strong);
      border-radius:999px;
      background:#fff;
      color:var(--text);
      padding:12px 14px;
      font-size:14px;
      min-height:44px;
      outline:none;
      -webkit-appearance:none;
      appearance:none;
    }
    .search:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(44,110,203,.10)}
    .hero-meta{
      display:flex;
      gap:8px;
      flex-wrap:wrap;
    }
    .meta-chip{
      display:inline-flex;
      align-items:center;
      min-height:36px;
      padding:0 12px;
      border:1px solid var(--line);
      border-radius:999px;
      background:var(--panel-soft);
      color:#4a4f54;
      font-size:13px;
      font-weight:600;
    }
    .quick{
      margin-top:14px;
      border:1px solid var(--line);
      border-radius:20px;
      background:var(--panel);
      padding:18px;
      box-shadow:0 1px 0 rgba(0,0,0,.02);
    }
    .quick-head{
      display:flex;
      align-items:flex-start;
      justify-content:space-between;
      gap:12px;
      margin-bottom:12px;
    }
    .quick-head h2{
      margin:0;
      font-size:18px;
      letter-spacing:-.02em;
    }
    .quick-head p{
      margin:4px 0 0;
      font-size:13px;
      color:var(--muted);
    }
    .layout{
      margin-top:16px;
      display:grid;
      grid-template-columns:minmax(0,1.3fr) minmax(320px,.9fr);
      gap:16px;
    }
    .section{
      border:1px solid var(--line);
      border-radius:20px;
      background:var(--panel);
      padding:18px;
      box-shadow:0 1px 0 rgba(0,0,0,.02);
    }
    .section-title{
      margin:0 0 4px;
      font-size:20px;
      line-height:1.1;
      letter-spacing:-.02em;
    }
    .section-sub{
      margin:0 0 14px;
      font-size:14px;
      color:var(--muted);
      line-height:1.45;
    }
    .mobile-home{
      display:none;
    }
    .apps-track{
      display:flex;
      gap:8px;
      overflow-x:auto;
      -webkit-overflow-scrolling:touch;
      scrollbar-width:none;
    }
    .apps-track::-webkit-scrollbar{display:none}
    .app-chip{
      flex:0 0 auto;
      display:flex;
      align-items:center;
      gap:10px;
      min-height:52px;
      border:1px solid var(--line);
      border-radius:14px;
      background:var(--panel-soft);
      color:var(--text);
      text-decoration:none;
      font-size:12px;
      font-weight:600;
      padding:8px 10px;
    }
    .app-chip:hover{
      border-color:var(--line-strong);
      background:#fff;
    }
    .app-icon{
      width:34px;
      height:34px;
      border-radius:10px;
      border:1px solid var(--line);
      background:var(--accent-soft);
      display:grid;
      place-items:center;
      color:var(--accent);
      font-size:15px;
    }
    .app-chip-label{
      display:block;
      line-height:1.2;
      letter-spacing:.01em;
      color:var(--text);
      max-width:100%;
      white-space:nowrap;
    }
    .rows{
      display:grid;
      gap:12px;
    }
    .primary-grid{
      grid-template-columns:repeat(2,minmax(0,1fr));
    }
    .module-card{
      display:flex;
      align-items:flex-start;
      gap:14px;
      border:1px solid var(--line);
      border-radius:16px;
      background:#fff;
      padding:14px;
      text-decoration:none;
      color:inherit;
      transition:border-color .2s ease, background .2s ease, transform .2s ease;
      min-height:92px;
    }
    .module-card:hover{
      border-color:var(--line-strong);
      background:#fcfcfd;
      transform:translateY(-1px);
    }
    .icon{
      width:40px;
      height:40px;
      border-radius:12px;
      border:1px solid var(--line);
      background:var(--accent-soft);
      display:grid;
      place-items:center;
      color:var(--accent);
      font-size:15px;
      flex:0 0 40px;
    }
    .content{
      min-width:0;
      flex:1 1 auto;
    }
    .title{
      margin:0;
      font-size:16px;
      line-height:1.2;
      letter-spacing:-.01em;
      font-weight:700;
    }
    .subtitle{
      margin:4px 0 0;
      font-size:13px;
      color:var(--muted);
      white-space:normal;
      display:-webkit-box;
      -webkit-line-clamp:2;
      -webkit-box-orient:vertical;
      overflow:hidden;
    }
    .status{
      font-size:10px;
      letter-spacing:.12em;
      text-transform:uppercase;
      border-radius:999px;
      padding:6px 10px;
      border:1px solid;
      flex:0 0 auto;
      margin-left:6px;
      min-height:26px;
      display:inline-flex;
      align-items:center;
      white-space:nowrap;
    }
    .active{color:var(--success);background:rgba(0,128,96,.08);border-color:rgba(0,128,96,.2)}
    .progress{color:#5c5f62;background:#f6f6f7;border-color:#d9dadd}
    .arrow{
      color:#8c9196;
      font-size:20px;
      line-height:1;
      flex:0 0 auto;
    }
    @media (max-width:980px){
      .layout{
        grid-template-columns:1fr;
      }
      .primary-grid{
        grid-template-columns:1fr;
      }
    }
    @media (max-width:760px){
      .wrap{
        padding:16px 14px 28px;
      }
      .hero{
        padding:18px;
      }
      .hero h1{
        font-size:28px;
      }
      .hero-actions{
        align-items:stretch;
      }
      .search{
        width:100%;
      }
      .section,
      .quick{
        padding:16px;
        border-radius:18px;
      }
      .module-card{
        min-height:84px;
      }
      .app-chip{
        min-width:190px;
      }
    }
  </style>
</head>
<body>
  <main class="wrap">
    <header class="hero">
      <div class="hero-kicker">Page principale</div>
      <h1>Navigation système</h1>
      <p>Page d’entrée simple pour ouvrir rapidement le bon module, avec la même sobriété que le reste de l’application.</p>
      <div class="hero-actions">
        <input id="moduleSearch" class="search" type="search" placeholder="Rechercher un module..." />
        <div class="hero-meta">
          <span class="meta-chip">5 modules principaux</span>
          <span class="meta-chip">Outils séparés</span>
          <span class="meta-chip">Navigation simplifiée</span>
        </div>
      </div>
    </header>

    <section class="quick">
      <div class="quick-head">
        <div>
          <h2>Accès rapides</h2>
          <p>Les derniers modules ouverts restent disponibles ici.</p>
        </div>
      </div>
      <div class="apps-track" id="recentAppsTrack"></div>
    </section>

    <div class="layout">
      <section class="section filter-section" data-filter-section="modules">
        <h2 class="section-title">Modules principaux</h2>
        <p class="section-sub">Les modules du quotidien, pensés pour une lecture rapide et une ouverture immédiate.</p>
        <div class="rows primary-grid">
          <a class="module-card module-item" data-app-id="orders" data-search="commandes paiements acomptes soldes documents ordre commerce" href="/admin/orders${navSuffix}">
            <div class="icon">◐</div>
            <div class="content">
              <p class="title">Commandes</p>
              <p class="subtitle">Vue principale des commandes, paiements, documents et suivi opérationnel</p>
            </div>
            <span class="status active">Actif</span>
            <span class="arrow">›</span>
          </a>
          <a class="module-card module-item" data-app-id="appointments" data-search="rendez-vous showroom planning disponibilites rappels" href="/admin/appointments${navSuffix}">
            <div class="icon">◒</div>
            <div class="content">
              <p class="title">Rendez-vous</p>
              <p class="subtitle">Organisation showroom, disponibilités, confirmations et coordination client</p>
            </div>
            <span class="status active">Actif</span>
            <span class="arrow">›</span>
          </a>
          <a class="module-card module-item" data-app-id="forecast" data-search="forecast previsions revenue demande scenarios planification" href="/admin/forecast${navSuffix}">
            <div class="icon">◍</div>
            <div class="content">
              <p class="title">Forecast</p>
              <p class="subtitle">Pilotage des projections de revenu, du rythme commercial et des scénarios</p>
            </div>
            <span class="status active">Actif</span>
            <span class="arrow">›</span>
          </a>
          <a class="module-card module-item" data-app-id="client-flows" data-search="flows clients whatsapp j+3 j+15 saison messages sequences relances" href="/admin/client-flows${navSuffix}">
            <div class="icon">◐</div>
            <div class="content">
              <p class="title">Flows clients</p>
              <p class="subtitle">Préparation des séquences WhatsApp client J+3, J+15 et saisonnières</p>
            </div>
            <span class="status active">Actif</span>
            <span class="arrow">›</span>
          </a>
          <a class="module-card module-item" data-app-id="whatsapp" data-search="whatsapp conversations priorites intelligence flux conversion" href="/admin/whatsapp-intelligence${navSuffix}">
            <div class="icon">◈</div>
            <div class="content">
              <p class="title">WhatsApp</p>
              <p class="subtitle">Espace conversationnel, priorisation, supervision et flux d’exécution WhatsApp</p>
            </div>
            <span class="status active">Actif</span>
            <span class="arrow">›</span>
          </a>
        </div>
      </section>

      <section id="outils" class="section filter-section" data-filter-section="tools">
        <h2 class="section-title">Outils</h2>
        <p class="section-sub">Les espaces secondaires, techniques ou exploratoires, gardés hors du parcours quotidien.</p>
        <div class="rows">
          <a class="module-card module-item" data-app-id="agent" data-search="agent control centre operations runs leads approvals system brain ia" href="/agent-control-center-v1/${navSuffix}#/index">
            <div class="icon">◎</div>
            <div class="content">
              <p class="title">Agent Control</p>
              <p class="subtitle">Cockpit IA pour la supervision, les runs et les validations système</p>
            </div>
            <span class="status active">Actif</span>
            <span class="arrow">›</span>
          </a>
          <a class="module-card module-item" data-app-id="blueprint" data-search="blueprint architecture systeme cartographie flux modules services" href="/blueprint${navSuffix}">
            <div class="icon">◇</div>
            <div class="content">
              <p class="title">Blueprint</p>
              <p class="subtitle">Vue architecture système et cartographie des flux applicatifs</p>
            </div>
            <span class="status active">Actif</span>
            <span class="arrow">›</span>
          </a>
          <a class="module-card module-item" data-app-id="ml" data-search="ml dashboard intelligence artificielle automation machine learning" href="/admin/ml${navSuffix}">
            <div class="icon">◌</div>
            <div class="content">
              <p class="title">ML Dashboard</p>
              <p class="subtitle">Analyse de l’automatisation, monitoring IA et métriques internes</p>
            </div>
            <span class="status progress">Secondaire</span>
            <span class="arrow">›</span>
          </a>
          <a class="module-card module-item" data-app-id="spline" data-search="spline 3d viewer scene visualisation" href="/admin/spline${navSuffix}">
            <div class="icon">⬡</div>
            <div class="content">
              <p class="title">Spline</p>
              <p class="subtitle">Visualisation 3D et intégrations de scène pour les expériences avancées</p>
            </div>
            <span class="status progress">Secondaire</span>
            <span class="arrow">›</span>
          </a>
          <a class="module-card module-item" data-app-id="mobile" data-search="mobile app conversations approvals execution operator actions" href="/whatsapp-intelligence/mobile-lab${navSuffix}">
            <div class="icon">◉</div>
            <div class="content">
              <p class="title">App mobile</p>
              <p class="subtitle">Vue opérateur mobile pour exécution rapide, validations et actions terrain</p>
            </div>
            <span class="status progress">Secondaire</span>
            <span class="arrow">›</span>
          </a>
          <a class="module-card module-item" data-app-id="whatsapp-lab" data-search="whatsapp lab experimentation tests outils" href="/whatsapp-lab${navSuffix}">
            <div class="icon">◫</div>
            <div class="content">
              <p class="title">Laboratoire WhatsApp</p>
              <p class="subtitle">Zone d’expérimentation et de tests pour les interfaces et composants WhatsApp</p>
            </div>
            <span class="status progress">Secondaire</span>
            <span class="arrow">›</span>
          </a>
          <a class="module-card module-item" data-app-id="logic" data-search="logic diagram schema logique whatsapp systeme" href="/whatsapp-logic-diagram${navSuffix}">
            <div class="icon">⌘</div>
            <div class="content">
              <p class="title">Schéma logique</p>
              <p class="subtitle">Schéma logique et lecture des enchaînements internes de l’écosystème WhatsApp</p>
            </div>
            <span class="status progress">Secondaire</span>
            <span class="arrow">›</span>
          </a>
          <a class="module-card module-item" data-app-id="workflow" data-search="manager approval flow validation manager whatsapp" href="/whatsapp-intelligence/workflow${navSuffix}">
            <div class="icon">⇄</div>
            <div class="content">
              <p class="title">Flux manager</p>
              <p class="subtitle">Workflow de validation managériale pour les devis et décisions sensibles</p>
            </div>
            <span class="status progress">Secondaire</span>
            <span class="arrow">›</span>
          </a>
        </div>
      </section>
    </div>
  </main>
  <script>
    const input = document.getElementById("moduleSearch");
    const recentAppsTrack = document.getElementById("recentAppsTrack");
    const filterSections = Array.from(document.querySelectorAll("[data-filter-section]"));
    const appCatalog = {
      agent: { label: "Agent Control", icon: "◎", href: "/agent-control-center-v1/${navSuffix}#/index" },
      mobile: { label: "App mobile", icon: "◉", href: "/whatsapp-intelligence/mobile-lab${navSuffix}" },
      forecast: { label: "Forecast", icon: "◍", href: "/admin/forecast${navSuffix}" },
      "client-flows": { label: "Flows clients", icon: "◐", href: "/admin/client-flows${navSuffix}" },
      whatsapp: { label: "WhatsApp", icon: "◈", href: "/admin/whatsapp-intelligence${navSuffix}" },
      blueprint: { label: "Blueprint", icon: "◇", href: "/blueprint${navSuffix}" },
      ml: { label: "ML Dashboard", icon: "◌", href: "/admin/ml${navSuffix}" },
      spline: { label: "Spline", icon: "⬡", href: "/admin/spline${navSuffix}" },
      orders: { label: "Commandes", icon: "◐", href: "/admin/orders${navSuffix}" },
      appointments: { label: "Rendez-vous", icon: "◒", href: "/admin/appointments${navSuffix}" },
      "whatsapp-lab": { label: "Laboratoire WhatsApp", icon: "◫", href: "/whatsapp-lab${navSuffix}" },
      logic: { label: "Schéma logique", icon: "⌘", href: "/whatsapp-logic-diagram${navSuffix}" },
      workflow: { label: "Flux manager", icon: "⇄", href: "/whatsapp-intelligence/workflow${navSuffix}" }
    };
    const defaultRecentApps = ["orders", "client-flows", "whatsapp", "appointments"];

    function readRecentApps() {
      try {
        const parsed = JSON.parse(localStorage.getItem("ml_recent_apps") || "[]");
        if (!Array.isArray(parsed)) return defaultRecentApps.slice();
        const sanitized = parsed.filter((id) => typeof id === "string" && appCatalog[id]).slice(0, 4);
        return sanitized.length ? sanitized : defaultRecentApps.slice();
      } catch {
        return defaultRecentApps.slice();
      }
    }

    function writeRecentApps(ids) {
      try {
        localStorage.setItem("ml_recent_apps", JSON.stringify(ids.slice(0, 4)));
      } catch {}
    }

    function renderRecentApps() {
      if (!recentAppsTrack) return;
      const ids = readRecentApps();
      recentAppsTrack.innerHTML = ids
        .map((id) => {
          const app = appCatalog[id];
          if (!app) return "";
          return "<a class='app-chip module-item' data-app-id='" + id + "' data-search='" + app.label.toLowerCase() + "' href='" + app.href + "'><span class='app-icon'>" + app.icon + "</span><span class='app-chip-label'>" + app.label + "</span></a>";
        })
        .join("");
    }

    document.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target.closest("[data-app-id]") : null;
      if (!target) return;
      const appId = String(target.getAttribute("data-app-id") || "");
      if (!appCatalog[appId]) return;
      const current = readRecentApps().filter((id) => id !== appId);
      const next = [appId].concat(current).slice(0, 4);
      writeRecentApps(next);
      renderRecentApps();
    });
    function applyVisibility() {
      filterSections.forEach((section) => {
        const allRows = Array.from(section.querySelectorAll(".module-item"));
        const hasVisibleRows = allRows.some((row) => row.style.display !== "none");
        section.style.display = hasVisibleRows ? "" : "none";
      });
    }

    if (input) {
      input.addEventListener("input", (event) => {
        const q = String(event.target.value || "").toLowerCase().trim();
        const liveItems = Array.from(document.querySelectorAll(".module-item"));
        liveItems.forEach((row) => {
          const hay = String(row.getAttribute("data-search") || "").toLowerCase();
          row.style.display = q && !hay.includes(q) ? "none" : "";
        });
        applyVisibility();
      });
    }
    renderRecentApps();
    applyVisibility();
  </script>
</body>
</html>`;
}

app.get("/", (req, res) => {
  const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  if (isShopifyLaunch(req)) {
    res.redirect(`/admin/control-center${query}`);
    return;
  }
  res.redirect(`/admin/control-center${query}`);
});

app.get("/admin", (req, res) => {
  const navSuffix = buildAdminNavSuffix(req);
  res.redirect(`/admin/control-center${navSuffix}`);
});

app.get("/admin/control-center", (req, res) => {
  const navSuffix = buildAdminNavSuffix(req);
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.type("html").send(renderAdminControlCenterPage(navSuffix));
});

const appShellRouteMap: Array<{ path: string; target: string }> = [
  { path: "/control-center", target: "/admin/control-center" },
  { path: "/agent-control-center", target: "/agent-control-center-v1/#/index" },
  { path: "/mobile-app", target: "/whatsapp-intelligence/mobile-lab" },
  { path: "/insights", target: "/admin/insights" },
  { path: "/forecast", target: "/admin/forecast" },
  { path: "/whatsapp-intelligence-app", target: "/admin/whatsapp-intelligence" },
  { path: "/blueprint-app", target: "/blueprint" },
  { path: "/create-invoice", target: "/admin/invoices" },
  { path: "/orders-payments", target: "/admin/orders" },
  { path: "/appointments", target: "/admin/appointments" }
];

for (const route of appShellRouteMap) {
  app.get(route.path, (req, res) => {
    const suffix = buildAdminNavSuffix(req);
    if (route.target.includes("#")) {
      const [path, hash = ""] = route.target.split("#");
      res.redirect(`${path}${suffix}${hash ? `#${hash}` : ""}`);
      return;
    }
    res.redirect(`${route.target}${suffix}`);
  });
}

app.get(["/spline", "/admin/spline"], (_req, res) => {
  const sceneUrl = String(env.SPLINE_SCENE_URL || "").trim();
  if (!sceneUrl) {
    res.status(400).type("text/plain").send("Missing SPLINE_SCENE_URL in environment.");
    return;
  }

  try {
    const parsed = new URL(sceneUrl);
    if (!/^https?:$/.test(parsed.protocol)) {
      throw new Error("Invalid protocol");
    }
  } catch {
    res.status(400).type("text/plain").send("SPLINE_SCENE_URL is invalid.");
    return;
  }

  const safeSceneUrl = JSON.stringify(sceneUrl);
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Spline — 3D Viewer</title>
    <link rel="preconnect" href="https://esm.sh" />
    <link rel="dns-prefetch" href="https://prod.spline.design" />
    <style>
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      html, body {
        width: 100%; height: 100%; overflow: hidden;
        background: #0c1018;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      /* ── Canvas ── */
      #canvas3d {
        width: 100%; height: 100%; display: block;
        opacity: 0; transition: opacity 1s ease;
      }
      #canvas3d.loaded { opacity: 1; }

      /* ── Loading Overlay ── */
      #loader {
        position: fixed; inset: 0; z-index: 100;
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        background: #0c1018; gap: 16px;
        transition: opacity 0.8s ease, visibility 0.8s ease;
      }
      #loader.hidden { opacity: 0; visibility: hidden; pointer-events: none; }
      .loader-spinner {
        width: 44px; height: 44px; border-radius: 50%;
        border: 3px solid rgba(255,255,255,0.08);
        border-top-color: #a29bfe;
        animation: spin 0.9s linear infinite;
      }
      .loader-label {
        font-size: 12px; color: rgba(255,255,255,0.35);
        letter-spacing: 0.15em; text-transform: uppercase;
        animation: pulse 2s ease-in-out infinite;
      }
      @keyframes spin { to { transform: rotate(360deg); } }
      @keyframes pulse { 0%,100% { opacity: 0.35; } 50% { opacity: 1; } }

      /* ── Top Bar ── */
      #topbar {
        position: fixed; top: 0; left: 0; right: 0; z-index: 50;
        display: flex; align-items: center; justify-content: space-between;
        padding: 14px 20px;
        background: linear-gradient(to bottom, rgba(12,16,24,0.75) 0%, transparent 100%);
        opacity: 0; transition: opacity 0.6s ease;
        pointer-events: none;
      }
      #topbar.visible { opacity: 1; }
      .topbar-back {
        display: flex; align-items: center; gap: 8px;
        padding: 8px 14px; border-radius: 8px;
        font-size: 13px; font-weight: 500; color: rgba(255,255,255,0.75);
        background: rgba(255,255,255,0.08);
        border: 1px solid rgba(255,255,255,0.12);
        text-decoration: none; pointer-events: auto;
        backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
        transition: background 0.2s, color 0.2s;
      }
      .topbar-back:hover { background: rgba(255,255,255,0.15); color: #fff; }
      .topbar-badge {
        display: flex; align-items: center; gap: 8px;
        padding: 6px 14px; border-radius: 8px;
        font-size: 12px; color: rgba(255,255,255,0.45);
        background: rgba(255,255,255,0.05);
        border: 1px solid rgba(255,255,255,0.08);
        backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
      }
      .topbar-dot {
        width: 6px; height: 6px; border-radius: 50%;
        background: #00cec9;
        animation: pulsedot 2s ease-in-out infinite;
      }
      @keyframes pulsedot { 0%,100% { opacity:1; transform:scale(1); } 50% { opacity:0.4; transform:scale(0.7); } }

      /* ── Error State ── */
      #error-state {
        display: none; position: fixed; inset: 0; z-index: 200;
        flex-direction: column; align-items: center; justify-content: center; gap: 14px;
        background: #0c1018; text-align: center; padding: 32px;
      }
      #error-state.visible { display: flex; }
      .error-icon {
        width: 64px; height: 64px; border-radius: 50%;
        background: rgba(239,68,68,0.1);
        display: flex; align-items: center; justify-content: center;
        font-size: 28px;
      }
      .error-title { font-size: 18px; font-weight: 600; color: #ef4444; }
      .error-msg {
        font-size: 14px; color: rgba(255,255,255,0.4);
        max-width: 380px; line-height: 1.6;
      }
      .error-actions { display: flex; gap: 10px; margin-top: 6px; flex-wrap: wrap; justify-content: center; }
      .error-btn {
        padding: 9px 22px; border-radius: 8px;
        font-size: 13px; font-weight: 600;
        background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.13);
        color: rgba(255,255,255,0.75); text-decoration: none;
        transition: background 0.2s, color 0.2s;
      }
      .error-btn:hover { background: rgba(255,255,255,0.14); color: #fff; }
    </style>
  </head>
  <body>

    <!-- Loading Overlay -->
    <div id="loader">
      <div class="loader-spinner"></div>
      <p class="loader-label">Loading Scene</p>
    </div>

    <!-- Error State -->
    <div id="error-state">
      <div class="error-icon">⚠</div>
      <p class="error-title">Scene failed to load</p>
      <p class="error-msg" id="error-msg">The Spline scene could not be loaded. Check SPLINE_SCENE_URL and your network connection.</p>
      <div class="error-actions">
        <a href="/admin/spline" class="error-btn">Retry</a>
        <a href="/admin/control-center" class="error-btn">← Centre de contrôle</a>
      </div>
    </div>

    <!-- Top Bar (revealed after load) -->
    <div id="topbar">
      <a href="/admin/control-center" class="topbar-back">← Centre de contrôle</a>
      <div class="topbar-badge">
        <span class="topbar-dot"></span>
        3D Scene Active
      </div>
    </div>

    <!-- Canvas -->
    <canvas id="canvas3d"></canvas>

    <script type="module">
      import { Application } from "https://esm.sh/@splinetool/runtime";

      const canvas  = document.getElementById("canvas3d");
      const loader  = document.getElementById("loader");
      const topbar  = document.getElementById("topbar");
      const errEl   = document.getElementById("error-state");
      const errMsg  = document.getElementById("error-msg");

      try {
        const spline = new Application(canvas);
        await spline.load(${safeSceneUrl});

        canvas.classList.add("loaded");
        loader?.classList.add("hidden");
        topbar?.classList.add("visible");

        spline.addEventListener("mouseDown", (e) => {
          if (e.target?.name) console.log("Clicked 3D object:", e.target.name);
        });

      } catch (err) {
        console.error("Spline load failed", err);
        loader?.classList.add("hidden");
        if (errMsg && err instanceof Error) errMsg.textContent = err.message;
        errEl?.classList.add("visible");
      }
    </script>
  </body>
</html>`;

  res.status(200).type("html").send(html);
});

app.use("/admin/orders", adminAccessMiddleware, adminRouter);
app.use("/admin", adminAccessMiddleware, adminRouter);
app.use(protectedApiAccessMiddleware, whatsappRouter);
app.use(whatsappLabRouter);
app.use("/health", healthRouter);
app.use("/webhooks", webhooksRouter);
app.use(zokoWebhookRouter);
app.use(shopifyFilesUploadRouter);
app.use(blueprintV2Router);
app.use(mlAutomationRouter);
app.use(agentControlCenterV1Router);
app.use(shoppingBrainRouter);

async function loadRecentOrdersFromDBIntoMemory(): Promise<void> {
  if (!isDbEnabled()) return;
  const toExclusive = new Date();
  const from = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  try {
    const payloads = await listPersistedOrderPayloads(from.toISOString(), toExclusive.toISOString(), 5000);
    addManyOrderSnapshots(payloads, { pruneMissing: true });
    console.log(
      `Memory hydration from Postgres: loaded ${payloads.length} order(s) for the last 60 days.`
    );
  } catch (error) {
    console.error("Failed to hydrate in-memory orders from Postgres", error);
  }
}

async function bootstrap(): Promise<void> {
  // Start listening immediately so Railway's health check passes without waiting for DB.
  // DB init runs in the background — routes that need the DB handle their own unavailability.
  app.listen(env.PORT, () => {
    console.log(`Shopify app listening on port ${env.PORT}`);
    startAppointmentsReminderWorker();
    startZokoHistorySyncWorker();
    startAuto24hFollowupWorker();
    startOperatorLearningLoopWorker();
    void registerOrdersDeleteWebhook().catch((error) => {
      console.error("[webhooks] orders/delete registration failed", error);
    });
  });

  if (isDbEnabled()) {
    try {
      await connectDbWithRetry(10);
      await initDb();
      console.log("Postgres initialized");
      await loadRecentOrdersFromDBIntoMemory();
    } catch (error) {
      console.error("DB initialization failed — app running without database", error);
    }
  }
}

bootstrap().catch((error) => {
  console.error("Failed to start app", error);
  process.exit(1);
});
