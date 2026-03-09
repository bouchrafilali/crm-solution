import express from "express";
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
import { addManyOrderSnapshots } from "./services/orderSnapshots.js";
import { startZokoHistorySyncWorker } from "./services/zokoHistorySyncWorker.js";
import { startAuto24hFollowupWorker } from "./services/autoFollowUpRule.js";
import "./shopify/client.js";

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  const shopParam = typeof req.query.shop === "string" ? req.query.shop : "";
  const isValidShop = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shopParam);
  const frameAncestors = ["https://admin.shopify.com", isValidShop ? `https://${shopParam}` : "https://*.myshopify.com"];

  res.setHeader("Content-Security-Policy", `frame-ancestors ${frameAncestors.join(" ")};`);
  next();
});

function isShopifyLaunch(req: express.Request): boolean {
  const hasHost = typeof req.query.host === "string" && req.query.host.trim().length > 0;
  const hasShop = typeof req.query.shop === "string" && req.query.shop.trim().length > 0;
  const embedded = typeof req.query.embedded === "string" ? req.query.embedded.trim().toLowerCase() : "";
  return hasHost || hasShop || embedded === "1" || embedded === "true";
}

app.get("/", (req, res) => {
  const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  if (isShopifyLaunch(req)) {
    res.redirect(`/whatsapp-intelligence/mobile-lab${query}`);
    return;
  }
  res.redirect(`/admin${query}`);
});

app.get("/admin", (req, res, next) => {
  if (!isShopifyLaunch(req)) {
    next();
    return;
  }
  const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  res.redirect(`/whatsapp-intelligence/mobile-lab${query}`);
});

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
        <a href="/admin" class="error-btn">← Back to Admin</a>
      </div>
    </div>

    <!-- Top Bar (revealed after load) -->
    <div id="topbar">
      <a href="/admin" class="topbar-back">← Admin</a>
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

app.use("/admin", adminRouter);
app.use(whatsappRouter);
app.use(whatsappLabRouter);
app.use("/health", healthRouter);
app.use("/webhooks", webhooksRouter);
app.use(zokoWebhookRouter);
app.use(blueprintV2Router);
app.use(mlAutomationRouter);
app.use(agentControlCenterV1Router);

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
  if (isDbEnabled()) {
    await connectDbWithRetry(10);
    await initDb();
    console.log("Postgres initialized");
    await loadRecentOrdersFromDBIntoMemory();
  }

  app.listen(env.PORT, () => {
    console.log(`Shopify app listening on port ${env.PORT}`);
    startAppointmentsReminderWorker();
    startZokoHistorySyncWorker();
    startAuto24hFollowupWorker();
    void registerOrdersDeleteWebhook().catch((error) => {
      console.error("[webhooks] orders/delete registration failed", error);
    });
  });
}

bootstrap().catch((error) => {
  console.error("Failed to start app", error);
  process.exit(1);
});
