import { Router } from "express";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "../config/env.js";
import { getDbPool } from "../db/client.js";

export const blueprintV2Router = Router();

// ── Live metrics from the database ──────────────────────────────────────────

type LiveMetrics = Record<string, Record<string, number>>;

async function getLiveBlueprintMetrics(): Promise<LiveMetrics> {
  const db = getDbPool();
  if (!db) return {};

  try {
    const [leadsRes, apptRes, ordersRes] = await Promise.all([
      db.query<{
        active_leads: string;
        pending_qualification: string;
        deposit_pending: string;
        avg_response_time: string | null;
      }>(`
        SELECT
          COUNT(*)                          FILTER (WHERE stage NOT IN ('CONVERTED','LOST'))       AS active_leads,
          COUNT(*)                          FILTER (WHERE stage = 'QUALIFICATION_PENDING')         AS pending_qualification,
          COUNT(*)                          FILTER (WHERE stage = 'DEPOSIT_PENDING')               AS deposit_pending,
          ROUND(AVG(first_response_time_minutes)
                FILTER (WHERE first_response_time_minutes IS NOT NULL)::numeric, 1)               AS avg_response_time
        FROM whatsapp_leads
      `),
      db.query<{
        today_appointments: string;
        upcoming_week: string;
      }>(`
        SELECT
          COUNT(*) FILTER (WHERE DATE(appointment_at) = CURRENT_DATE   AND status != 'cancelled') AS today_appointments,
          COUNT(*) FILTER (WHERE appointment_at >= NOW()
                             AND appointment_at <  NOW() + INTERVAL '7 days'
                             AND status != 'cancelled')                                            AS upcoming_week
        FROM appointments
      `),
      db.query<{
        pending_orders: string;
        outstanding_count: string;
      }>(`
        SELECT
          COUNT(*) FILTER (WHERE financial_status = 'pending')                                    AS pending_orders,
          COUNT(*) FILTER (WHERE outstanding_amount > 0
                             AND financial_status NOT IN ('refunded','voided'))                   AS outstanding_count
        FROM orders
      `)
    ]);

    const l = leadsRes.rows[0] ?? {};
    const a = apptRes.rows[0] ?? {};
    const o = ordersRes.rows[0] ?? {};

    return {
      whatsapp_intelligence: {
        activeLeads:          parseInt(l.active_leads          ?? "0"),
        pendingQualification: parseInt(l.pending_qualification ?? "0"),
        depositPending:       parseInt(l.deposit_pending       ?? "0"),
        avgResponseTime:      parseFloat(l.avg_response_time  ?? "0")
      },
      appointments: {
        todayAppointments: parseInt(a.today_appointments ?? "0"),
        upcomingWeek:      parseInt(a.upcoming_week      ?? "0")
      },
      orders: {
        pendingOrders:    parseInt(o.pending_orders    ?? "0"),
        outstandingCount: parseInt(o.outstanding_count ?? "0")
      }
    };
  } catch {
    return {};
  }
}

blueprintV2Router.get("/api/blueprint", async (_req, res) => {
  try {
    const blueprintPath = join(process.cwd(), "system-blueprint.json");
    const blueprintData = readFileSync(blueprintPath, "utf-8");
    const blueprint = JSON.parse(blueprintData);

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
  const stylesPath = join(process.cwd(), "frontend/blueprint-v2/styles.css");
  const appPath = join(process.cwd(), "frontend/blueprint-v2/app.js");
  
  let styles = "";
  let appScript = "";
  
  try {
    styles = readFileSync(stylesPath, "utf-8");
    appScript = readFileSync(appPath, "utf-8");
  } catch (error) {
    console.error("[blueprint] Failed to load assets", error);
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
    <style>${styles}</style>
  </head>
  <body>
    <div id="root"></div>
    <script type="text/babel">${appScript}</script>
  </body>
</html>`;
  
  return res.status(200).type("html").send(html);
});
