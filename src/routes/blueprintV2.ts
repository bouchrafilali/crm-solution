import { Router } from "express";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "../config/env.js";
import { isDbEnabled, withDbClient } from "../db/db.js";

export const blueprintV2Router = Router();

function firstExistingPath(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function buildFallbackBlueprint() {
  return {
    metadata: {
      projectName: "Shopify Business App",
      generatedDate: new Date().toISOString().slice(0, 10),
      totalRoutes: 0,
      totalModules: 3,
      totalServices: 0,
      totalDatabases: 0
    },
    nodes: [
      {
        id: "whatsapp_intelligence",
        label: "WhatsApp Intelligence",
        type: "module",
        color: "#2eb67d",
        description: "Lead management and conversation automation"
      },
      {
        id: "orders",
        label: "Orders & Invoicing",
        type: "module",
        color: "#ecb22e",
        description: "Orders, quotes and invoicing"
      },
      {
        id: "appointments",
        label: "Appointments",
        type: "module",
        color: "#e01e5a",
        description: "Scheduling and reminders"
      }
    ],
    edges: []
  };
}

// ── Live metrics from the database ──────────────────────────────────────────

type LiveMetrics = Record<string, Record<string, number>>;

async function getLiveBlueprintMetrics(): Promise<LiveMetrics> {
  if (!isDbEnabled()) return {};

  try {
    const row = await withDbClient(async (client) => {
      await client.query("begin");
      try {
        // Keep blueprint responsive even when DB is slow.
        await client.query("set local statement_timeout = '1500ms'");
        const res = await client.query<{
          active_leads: string;
          pending_qualification: string;
          deposit_pending: string;
          avg_response_time: string | null;
          today_appointments: string;
          upcoming_week: string;
          pending_orders: string;
          outstanding_count: string;
        }>(`
          SELECT
            (SELECT COUNT(*) FILTER (WHERE stage NOT IN ('CONVERTED','LOST'))::text FROM whatsapp_leads) AS active_leads,
            (SELECT COUNT(*) FILTER (WHERE stage = 'QUALIFICATION_PENDING')::text FROM whatsapp_leads) AS pending_qualification,
            (SELECT COUNT(*) FILTER (WHERE stage = 'DEPOSIT_PENDING')::text FROM whatsapp_leads) AS deposit_pending,
            (
              SELECT ROUND(
                AVG(first_response_time_minutes) FILTER (WHERE first_response_time_minutes IS NOT NULL)::numeric,
                1
              )::text
              FROM whatsapp_leads
            ) AS avg_response_time,
            (
              SELECT COUNT(*) FILTER (
                WHERE DATE(appointment_at) = CURRENT_DATE AND status != 'cancelled'
              )::text
              FROM appointments
            ) AS today_appointments,
            (
              SELECT COUNT(*) FILTER (
                WHERE appointment_at >= NOW()
                  AND appointment_at < NOW() + INTERVAL '7 days'
                  AND status != 'cancelled'
              )::text
              FROM appointments
            ) AS upcoming_week,
            (
              SELECT COUNT(*) FILTER (WHERE financial_status = 'pending')::text
              FROM orders
            ) AS pending_orders,
            (
              SELECT COUNT(*) FILTER (
                WHERE outstanding_amount > 0
                  AND financial_status NOT IN ('refunded','voided')
              )::text
              FROM orders
            ) AS outstanding_count
        `);
        await client.query("commit");
        return res.rows[0] ?? null;
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    });

    if (!row) return {};

    return {
      whatsapp_intelligence: {
        activeLeads: parseInt(row.active_leads ?? "0", 10),
        pendingQualification: parseInt(row.pending_qualification ?? "0", 10),
        depositPending: parseInt(row.deposit_pending ?? "0", 10),
        avgResponseTime: parseFloat(row.avg_response_time ?? "0")
      },
      appointments: {
        todayAppointments: parseInt(row.today_appointments ?? "0", 10),
        upcomingWeek: parseInt(row.upcoming_week ?? "0", 10)
      },
      orders: {
        pendingOrders: parseInt(row.pending_orders ?? "0", 10),
        outstandingCount: parseInt(row.outstanding_count ?? "0", 10)
      }
    };
  } catch (error) {
    console.warn("[blueprint] Live metrics unavailable, fallback to static view", error);
    return {};
  }
}

blueprintV2Router.get("/api/blueprint", async (_req, res) => {
  try {
    const blueprintPath = firstExistingPath([
      join(process.cwd(), "system-blueprint.json"),
      join(process.cwd(), "dist/system-blueprint.json")
    ]);
    const blueprint = blueprintPath
      ? JSON.parse(readFileSync(blueprintPath, "utf-8"))
      : buildFallbackBlueprint();

    const liveMetrics = await getLiveBlueprintMetrics();

    const enhancedBlueprint = {
      ...blueprint,
      nodes: blueprint.nodes.map((node: any) => {
        const statusMeta = getNodeStatusMeta(node);
        return {
          ...node,
          status: statusMeta.status,
          statusReason: statusMeta.reason,
          layer: getNodeLayer(node),
          importance: getNodeImportance(node),
          metrics: liveMetrics[node.id as string] ?? null,
          lastSync: node.type === "external" ? new Date().toISOString() : null
        };
      })
    };

    return res.status(200).json(enhancedBlueprint);
  } catch (error) {
    console.error("[blueprint] Failed to load blueprint", error);
    return res.status(500).json({ error: "blueprint_load_failed" });
  }
});

function getNodeStatusMeta(node: any): {
  status: "healthy" | "warning" | "error" | "inactive";
  reason: string | null;
} {
  if (node.type !== "external") return { status: "healthy", reason: "Internal service" };
  const nodeId = String(node.id || "").trim().toLowerCase();
  if (nodeId === "google_trends") {
    const trendsKeywords = String(env.TRENDS_KEYWORDS || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    return trendsKeywords.length > 0
      ? { status: "healthy", reason: `Configured (${trendsKeywords.length} keyword${trendsKeywords.length > 1 ? "s" : ""})` }
      : { status: "warning", reason: "Missing TRENDS_KEYWORDS" };
  }
  if (nodeId === "bigquery") {
    const missing: string[] = [];
    if (!String(env.GCP_PROJECT_ID || "").trim()) missing.push("GCP_PROJECT_ID");
    if (!String(env.BIGQUERY_DATASET || "").trim()) missing.push("BIGQUERY_DATASET");
    if (!String(env.BIGQUERY_LOCATION || "").trim()) missing.push("BIGQUERY_LOCATION");
    return missing.length === 0
      ? { status: "healthy", reason: "Configured (project, dataset, location)" }
      : { status: "warning", reason: `Missing ${missing.join(", ")}` };
  }
  if (nodeId === "shopify_api") {
    const configured = Boolean(String(env.SHOPIFY_SHOP || "").trim());
    return configured
      ? { status: "healthy", reason: "Configured (SHOPIFY_SHOP)" }
      : { status: "warning", reason: "Missing SHOPIFY_SHOP" };
  }
  if (nodeId === "zoko_api") {
    const missing: string[] = [];
    if (!String(env.ZOKO_API_URL || "").trim()) missing.push("ZOKO_API_URL");
    if (!String(env.ZOKO_AUTH_TOKEN || "").trim()) missing.push("ZOKO_AUTH_TOKEN");
    return missing.length === 0
      ? { status: "healthy", reason: "Configured (API URL + auth token)" }
      : { status: "warning", reason: `Missing ${missing.join(", ")}` };
  }

  return { status: "healthy", reason: "External service" };
}

function getNodeLayer(node: any): "business" | "service" | "repository" | "route" {
  if (node.type === "module") return "business";
  if (node.type === "service") return "service";
  if (node.type === "database") return "repository";
  if (node.type === "endpoint" || node.type === "webhook") return "route";
  return "service";
}

function getNodeImportance(node: any): "core" | "secondary" {
  const coreModules = ["whatsapp_intelligence", "ai_services", "orders", "forecasting"];
  const coreServices = ["service_ai_whatsapp", "service_stage_progression", "service_suggestions"];
  
  if (coreModules.includes(node.id)) return "core";
  if (coreServices.includes(node.id)) return "core";
  if (node.type === "module") return "core";
  return "secondary";
}


blueprintV2Router.get("/blueprint", (_req, res) => {
  const stylesPath = firstExistingPath([
    join(process.cwd(), "frontend/blueprint-v2/styles.css"),
    join(process.cwd(), "dist/frontend/blueprint-v2/styles.css")
  ]);
  const appPath = firstExistingPath([
    join(process.cwd(), "frontend/blueprint-v2/app.js"),
    join(process.cwd(), "dist/frontend/blueprint-v2/app.js")
  ]);
  
  let styles = "";
  let appScript = "";
  let assetsLoaded = true;
  
  try {
    if (!stylesPath || !appPath) {
      assetsLoaded = false;
      throw new Error("Blueprint frontend assets not found");
    }
    styles = readFileSync(stylesPath, "utf-8");
    appScript = readFileSync(appPath, "utf-8");
  } catch (error) {
    console.error("[blueprint] Failed to load assets", error);
    assetsLoaded = false;
    styles = `
      body { margin: 0; font-family: system-ui,-apple-system,Segoe UI,Roboto,sans-serif; background:#0b1220; color:#e5e7eb; }
      .wrap { max-width: 960px; margin: 40px auto; padding: 0 16px; }
      .title { font-size: 24px; font-weight: 700; margin-bottom: 6px; }
      .muted { color: #9ca3af; margin-bottom: 18px; }
      .card { background:#111827; border:1px solid #1f2937; border-radius:12px; padding:14px; margin-bottom:12px; }
      .node-title { font-weight:600; margin-bottom:6px; }
      .badge { display:inline-block; padding:2px 8px; border-radius:999px; background:#1f2937; color:#d1d5db; font-size:12px; }
      .err { color:#fca5a5; margin-bottom:12px; }
    `;
    appScript = `
      async function run() {
        const root = document.getElementById("root");
        if (!root) return;
        try {
          const res = await fetch("/api/blueprint");
          if (!res.ok) throw new Error("API failed: " + res.status);
          const data = await res.json();
          const nodes = Array.isArray(data.nodes) ? data.nodes : [];
          root.innerHTML = '<div class="wrap"><div class="title">System Blueprint</div><div class="muted">Fallback mode (frontend assets missing in deployment)</div>' +
            nodes.map(n => '<div class="card"><div class="node-title">' + (n.label || n.id || "Node") + '</div><span class="badge">' + (n.type || "module") + '</span><div class="muted" style="margin-top:8px">' + (n.description || "") + '</div></div>').join("") +
            '</div>';
        } catch (e) {
          root.innerHTML = '<div class="wrap"><div class="title">System Blueprint</div><div class="err">Unable to load blueprint: ' + (e && e.message ? e.message : "unknown error") + '</div></div>';
        }
      }
      run();
    `;
  }
  
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>System Blueprint - 3-Layer Intelligence</title>
    <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
    <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
    <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/reactflow@11.10.4/dist/umd/index.js"></script>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reactflow@11.10.4/dist/style.css" />
    <script>
      window.addEventListener("error", function(e) {
        const root = document.getElementById("root");
        if (!root) return;
        root.innerHTML = '<div style="padding:24px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111">Blueprint runtime error: ' + (e.message || "Unknown error") + '</div>';
      });
    </script>
    <style>${styles}</style>
  </head>
  <body>
    <div id="root">${assetsLoaded ? "" : `<div style="padding:24px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111">Blueprint assets missing in deployment. Verify files under <code>frontend/blueprint-v2</code>.</div>`}</div>
    <script type="text/babel">${appScript}</script>
  </body>
</html>`;
  
  return res.status(200).type("html").send(html);
});
