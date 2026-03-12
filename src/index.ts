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
  <title>Centre de Contrôle — Mobile-Lab</title>
  <style>
    :root{
      --bg:#060a12;
      --bg-soft:#0a101b;
      --panel:rgba(19,26,40,.56);
      --panel-soft:rgba(16,22,34,.46);
      --text:#e8edf7;
      --muted:#9aa8c2;
      --line:rgba(255,255,255,.10);
      --line-strong:rgba(255,255,255,.16);
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
        radial-gradient(900px 380px at 8% -5%, rgba(125,211,252,.11), transparent 55%),
        radial-gradient(720px 340px at 95% 0%, rgba(52,211,153,.09), transparent 48%),
        linear-gradient(180deg, #060a12 0%, #070b13 48%, #070c14 100%);
      min-height:100vh;
    }
    .wrap{max-width:1320px;margin:0 auto;padding:28px 20px 42px}
    .hero{
      border:1px solid var(--line);
      border-radius:30px;
      background:linear-gradient(180deg,var(--panel) 0%, rgba(14,21,34,.62) 100%);
      backdrop-filter:blur(16px);
      padding:24px 24px 22px;
      display:grid;
      gap:16px;
      grid-template-columns:1.24fr .76fr;
    }
    .eyebrow{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--cyan);font-weight:700}
    h1{margin:8px 0 0;font-size:44px;line-height:1.06;letter-spacing:-.03em}
    .subtitle{margin:12px 0 0;color:var(--muted);font-size:17px}
    .summary{
      border:1px solid var(--line);
      border-radius:22px;
      background:rgba(14,20,32,.46);
      padding:14px 14px 10px;
    }
    .summary h3{margin:0 0 10px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
    .stat{display:flex;justify-content:space-between;align-items:center;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.03);padding:10px 12px;border-radius:12px;margin-top:8px;font-size:14px}
    .orientation{margin-top:18px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
    .tile{
      border:1px solid var(--line);
      border-radius:18px;
      background:rgba(19,26,40,.48);
      backdrop-filter:blur(14px);
      padding:14px 14px 13px;
    }
    .tile .k{font-size:11px;letter-spacing:.13em;text-transform:uppercase;color:var(--muted);font-weight:700}
    .tile .v{margin-top:8px;font-size:24px;letter-spacing:-.02em;font-weight:650}
    .tile .d{margin-top:7px;color:var(--muted);font-size:14px;line-height:1.42}
    .modules-head{
      margin:26px 0 12px;
      display:flex;
      justify-content:space-between;
      align-items:center;
      gap:10px;
    }
    .modules-head h2{margin:0;font-size:24px;letter-spacing:-.02em}
    .modules-head p{margin:6px 0 0;color:var(--muted);font-size:14px}
    .search{
      width:280px;
      max-width:100%;
      border:1px solid var(--line);
      border-radius:999px;
      background:rgba(255,255,255,.03);
      color:var(--text);
      padding:11px 14px;
      font-size:14px;
      outline:none;
    }
    .search:focus{border-color:var(--line-strong);box-shadow:0 0 0 3px rgba(125,211,252,.08)}
    .sections-grid{
      display:grid;
      gap:14px;
    }
    .section{
      border:1px solid var(--line);
      border-radius:24px;
      background:linear-gradient(180deg,var(--panel-soft) 0%, rgba(13,18,29,.40) 100%);
      backdrop-filter:blur(18px);
      padding:14px;
    }
    .section-title{
      margin:2px 4px 10px;
      font-size:12px;
      letter-spacing:.16em;
      text-transform:uppercase;
      color:var(--muted);
      font-weight:700;
    }
    .rows{
      display:flex;
      flex-direction:column;
      gap:9px;
    }
    .row{
      display:flex;
      align-items:center;
      gap:12px;
      border:1px solid rgba(255,255,255,.08);
      border-radius:16px;
      background:rgba(255,255,255,.02);
      padding:12px 13px;
      text-decoration:none;
      color:inherit;
      transition:border-color .2s ease, transform .2s ease, background .2s ease;
    }
    .row:hover{
      border-color:rgba(255,255,255,.18);
      background:rgba(255,255,255,.05);
      transform:translateY(-1px);
    }
    .icon{
      width:34px;
      height:34px;
      border-radius:10px;
      border:1px solid rgba(255,255,255,.14);
      background:rgba(125,211,252,.08);
      display:grid;
      place-items:center;
      color:#d8f2ff;
      font-size:15px;
      flex:0 0 34px;
    }
    .content{
      min-width:0;
      flex:1 1 auto;
    }
    .title{
      margin:0;
      font-size:17px;
      line-height:1.2;
      letter-spacing:-.01em;
      font-weight:650;
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
      padding:7px 10px;
      border:1px solid;
      flex:0 0 auto;
      margin-left:6px;
    }
    .active{color:#d9ffe9;background:rgba(34,197,94,.13);border-color:rgba(74,222,128,.35)}
    .progress{color:#ffefcf;background:rgba(245,158,11,.14);border-color:rgba(245,158,11,.35)}
    .arrow{
      color:#a8b8d2;
      font-size:20px;
      line-height:1;
      flex:0 0 auto;
    }
    @media (max-width:1150px){
      .hero{grid-template-columns:1fr}
    }
    @media (min-width:1080px){
      .sections-grid{
        grid-template-columns:repeat(3,minmax(0,1fr));
        align-items:start;
      }
    }
    @media (max-width:760px){
      .orientation{grid-template-columns:1fr}
      .modules-head{align-items:flex-start;flex-direction:column}
      .search{width:100%}
      h1{font-size:34px}
    }
  </style>
</head>
<body>
  <main class="wrap">
    <section class="hero">
      <div>
        <p class="eyebrow">Centre de Contrôle Projet</p>
        <h1>Index central de toutes les zones du projet</h1>
        <p class="subtitle">Un point d'entrée simple et structuré vers la plateforme.</p>
      </div>
      <aside class="summary">
        <h3>Résumé Système</h3>
        <div class="stat"><span>Modules</span><strong>9</strong></div>
        <div class="stat"><span>Structure</span><strong style="color:var(--green)">Structurée</strong></div>
        <div class="stat"><span>Navigation</span><strong>Claire</strong></div>
      </aside>
    </section>

    <section class="orientation">
      <article class="tile"><div class="k">Point de départ recommandé</div><div class="v">Insights</div><div class="d">Le meilleur point d'entrée pour comprendre la situation business et les priorités.</div></article>
      <article class="tile"><div class="k">Zone de décision</div><div class="v">Forecast</div><div class="d">À utiliser pour les projections, la planification, le revenu attendu et les scénarios.</div></article>
      <article class="tile"><div class="k">Zone d'exécution</div><div class="v">Mobile App</div><div class="d">Pour l'action, l'activité opérateur, les validations et l'exécution quotidienne.</div></article>
    </section>

    <header class="modules-head">
      <div>
        <h2>Navigation Système</h2>
        <p>Groupée par fonction pour un scan plus rapide et un choix de module plus clair.</p>
      </div>
      <input id="moduleSearch" class="search" type="search" placeholder="Rechercher un module..." />
    </header>

    <div class="sections-grid">
      <section class="section section-block">
        <p class="section-title">Opérations</p>
        <div class="rows">
          <a class="row module-row" data-search="agent control center operations runs leads approvals system brain" href="/agent-control-center-v1/#/index${navSuffix}">
            <div class="icon">◎</div>
            <div class="content">
              <p class="title">Agent Control Center V1</p>
              <p class="subtitle">Cockpit d'opérations IA pour les runs, validations, leads et supervision système</p>
            </div>
            <span class="status active">Actif</span>
            <span class="arrow">›</span>
          </a>
          <a class="row module-row" data-search="mobile app conversations approvals execution operator actions" href="/whatsapp-intelligence/mobile-lab${navSuffix}">
            <div class="icon">◉</div>
            <div class="content">
              <p class="title">Mobile App</p>
              <p class="subtitle">Espace opérationnel pour une exécution rapide avec workflows opérateur</p>
            </div>
            <span class="status progress">En cours</span>
            <span class="arrow">›</span>
          </a>
        </div>
      </section>

      <section class="section section-block">
        <p class="section-title">Intelligence</p>
        <div class="rows">
          <a class="row module-row" data-search="insights analytics conversion intelligence performance overview" href="/admin/insights${navSuffix}">
            <div class="icon">◌</div>
            <div class="content">
              <p class="title">Insights</p>
              <p class="subtitle">Business intelligence et analyses actionnables sur les signaux de performance</p>
            </div>
            <span class="status active">Actif</span>
            <span class="arrow">›</span>
          </a>
          <a class="row module-row" data-search="forecast projections revenue demand scenarios planning" href="/admin/forecast-v4${navSuffix}">
            <div class="icon">◍</div>
            <div class="content">
              <p class="title">Forecast</p>
              <p class="subtitle">Pilotage des projections de revenu, de demande et d'opérations</p>
            </div>
            <span class="status active">Actif</span>
            <span class="arrow">›</span>
          </a>
          <a class="row module-row" data-search="whatsapp intelligence priority stage detection learning loop replies" href="/whatsapp-intelligence${navSuffix}">
            <div class="icon">◈</div>
            <div class="content">
              <p class="title">WhatsApp Intelligence</p>
              <p class="subtitle">Analyse conversationnelle, priorités et guidance stratégique opérateur</p>
            </div>
            <span class="status active">Actif</span>
            <span class="arrow">›</span>
          </a>
          <a class="row module-row" data-search="blueprint architecture system map flux modules services" href="/blueprint${navSuffix}">
            <div class="icon">◇</div>
            <div class="content">
              <p class="title">Blueprint</p>
              <p class="subtitle">Vue architecture système et cartographie des flux applicatifs</p>
            </div>
            <span class="status active">Actif</span>
            <span class="arrow">›</span>
          </a>
        </div>
      </section>

      <section class="section section-block">
        <p class="section-title">Business</p>
        <div class="rows">
          <a class="row module-row" data-search="creer nouvelle facture invoice generation facturation" href="/admin/invoices${navSuffix}">
            <div class="icon">◔</div>
            <div class="content">
              <p class="title">Créer une nouvelle facture</p>
              <p class="subtitle">Accès direct au générateur de facture et à l’aperçu PDF</p>
            </div>
            <span class="status active">Actif</span>
            <span class="arrow">›</span>
          </a>
          <a class="row module-row" data-search="orders payments deposits balances invoices commerce" href="/admin/invoices${navSuffix}">
            <div class="icon">◐</div>
            <div class="content">
              <p class="title">Orders & Payments</p>
              <p class="subtitle">Visibilité commerciale sur commandes, acomptes, soldes et état de paiement</p>
            </div>
            <span class="status active">Actif</span>
            <span class="arrow">›</span>
          </a>
          <a class="row module-row" data-search="appointments showroom scheduling reminders availability" href="/admin/appointments-v2${navSuffix}">
            <div class="icon">◒</div>
            <div class="content">
              <p class="title">Appointments</p>
              <p class="subtitle">Planification showroom, confirmations, rappels et coordination</p>
            </div>
            <span class="status active">Actif</span>
            <span class="arrow">›</span>
          </a>
        </div>
      </section>
    </div>
  </main>
  <script>
    const input = document.getElementById("moduleSearch");
    const rows = Array.from(document.querySelectorAll(".module-row"));
    const sections = Array.from(document.querySelectorAll(".section-block"));
    if (input) {
      input.addEventListener("input", (event) => {
        const q = String(event.target.value || "").toLowerCase().trim();
        rows.forEach((row) => {
          const hay = String(row.getAttribute("data-search") || "").toLowerCase();
          row.style.display = q && !hay.includes(q) ? "none" : "flex";
        });
        sections.forEach((section) => {
          const visibleRows = Array.from(section.querySelectorAll(".module-row")).some((row) => row.style.display !== "none");
          section.style.display = visibleRows ? "block" : "none";
        });
      });
    }
  </script>
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
