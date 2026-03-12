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
import { startOperatorLearningLoopWorker } from "./services/operatorLearningLoopService.js";
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

function buildAdminNavSuffix(req: express.Request): string {
  const host = typeof req.query.host === "string" ? req.query.host : "";
  const shop = typeof req.query.shop === "string" ? req.query.shop : "";
  const embedded = typeof req.query.embedded === "string" ? req.query.embedded : "";
  const params = new URLSearchParams();
  if (host) params.set("host", host);
  if (shop) params.set("shop", shop);
  if (embedded) params.set("embedded", embedded);
  const query = params.toString();
  return query ? `?${query}` : "";
}

function renderAdminControlCenterPage(navSuffix: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Control Center — Mobile-Lab</title>
  <style>
    :root{
      --bg:#070b13;
      --bg-soft:#0c1220;
      --panel:rgba(19,26,40,.72);
      --panel-strong:rgba(24,33,50,.82);
      --text:#e8edf7;
      --muted:#95a3bd;
      --line:rgba(255,255,255,.12);
      --cyan:#7dd3fc;
      --green:#86efac;
      --amber:#fcd34d;
    }
    *{box-sizing:border-box}
    body{
      margin:0;
      font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","SF Pro Display","Segoe UI",Roboto,Inter,Arial,sans-serif;
      color:var(--text);
      background:
        radial-gradient(1000px 420px at 8% -5%, rgba(125,211,252,.13), transparent 55%),
        radial-gradient(860px 360px at 98% 0%, rgba(52,211,153,.10), transparent 48%),
        linear-gradient(180deg, #060a12 0%, #070b13 48%, #070c14 100%);
      min-height:100vh;
    }
    .wrap{max-width:1320px;margin:0 auto;padding:28px 18px 34px}
    .hero{
      border:1px solid var(--line);
      border-radius:28px;
      background:linear-gradient(180deg,var(--panel) 0%, rgba(14,21,34,.72) 100%);
      backdrop-filter:blur(16px);
      padding:24px;
      display:grid;
      gap:14px;
      grid-template-columns:1.4fr .78fr;
    }
    .eyebrow{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--cyan);font-weight:700}
    h1{margin:8px 0 0;font-size:40px;line-height:1.08;letter-spacing:-.03em}
    .subtitle{margin:12px 0 0;color:var(--muted);font-size:16px}
    .summary{
      border:1px solid var(--line);
      border-radius:24px;
      background:rgba(14,20,32,.62);
      padding:14px;
    }
    .summary h3{margin:0 0 10px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
    .stat{display:flex;justify-content:space-between;align-items:center;border:1px solid rgba(255,255,255,.09);background:rgba(255,255,255,.03);padding:10px 12px;border-radius:14px;margin-top:8px;font-size:14px}
    .orientation{margin-top:16px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
    .tile{
      border:1px solid var(--line);
      border-radius:22px;
      background:rgba(19,26,40,.58);
      backdrop-filter:blur(14px);
      padding:14px;
    }
    .tile .k{font-size:11px;letter-spacing:.13em;text-transform:uppercase;color:var(--muted);font-weight:700}
    .tile .v{margin-top:8px;font-size:28px;letter-spacing:-.02em;font-weight:650}
    .tile .d{margin-top:8px;color:var(--muted);font-size:14px;line-height:1.45}
    .modules-head{margin:20px 0 10px;display:flex;justify-content:space-between;align-items:end;gap:10px}
    .modules-head h2{margin:0;font-size:22px;letter-spacing:-.02em}
    .modules-head p{margin:6px 0 0;color:var(--muted);font-size:14px}
    .grid{display:grid;gap:14px;grid-template-columns:repeat(3,minmax(0,1fr))}
    .card{
      border:1px solid var(--line);
      border-radius:24px;
      background:linear-gradient(180deg,var(--panel-strong) 0%, rgba(17,24,37,.78) 100%);
      backdrop-filter:blur(18px);
      padding:16px;
      display:flex;
      flex-direction:column;
      min-height:320px;
      transition:transform .2s ease, border-color .2s ease, box-shadow .2s ease;
    }
    .card:hover{transform:translateY(-2px);border-color:rgba(255,255,255,.22);box-shadow:0 18px 46px -30px rgba(0,0,0,.85)}
    .top{display:flex;justify-content:space-between;gap:10px}
    .title{font-size:31px;letter-spacing:-.03em;font-weight:700}
    .sub{margin-top:4px;color:var(--muted);font-size:12px}
    .desc{margin-top:12px;font-size:14px;line-height:1.52;color:#d0d7e7}
    .features{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:12px}
    .chip{border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.03);border-radius:12px;padding:8px 10px;font-size:12px;color:#d6deef}
    .status{font-size:10px;letter-spacing:.12em;text-transform:uppercase;border-radius:999px;padding:7px 10px;border:1px solid}
    .active{color:#d9ffe9;background:rgba(34,197,94,.13);border-color:rgba(74,222,128,.35)}
    .progress{color:#ffefcf;background:rgba(245,158,11,.14);border-color:rgba(245,158,11,.35)}
    .cta{
      margin-top:auto;
      display:inline-flex;
      justify-content:center;
      align-items:center;
      text-decoration:none;
      border:1px solid rgba(255,255,255,.18);
      background:rgba(255,255,255,.05);
      color:var(--text);
      border-radius:12px;
      padding:10px 12px;
      font-size:13px;
      font-weight:650;
    }
    .cta:hover{border-color:rgba(125,211,252,.5);color:#d6f4ff;background:rgba(125,211,252,.11)}
    @media (max-width:1150px){
      .hero{grid-template-columns:1fr}
      .grid{grid-template-columns:repeat(2,minmax(0,1fr))}
      .title{font-size:29px}
    }
    @media (max-width:760px){
      .orientation{grid-template-columns:1fr}
      .grid{grid-template-columns:1fr}
      h1{font-size:31px}
      .title{font-size:27px}
    }
  </style>
</head>
<body>
  <main class="wrap">
    <section class="hero">
      <div>
        <p class="eyebrow">Project Control Center</p>
        <h1>Central index for all project areas</h1>
        <p class="subtitle">A simple, structured entry point to the platform.</p>
      </div>
      <aside class="summary">
        <h3>System Summary</h3>
        <div class="stat"><span>Modules</span><strong>7</strong></div>
        <div class="stat"><span>Structure</span><strong style="color:var(--green)">Structured</strong></div>
        <div class="stat"><span>Navigation</span><strong>Clear</strong></div>
      </aside>
    </section>

    <section class="orientation">
      <article class="tile"><div class="k">Recommended Start</div><div class="v">Insights</div><div class="d">Best place to understand the business situation and what needs attention first.</div></article>
      <article class="tile"><div class="k">Decision Area</div><div class="v">Forecast</div><div class="d">Use for projections, planning, expected revenue, and scenario thinking.</div></article>
      <article class="tile"><div class="k">Execution Area</div><div class="v">Mobile App</div><div class="d">Use for action, operator activity, approvals, and daily execution.</div></article>
    </section>

    <header class="modules-head">
      <div>
        <h2>Modules</h2>
        <p>Separated control center with Agent Control Center V1 as an explicit module.</p>
      </div>
    </header>

    <section class="grid">
      <article class="card"><div class="top"><div><div class="title">Agent Control Center V1</div><div class="sub">AI operations cockpit</div></div><span class="status active">Active</span></div><p class="desc">Dedicated operational center for leads, runs, approvals, learning and system brain.</p><div class="features"><div class="chip">Index</div><div class="chip">Runs</div><div class="chip">Approvals</div><div class="chip">System Brain</div></div><a class="cta" href="/agent-control-center-v1/#/index${navSuffix}">Open Agent Control Center V1</a></article>
      <article class="card"><div class="top"><div><div class="title">Forecast</div><div class="sub">Revenue, demand, and operational projections</div></div><span class="status active">Active</span></div><p class="desc">Access forecasting models, scenario views, and forward-looking signals to guide business decisions with clarity.</p><div class="features"><div class="chip">Revenue Forecast</div><div class="chip">Order Projection</div><div class="chip">Demand Signals</div><div class="chip">Scenario View</div></div><a class="cta" href="/admin/forecast-v4${navSuffix}">Open Forecast</a></article>
      <article class="card"><div class="top"><div><div class="title">Insights</div><div class="sub">Business intelligence and actionable analysis</div></div><span class="status active">Active</span></div><p class="desc">Surface the most important patterns across performance, client behavior, and operational efficiency.</p><div class="features"><div class="chip">Executive Overview</div><div class="chip">Conversion Insights</div><div class="chip">Lead Intelligence</div><div class="chip">Performance Signals</div></div><a class="cta" href="/admin/insights${navSuffix}">Open Insights</a></article>
      <article class="card"><div class="top"><div><div class="title">Mobile App</div><div class="sub">Operational experience for fast daily execution</div></div><span class="status progress">In Progress</span></div><p class="desc">A clear mobile-first workspace for conversations, approvals, and rapid action across ongoing activity.</p><div class="features"><div class="chip">Conversations</div><div class="chip">Approvals</div><div class="chip">Operator Actions</div><div class="chip">AI Suggestions</div></div><a class="cta" href="/whatsapp-intelligence/mobile-lab${navSuffix}">Open Mobile App</a></article>
      <article class="card"><div class="top"><div><div class="title">WhatsApp Intelligence</div><div class="sub">Conversation analysis and operator guidance</div></div><span class="status active">Active</span></div><p class="desc">Review conversations, priorities, and reply suggestions in a structure designed for speed and control.</p><div class="features"><div class="chip">Priority Feed</div><div class="chip">Suggested Replies</div><div class="chip">Stage Detection</div><div class="chip">Learning Loop</div></div><a class="cta" href="/whatsapp-intelligence${navSuffix}">Open WhatsApp Intelligence</a></article>
      <article class="card"><div class="top"><div><div class="title">Orders & Payments</div><div class="sub">Commercial flow and payment visibility</div></div><span class="status active">Active</span></div><p class="desc">Track orders, deposits, balances, and payment progression with a more executive operational view.</p><div class="features"><div class="chip">Orders</div><div class="chip">Deposits</div><div class="chip">Balances</div><div class="chip">Payment Status</div></div><a class="cta" href="/admin/invoices${navSuffix}">Open Orders & Payments</a></article>
      <article class="card"><div class="top"><div><div class="title">Appointments</div><div class="sub">Showroom and client scheduling</div></div><span class="status active">Active</span></div><p class="desc">Manage showroom visits, fitting flow, confirmations, and related operational coordination.</p><div class="features"><div class="chip">Rendez-vous</div><div class="chip">Showroom Flow</div><div class="chip">Reminders</div><div class="chip">Availability</div></div><a class="cta" href="/admin/appointments-v2${navSuffix}">Open Appointments</a></article>
    </section>
  </main>
</body>
</html>`;
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
  const navSuffix = buildAdminNavSuffix(req);
  res.redirect(`/admin/control-center${navSuffix}`);
});

app.get("/admin/control-center", (req, res) => {
  const navSuffix = buildAdminNavSuffix(req);
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.type("html").send(renderAdminControlCenterPage(navSuffix));
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
    startOperatorLearningLoopWorker();
    void registerOrdersDeleteWebhook().catch((error) => {
      console.error("[webhooks] orders/delete registration failed", error);
    });
  });
}

bootstrap().catch((error) => {
  console.error("Failed to start app", error);
  process.exit(1);
});
