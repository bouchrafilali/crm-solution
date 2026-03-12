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
      --bg:#0a1020;
      --bg-soft:#121a2c;
      --panel:rgba(31,41,62,.50);
      --panel-soft:rgba(27,36,56,.42);
      --text:#ecf2ff;
      --muted:#afbdd7;
      --line:rgba(255,255,255,.15);
      --line-strong:rgba(255,255,255,.24);
      --cyan:#7dd3fc;
      --green:#86efac;
      --amber:#fcd34d;
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
      background:
        radial-gradient(980px 420px at 8% -5%, rgba(125,211,252,.22), transparent 58%),
        radial-gradient(760px 380px at 95% 0%, rgba(52,211,153,.14), transparent 50%),
        linear-gradient(180deg, #0a1120 0%, #0c1424 48%, #0d1628 100%);
      min-height:100vh;
      min-height:100dvh;
      padding-left:max(0px, env(safe-area-inset-left));
      padding-right:max(0px, env(safe-area-inset-right));
      padding-bottom:max(0px, env(safe-area-inset-bottom));
    }
    .wrap{max-width:1320px;margin:0 auto;padding:28px 20px 42px}
    .orientation{margin-top:8px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
    .orientation::-webkit-scrollbar{display:none}
    .tile{
      border:1px solid var(--line);
      border-radius:18px;
      background:rgba(25,35,54,.50);
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
      background:rgba(255,255,255,.08);
      color:var(--text);
      padding:12px 14px;
      font-size:14px;
      min-height:44px;
      outline:none;
      -webkit-appearance:none;
      appearance:none;
    }
    .search:focus{border-color:var(--line-strong);box-shadow:0 0 0 3px rgba(125,211,252,.08)}
    .sections-grid{
      display:grid;
      gap:14px;
    }
    .apps-rail{
      display:none;
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
      flex-direction:column;
      align-items:center;
      justify-content:center;
      gap:6px;
      width:82px;
      min-width:82px;
      min-height:100px;
      border:1px solid rgba(255,255,255,.10);
      border-radius:18px;
      background:rgba(255,255,255,.08);
      color:#d5def0;
      text-decoration:none;
      font-size:10px;
      font-weight:600;
      padding:8px 6px;
      text-align:center;
    }
    .app-chip:hover{
      border-color:rgba(125,211,252,.45);
      background:rgba(125,211,252,.18);
      color:#e8f7ff;
    }
    .app-icon{
      width:50px;
      height:50px;
      border-radius:15px;
      border:1px solid rgba(255,255,255,.20);
      background:linear-gradient(180deg, rgba(125,211,252,.30) 0%, rgba(56,189,248,.20) 100%);
      box-shadow:inset 0 1px 0 rgba(255,255,255,.22), 0 8px 16px -10px rgba(0,0,0,.7);
      display:grid;
      place-items:center;
      color:#f4fbff;
      font-size:18px;
    }
    .app-chip-label{
      display:block;
      line-height:1.15;
      letter-spacing:.01em;
      color:#dbe7ff;
      max-width:100%;
    }
    .app-dot{
      width:8px;
      height:8px;
      border-radius:999px;
      background:rgba(125,211,252,.65);
      box-shadow:0 0 10px rgba(125,211,252,.45);
    }
    .home-section{
      border:1px solid rgba(255,255,255,.14);
      border-radius:20px;
      background:rgba(26,37,58,.45);
      backdrop-filter:blur(14px) saturate(140%);
      padding:12px 10px;
      margin-top:10px;
    }
    .home-section-title{
      margin:0 2px 10px;
      font-size:10px;
      letter-spacing:.14em;
      color:#b7c6e2;
      font-weight:700;
      text-transform:uppercase;
    }
    .home-grid{
      display:grid;
      grid-template-columns:repeat(4,minmax(0,1fr));
      gap:12px 8px;
    }
    .home-app{
      text-decoration:none;
      color:#e8f1ff;
      display:flex;
      flex-direction:column;
      align-items:center;
      gap:6px;
      min-width:0;
      -webkit-tap-highlight-color:rgba(125,211,252,.2);
    }
    .home-app-icon{
      width:64px;
      height:64px;
      border-radius:18px;
      border:1px solid rgba(255,255,255,.24);
      background:linear-gradient(180deg, rgba(125,211,252,.34) 0%, rgba(56,189,248,.20) 100%);
      box-shadow:inset 0 1px 0 rgba(255,255,255,.26), 0 10px 18px -14px rgba(0,0,0,.78);
      display:grid;
      place-items:center;
      color:#f4fbff;
      font-size:22px;
      font-weight:700;
    }
    .home-app-label{
      display:block;
      max-width:72px;
      font-size:11px;
      line-height:1.15;
      text-align:center;
      color:#d7e5ff;
      letter-spacing:.01em;
      overflow:hidden;
      text-overflow:ellipsis;
      white-space:nowrap;
    }
    .section{
      border:1px solid var(--line);
      border-radius:24px;
      background:linear-gradient(180deg,var(--panel-soft) 0%, rgba(21,30,47,.46) 100%);
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
      background:rgba(255,255,255,.06);
      padding:12px 13px;
      text-decoration:none;
      color:inherit;
      transition:border-color .2s ease, transform .2s ease, background .2s ease;
      min-height:56px;
      -webkit-tap-highlight-color:rgba(125,211,252,.2);
    }
    .row:hover{
      border-color:rgba(255,255,255,.26);
      background:rgba(255,255,255,.10);
      transform:translateY(-1px);
    }
    .icon{
      width:36px;
      height:36px;
      border-radius:10px;
      border:1px solid rgba(255,255,255,.14);
      background:rgba(125,211,252,.14);
      display:grid;
      place-items:center;
      color:#d8f2ff;
      font-size:15px;
      flex:0 0 36px;
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
      min-height:28px;
      display:inline-flex;
      align-items:center;
    }
    .active{color:#d9ffe9;background:rgba(34,197,94,.13);border-color:rgba(74,222,128,.35)}
    .progress{color:#ffefcf;background:rgba(245,158,11,.14);border-color:rgba(245,158,11,.35)}
    .arrow{
      color:#a8b8d2;
      font-size:20px;
      line-height:1;
      flex:0 0 auto;
    }
    @media (min-width:1080px){
      .sections-grid{
        grid-template-columns:repeat(3,minmax(0,1fr));
        align-items:start;
      }
    }
    @media (max-width:760px){
      .wrap{
        padding:16px 14px calc(116px + env(safe-area-inset-bottom));
      }
      .orientation{
        display:flex;
        gap:10px;
        overflow-x:auto;
        scroll-snap-type:x mandatory;
        -webkit-overflow-scrolling:touch;
        padding-bottom:2px;
      }
      .modules-head{align-items:flex-start;flex-direction:column}
      .search{width:100%}
      .tile{
        border-radius:14px;
        padding:12px 12px 11px;
        min-width:85%;
        flex:0 0 85%;
        scroll-snap-align:start;
      }
      .tile .v{
        font-size:22px;
      }
      .modules-head{
        margin:18px 0 10px;
        gap:8px;
      }
      .modules-head h2{
        font-size:21px;
      }
      .modules-head p{
        font-size:13px;
      }
      .modules-head{
        display:none;
      }
      .sections-grid{
        gap:10px;
        display:none;
      }
      .apps-rail{
        position:fixed;
        left:12px;
        right:12px;
        bottom:calc(10px + env(safe-area-inset-bottom));
        z-index:5;
        display:block;
        margin:0 0 10px;
        border:1px solid rgba(255,255,255,.24);
        border-radius:16px;
        background:rgba(26,37,58,.58);
        backdrop-filter:blur(16px) saturate(150%);
        box-shadow:0 12px 26px -20px rgba(0,0,0,.85);
        padding:7px;
      }
      .apps-track{
        gap:10px;
        justify-content:space-between;
      }
      .app-chip{
        width:calc((100% - 30px) / 4);
        min-width:0;
        min-height:74px;
        border-radius:14px;
        padding:5px 4px;
        font-size:9px;
      }
      .app-icon{
        width:38px;
        height:38px;
        border-radius:12px;
        font-size:16px;
      }
      .app-chip-label{
        font-size:9px;
      }
      .apps-track{
        gap:10px;
      }
      .app-dot{
        display:none;
      }
      .mobile-home{
        display:block;
      }
      .section{
        border-radius:18px;
        padding:10px;
        background:rgba(29,40,61,.62);
        backdrop-filter:blur(14px) saturate(145%);
      }
      .section-title{
        margin:1px 4px 8px;
        font-size:11px;
      }
      .rows{
        gap:8px;
      }
      .row{
        border-radius:16px;
        padding:11px 12px;
        min-height:60px;
        background:rgba(255,255,255,.10);
        border-color:rgba(255,255,255,.18);
      }
      .title{
        font-size:16px;
        font-weight:700;
      }
      .subtitle{
        font-size:12px;
        -webkit-line-clamp:2;
        color:#c1cee5;
      }
      .arrow{
        font-size:18px;
        color:#d0dcf4;
      }
      .status{
        font-size:9px;
        letter-spacing:.10em;
        padding:6px 8px;
      }
      .orientation{
        margin-bottom:8px;
      }
    }
    @media (max-width:420px){
      .icon{
        width:34px;
        height:34px;
        flex:0 0 34px;
      }
      .status{
        padding:5px 7px;
      }
      .home-grid{
        gap:11px 6px;
      }
      .home-app-icon{
        width:60px;
        height:60px;
      }
      .home-app-label{
        max-width:66px;
      }
    }
  </style>
</head>
<body>
  <main class="wrap">
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

    <div class="apps-rail" id="appsRail">
      <div class="apps-track" id="recentAppsTrack"></div>
    </div>

    <div class="mobile-home">
      <section class="home-section section-block" data-section="operations">
        <p class="home-section-title">Operations</p>
        <div class="home-grid">
          <a class="home-app module-item" data-app-id="agent" data-search="agent control center operations runs leads approvals system brain" href="/agent-control-center-v1/#/index${navSuffix}">
            <span class="home-app-icon">◎</span><span class="home-app-label">Agent Control</span>
          </a>
          <a class="home-app module-item" data-app-id="mobile" data-search="mobile app conversations approvals execution operator actions" href="/whatsapp-intelligence/mobile-lab${navSuffix}">
            <span class="home-app-icon">◉</span><span class="home-app-label">Mobile App</span>
          </a>
        </div>
      </section>

      <section class="home-section section-block" data-section="intelligence">
        <p class="home-section-title">Intelligence</p>
        <div class="home-grid">
          <a class="home-app module-item" data-app-id="insights" data-search="insights analytics conversion intelligence performance overview" href="/admin/insights${navSuffix}">
            <span class="home-app-icon">◌</span><span class="home-app-label">Insights</span>
          </a>
          <a class="home-app module-item" data-app-id="forecast" data-search="forecast projections revenue demand scenarios planning" href="/admin/forecast-v4${navSuffix}">
            <span class="home-app-icon">◍</span><span class="home-app-label">Forecast</span>
          </a>
          <a class="home-app module-item" data-app-id="whatsapp" data-search="whatsapp intelligence priority stage detection learning loop replies" href="/whatsapp-intelligence${navSuffix}">
            <span class="home-app-icon">◈</span><span class="home-app-label">WhatsApp</span>
          </a>
          <a class="home-app module-item" data-app-id="blueprint" data-search="blueprint architecture system map flux modules services" href="/blueprint${navSuffix}">
            <span class="home-app-icon">◇</span><span class="home-app-label">Blueprint</span>
          </a>
        </div>
      </section>

      <section class="home-section section-block" data-section="business">
        <p class="home-section-title">Business</p>
        <div class="home-grid">
          <a class="home-app module-item" data-app-id="invoice" data-search="creer nouvelle facture invoice generation facturation" href="/admin/invoices${navSuffix}">
            <span class="home-app-icon">◔</span><span class="home-app-label">Facture</span>
          </a>
          <a class="home-app module-item" data-app-id="orders" data-search="orders payments deposits balances invoices commerce" href="/admin/invoices${navSuffix}">
            <span class="home-app-icon">◐</span><span class="home-app-label">Orders</span>
          </a>
          <a class="home-app module-item" data-app-id="appointments" data-search="appointments showroom scheduling reminders availability" href="/admin/appointments-v2${navSuffix}">
            <span class="home-app-icon">◒</span><span class="home-app-label">Appointments</span>
          </a>
        </div>
      </section>
    </div>

    <div class="sections-grid">
      <section class="section section-block" data-section="operations">
        <p class="section-title">Opérations</p>
        <div class="rows">
          <a class="row module-row module-item" data-app-id="agent" data-search="agent control center operations runs leads approvals system brain" href="/agent-control-center-v1/#/index${navSuffix}">
            <div class="icon">◎</div>
            <div class="content">
              <p class="title">Agent Control Center V1</p>
              <p class="subtitle">Cockpit d'opérations IA pour les runs, validations, leads et supervision système</p>
            </div>
            <span class="status active">Actif</span>
            <span class="arrow">›</span>
          </a>
          <a class="row module-row module-item" data-app-id="mobile" data-search="mobile app conversations approvals execution operator actions" href="/whatsapp-intelligence/mobile-lab${navSuffix}">
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

      <section class="section section-block" data-section="intelligence">
        <p class="section-title">Intelligence</p>
        <div class="rows">
          <a class="row module-row module-item" data-app-id="insights" data-search="insights analytics conversion intelligence performance overview" href="/admin/insights${navSuffix}">
            <div class="icon">◌</div>
            <div class="content">
              <p class="title">Insights</p>
              <p class="subtitle">Business intelligence et analyses actionnables sur les signaux de performance</p>
            </div>
            <span class="status active">Actif</span>
            <span class="arrow">›</span>
          </a>
          <a class="row module-row module-item" data-app-id="forecast" data-search="forecast projections revenue demand scenarios planning" href="/admin/forecast-v4${navSuffix}">
            <div class="icon">◍</div>
            <div class="content">
              <p class="title">Forecast</p>
              <p class="subtitle">Pilotage des projections de revenu, de demande et d'opérations</p>
            </div>
            <span class="status active">Actif</span>
            <span class="arrow">›</span>
          </a>
          <a class="row module-row module-item" data-app-id="whatsapp" data-search="whatsapp intelligence priority stage detection learning loop replies" href="/whatsapp-intelligence${navSuffix}">
            <div class="icon">◈</div>
            <div class="content">
              <p class="title">WhatsApp Intelligence</p>
              <p class="subtitle">Analyse conversationnelle, priorités et guidance stratégique opérateur</p>
            </div>
            <span class="status active">Actif</span>
            <span class="arrow">›</span>
          </a>
          <a class="row module-row module-item" data-app-id="blueprint" data-search="blueprint architecture system map flux modules services" href="/blueprint${navSuffix}">
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

      <section class="section section-block" data-section="business">
        <p class="section-title">Business</p>
        <div class="rows">
          <a class="row module-row module-item" data-app-id="invoice" data-search="creer nouvelle facture invoice generation facturation" href="/admin/invoices${navSuffix}">
            <div class="icon">◔</div>
            <div class="content">
              <p class="title">Créer une nouvelle facture</p>
              <p class="subtitle">Accès direct au générateur de facture et à l’aperçu PDF</p>
            </div>
            <span class="status active">Actif</span>
            <span class="arrow">›</span>
          </a>
          <a class="row module-row module-item" data-app-id="orders" data-search="orders payments deposits balances invoices commerce" href="/admin/invoices${navSuffix}">
            <div class="icon">◐</div>
            <div class="content">
              <p class="title">Orders & Payments</p>
              <p class="subtitle">Visibilité commerciale sur commandes, acomptes, soldes et état de paiement</p>
            </div>
            <span class="status active">Actif</span>
            <span class="arrow">›</span>
          </a>
          <a class="row module-row module-item" data-app-id="appointments" data-search="appointments showroom scheduling reminders availability" href="/admin/appointments-v2${navSuffix}">
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
    const moduleItems = Array.from(document.querySelectorAll(".module-row, .home-app.module-item"));
    const recentAppsTrack = document.getElementById("recentAppsTrack");
    const sections = Array.from(document.querySelectorAll(".section-block"));
    const appCatalog = {
      agent: { label: "Agent", icon: "◎", href: "/agent-control-center-v1/#/index${navSuffix}" },
      mobile: { label: "Mobile", icon: "◉", href: "/whatsapp-intelligence/mobile-lab${navSuffix}" },
      insights: { label: "Insights", icon: "◌", href: "/admin/insights${navSuffix}" },
      forecast: { label: "Forecast", icon: "◍", href: "/admin/forecast-v4${navSuffix}" },
      whatsapp: { label: "WhatsApp", icon: "◈", href: "/whatsapp-intelligence${navSuffix}" },
      blueprint: { label: "Blueprint", icon: "◇", href: "/blueprint${navSuffix}" },
      invoice: { label: "Facture", icon: "◔", href: "/admin/invoices${navSuffix}" },
      orders: { label: "Orders", icon: "◐", href: "/admin/invoices${navSuffix}" },
      appointments: { label: "RDV", icon: "◒", href: "/admin/appointments-v2${navSuffix}" }
    };
    const defaultRecentApps = ["agent", "mobile", "insights", "whatsapp"];

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
      const q = String((input && input.value) || "").toLowerCase().trim();
      sections.forEach((section) => {
        const allRows = Array.from(section.querySelectorAll(".module-row, .home-app.module-item"));
        const visibleRows = allRows.filter((row) => row.style.display !== "none");
        const hasVisibleRows = visibleRows.length > 0;
        section.style.display = hasVisibleRows ? "block" : "none";
      });
    }

    if (input) {
      input.addEventListener("input", (event) => {
        const q = String(event.target.value || "").toLowerCase().trim();
        const liveItems = Array.from(document.querySelectorAll(".module-row, .home-app.module-item, .app-chip.module-item"));
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

const appShellRouteMap: Array<{ path: string; hash: string }> = [
  { path: "/control-center", hash: "#/control-center" },
  { path: "/agent-control-center", hash: "#/agent-control-center" },
  { path: "/mobile-app", hash: "#/mobile-app" },
  { path: "/insights", hash: "#/insights" },
  { path: "/forecast", hash: "#/forecast" },
  { path: "/whatsapp-intelligence-app", hash: "#/whatsapp-intelligence" },
  { path: "/blueprint-app", hash: "#/blueprint" },
  { path: "/create-invoice", hash: "#/create-invoice" },
  { path: "/orders-payments", hash: "#/orders-payments" },
  { path: "/appointments", hash: "#/appointments" }
];

for (const route of appShellRouteMap) {
  app.get(route.path, (req, res) => {
    const suffix = buildAdminNavSuffix(req);
    res.redirect(`/agent-control-center-v1/${suffix}${route.hash}`);
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
