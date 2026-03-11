import express, { Router } from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getDbPool } from "../db/client.js";
import { listWhatsAppLeads, listRecentMessagesByLeadIds } from "../db/whatsappLeadsRepo.js";
import { listSuggestionFeedbackQueue } from "../db/whatsappSuggestionFeedbackRepo.js";

export const agentControlCenterV1Router = Router();

function firstExistingPath(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveAssetsDirs(): string[] {
  const candidates = [
    join(process.cwd(), "frontend/mobile-lab-agent-control-center-v1/dist"),
    join(process.cwd(), "dist/frontend/mobile-lab-agent-control-center-v1/dist")
  ];

  return candidates.filter((candidate) => existsSync(candidate));
}

function resolveAssetsDir(): string | null {
  return firstExistingPath(resolveAssetsDirs());
}

function toIsoDate(value: string | null | undefined): string {
  const date = value ? new Date(String(value)) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

function mapRunStatus(status: string): "success" | "waiting_human_input" | "error" {
  const normalized = String(status || "").trim().toLowerCase();
  if (normalized === "success") return "success";
  if (normalized === "error") return "error";
  return "waiting_human_input";
}

function mapPriority(score: number): "high" | "medium" | "low" {
  if (score >= 85) return "high";
  if (score >= 70) return "medium";
  return "low";
}

function mapLanguage(country: string | null): string {
  const normalized = String(country || "").trim().toUpperCase();
  if (normalized === "MA" || normalized === "FR") return "fr";
  return "en";
}

function mapNextBestAction(stage: string): string {
  const normalized = String(stage || "").toUpperCase();
  if (normalized === "NEW" || normalized === "PRODUCT_INTEREST") return "Qualify intent and event details";
  if (normalized === "QUALIFICATION_PENDING") return "Close missing info before price";
  if (normalized === "QUALIFIED" || normalized === "PRICE_SENT") return "Advance to payment clarity";
  if (normalized === "VIDEO_PROPOSED") return "Confirm availability and timing";
  if (normalized === "DEPOSIT_PENDING") return "Secure reservation with deposit";
  if (normalized === "CONFIRMED") return "Confirm execution details";
  return "Re-engage conversation momentum";
}

function mapPaymentStatus(stage: string, paymentReceived: boolean, depositPaid: boolean): "not_started" | "quote_sent" | "deposit_pending" | "confirmed" {
  if (paymentReceived || depositPaid || String(stage || "").toUpperCase() === "CONVERTED") return "confirmed";
  if (String(stage || "").toUpperCase() === "DEPOSIT_PENDING") return "deposit_pending";
  if (String(stage || "").toUpperCase() === "PRICE_SENT") return "quote_sent";
  return "not_started";
}

function parseDays(input: unknown): number {
  const raw = Number(input ?? 30);
  if (!Number.isFinite(raw)) return 30;
  return Math.max(1, Math.min(365, Math.round(raw)));
}

type AgentControlStage =
  | "ALL"
  | "NEW"
  | "PRODUCT_INTEREST"
  | "QUALIFICATION_PENDING"
  | "QUALIFIED"
  | "PRICE_SENT"
  | "VIDEO_PROPOSED"
  | "DEPOSIT_PENDING"
  | "CONFIRMED"
  | "CONVERTED"
  | "LOST";

function parseStage(input: unknown): AgentControlStage {
  const stage = String(input || "ALL").trim().toUpperCase();
  const allowed = new Set([
    "ALL",
    "NEW",
    "PRODUCT_INTEREST",
    "QUALIFICATION_PENDING",
    "QUALIFIED",
    "PRICE_SENT",
    "VIDEO_PROPOSED",
    "DEPOSIT_PENDING",
    "CONFIRMED",
    "CONVERTED",
    "LOST"
  ]);
  return allowed.has(stage) ? (stage as AgentControlStage) : "ALL";
}

function mapStrategicAction(stage: string): string {
  const normalized = String(stage || "").toUpperCase();
  if (normalized === "NEW") return "clarify_missing_info";
  if (normalized === "PRODUCT_INTEREST") return "qualify_before_price";
  if (normalized === "QUALIFICATION_PENDING") return "qualify_before_price";
  if (normalized === "QUALIFIED") return "send_contextualized_price";
  if (normalized === "PRICE_SENT") return "reassure_and_progress";
  if (normalized === "VIDEO_PROPOSED") return "propose_video_call";
  if (normalized === "DEPOSIT_PENDING") return "advance_to_deposit";
  if (normalized === "CONFIRMED") return "hold_until_confirmation";
  return "reactivate_gently";
}

function mapMomentum(score: number): string {
  if (score >= 90) return "critical";
  if (score >= 75) return "high";
  if (score >= 50) return "medium";
  return "low";
}

agentControlCenterV1Router.get("/api/agent-control-center-v1/data", async (req, res) => {
  try {
    const days = parseDays(req.query.range ?? req.query.days);
    const stage = parseStage(req.query.stage);
    const leads = await listWhatsAppLeads({ days, stage, limit: 600 });
    const leadIds = leads.map((lead) => String(lead.id || "")).filter(Boolean);
    const recentMessagesByLead = await listRecentMessagesByLeadIds(leadIds, 20);

    const db = getDbPool();
    if (!db) {
      return res.status(503).json({ error: "db_unavailable" });
    }

    const [runsQ, pendingApprovalsQ, learningQueue] = await Promise.all([
      db.query<{
        id: string;
        lead_id: string;
        message_id: string;
        status: string;
        trigger_source: string | null;
        model: string | null;
        latency_ms: number | null;
        error_text: string | null;
        created_at: string;
      }>(
        `
          select id, lead_id, message_id, status, trigger_source, model, latency_ms, error_text, created_at
          from ai_agent_runs
          order by created_at desc
          limit 220
        `
      ),
      db.query<{
        id: string;
        lead_id: string;
        created_at: string;
        product_title: string;
      }>(
        `
          select id, lead_id, created_at, product_title
          from quote_requests
          where status = 'PENDING'
          order by created_at desc
          limit 120
        `
      ),
      listSuggestionFeedbackQueue({ status: "ALL", limit: 200 })
    ]);

    const pendingApprovalsByLead = new Map<string, Array<{ id: string; createdAt: string; productTitle: string }>>();
    for (const row of pendingApprovalsQ.rows) {
      const leadId = String(row.lead_id || "").trim();
      if (!leadId) continue;
      const arr = pendingApprovalsByLead.get(leadId) || [];
      arr.push({
        id: String(row.id || ""),
        createdAt: toIsoDate(row.created_at),
        productTitle: String(row.product_title || "Quote request")
      });
      pendingApprovalsByLead.set(leadId, arr);
    }

    const leadById = new Map(leads.map((lead) => [lead.id, lead]));

    const leadItems = leads.map((lead) => {
      const messages = recentMessagesByLead.get(lead.id) || [];
      const lastMessage = messages.length ? messages[messages.length - 1] : null;
      const destination = [lead.shipCity, lead.shipRegion, lead.shipCountry]
        .map((value) => String(value || "").trim())
        .filter(Boolean)
        .join(", ");
      const estimatedValue = Number(lead.ticketValue || lead.conversionValue || 0);
      const priorityScore = Math.max(1, Math.min(100, Math.round(Number(lead.score || 0))));
      const missingFields: string[] = [];
      if (!lead.eventDate) missingFields.push("Event date");
      if (!destination && !lead.shipDestinationText) missingFields.push("Destination");
      if (!lead.productReference) missingFields.push("Product reference");
      const openTasks = (pendingApprovalsByLead.get(lead.id) || []).slice(0, 2).map((approval) => ({
        id: approval.id,
        title: `Approve quote: ${approval.productTitle}`,
        due: approval.createdAt.slice(0, 10),
        done: false
      }));

      return {
        id: lead.id,
        name: lead.clientName || "Unknown lead",
        country: String(lead.country || "MA"),
        language: mapLanguage(lead.country),
        currentStage: String(lead.stage || "NEW"),
        priorityScore,
        estimatedValue,
        eventDate: toIsoDate(lead.eventDate),
        destination: destination || String(lead.shipDestinationText || "Not set"),
        lastMessage: String(lastMessage?.text || ""),
        assignedOperator: "Mobile-Lab Operator",
        nextBestAction: mapNextBestAction(lead.stage),
        approvalStatus: pendingApprovalsByLead.has(lead.id) ? "pending" : "none",
        paymentIntent: lead.depositIntent || lead.paymentIntent ? "high" : lead.hasPaymentQuestion ? "medium" : "low",
        waitingReply: Boolean(lastMessage && lastMessage.direction === "OUT"),
        highValue: estimatedValue >= 18000,
        qualificationStatus: missingFields.length === 0 ? "complete" : missingFields.length <= 1 ? "partial" : "missing",
        paymentStatus: mapPaymentStatus(lead.stage, lead.paymentReceived, lead.depositPaid),
        detectedSignals: Array.isArray(lead.detectedSignals?.tags) ? lead.detectedSignals.tags.slice(0, 8) : [],
        missingFields,
        openTasks
      };
    });

    const conversations = Array.from(recentMessagesByLead.entries())
      .flatMap(([leadId, messages]) =>
        messages.map((message) => ({
          id: message.id,
          leadId,
          actor: message.direction === "IN" ? "client" : "operator",
          text: String(message.text || ""),
          timestamp: toIsoDate(message.createdAt),
          state: message.direction === "IN" ? "read" : "sent"
        }))
      )
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

    const runs = runsQ.rows.map((row) => {
      const lead = leadById.get(String(row.lead_id || ""));
      const model = String(row.model || "unknown");
      const mappedStatus = mapRunStatus(row.status);
      const runtimeMs = Math.max(0, Math.round(Number(row.latency_ms || 0)));
      const priority = mapPriority(Math.round(Number(lead?.score || 0)));
      const timelineBase = toIsoDate(row.created_at);
      return {
        id: String(row.id || ""),
        timestamp: timelineBase,
        eventType: String(row.trigger_source || "message_persisted"),
        leadId: String(row.lead_id || ""),
        conversationId: String(row.lead_id || ""),
        triggeredAgentId: model.includes("gpt")
          ? "agent-reply-generator"
          : model.includes("claude")
            ? "agent-strategic-advisor"
            : "agent-stage-detection",
        decisionSummary: row.error_text
          ? `Run failed: ${String(row.error_text)}`
          : `Model ${model} processed latest lead state.`,
        status: mappedStatus,
        durationMs: runtimeMs,
        nextStep: mappedStatus === "success" ? "continue_pipeline" : mappedStatus === "error" ? "needs_manual_review" : "await_completion",
        priority,
        trace: {
          eventContext: `Lead ${String(row.lead_id || "")} · source ${String(row.trigger_source || "message_persisted")}`,
          inputSnapshot: [
            `lead_id=${String(row.lead_id || "")}`,
            `message_id=${String(row.message_id || "")}`,
            `model=${model}`
          ],
          decisionSummary: row.error_text
            ? `Execution failed with error: ${String(row.error_text)}`
            : `Execution completed successfully with ${model}.`,
          agentsInvoked: ["Stage Detection", "Strategic Advisor", "Reply Generator", "Brand Guardian"],
          output: row.error_text
            ? `error: ${String(row.error_text)}`
            : `status=${mappedStatus}; next=continue_pipeline`,
          timeline: [
            {
              id: `${String(row.id || "")}-started`,
              time: timelineBase,
              title: "Run started",
              detail: "Inbound event accepted for orchestration.",
              status: "success"
            },
            {
              id: `${String(row.id || "")}-completed`,
              time: timelineBase,
              title: mappedStatus === "error" ? "Run failed" : "Run completed",
              detail: row.error_text ? String(row.error_text) : `Model ${model} returned output.`,
              status: mappedStatus
            }
          ]
        }
      };
    });

    const approvals = pendingApprovalsQ.rows.map((row) => ({
      id: String(row.id || ""),
      group: "Waiting Price Approval",
      leadId: String(row.lead_id || ""),
      urgency: "high",
      reason: `Price approval pending for ${String(row.product_title || "requested item")}`,
      requestedByAgentId: "agent-quote-approvals",
      requestedAt: toIsoDate(row.created_at),
      contentPreview: `Approve quote for ${String(row.product_title || "item")}.`,
      decision: "pending"
    }));

    const learningEvents = learningQueue
      .filter((item) => String(item.final_human_text || item.final_text || "").trim().length > 0)
      .slice(0, 120)
      .map((item) => ({
        id: String(item.id || ""),
        timestamp: toIsoDate(item.updated_at),
        leadId: String(item.lead_id || ""),
        aiSuggestion: String(item.suggestion_text || ""),
        finalHumanVersion: String(item.final_human_text || item.final_text || ""),
        deltaSummary: String(item.accepted === true ? "Suggestion accepted" : "Suggestion edited by operator"),
        correctionPattern: String(item.suggestion_status || "REVIEWED")
      }));

    const activityFeed = [
      ...runs.slice(0, 120).map((run) => ({
        id: `run-${run.id}`,
        timestamp: run.timestamp,
        title: `Run ${run.status.toUpperCase()}`,
        detail: run.decisionSummary,
        type: run.status === "error" ? "blocked" : "orchestrator",
        leadId: run.leadId
      })),
      ...conversations.slice(-120).map((message) => ({
        id: `msg-${message.id}`,
        timestamp: message.timestamp,
        title: message.actor === "client" ? "Inbound message" : "Outbound message",
        detail: String(message.text || "").slice(0, 220),
        type: message.actor === "client" ? "inbound" : "reply",
        leadId: message.leadId
      }))
    ]
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
      .slice(0, 200);

    const strategicAnalyses = leads.map((lead) => {
      const score = Math.max(0, Math.min(100, Math.round(Number(lead.score || 0))));
      const keySignals = Array.isArray(lead.detectedSignals?.tags) ? lead.detectedSignals.tags.slice(0, 6) : [];
      const risks: string[] = [];
      if (lead.risk?.isAtRisk) risks.push("Lead at risk of momentum drop");
      if (!lead.eventDate) risks.push("Event date not confirmed");
      if (!lead.productReference) risks.push("Product reference incomplete");
      const opportunities: string[] = [];
      if (lead.depositIntent || lead.paymentIntent) opportunities.push("Payment readiness signal detected");
      if (lead.hasVideoProposed) opportunities.push("Video step can accelerate confidence");
      if (lead.hasPriceSent) opportunities.push("Price already shared, conversion window open");
      const missingInformation: string[] = [];
      if (!lead.eventDate) missingInformation.push("Event date");
      if (!lead.shipDestinationText && !lead.shipCity) missingInformation.push("Delivery destination");
      if (!lead.productReference) missingInformation.push("Product target");
      return {
        leadId: lead.id,
        probableStage: String(lead.stage || "NEW"),
        stageConfidence: Math.max(0.45, Math.min(0.99, score / 100)),
        momentum: mapMomentum(score),
        priorityRecommendation: score >= 85 ? "high" : score >= 65 ? "medium" : "low",
        keySignals,
        risks,
        opportunities,
        missingInformation,
        nextBestAction: mapStrategicAction(lead.stage),
        replyObjective: mapNextBestAction(lead.stage),
        rationale: `Lead stage is ${String(lead.stage || "NEW")}, so the system prioritizes commercial progression with controlled risk.`,
        humanApprovalRequired: pendingApprovalsByLead.has(lead.id)
      };
    });

    const suggestionRows = learningQueue
      .filter((row) => String(row.suggestion_text || "").trim().length > 0)
      .sort((a, b) => Date.parse(toIsoDate(b.created_at)) - Date.parse(toIsoDate(a.created_at)));
    const suggestedRepliesByLead = new Map<string, Array<{
      id: string;
      leadId: string;
      label: string;
      intent: string;
      tone: string;
      language: string;
      content: string;
      reason_short?: string;
    }>>();
    for (const row of suggestionRows) {
      const leadId = String(row.lead_id || "").trim();
      if (!leadId) continue;
      const current = suggestedRepliesByLead.get(leadId) || [];
      if (current.length >= 3) continue;
      current.push({
        id: String(row.id || ""),
        leadId,
        label: `Option ${current.length + 1}`,
        intent: String(row.suggestion_type || row.source || "follow_up"),
        tone: "premium",
        language: mapLanguage(leadById.get(leadId)?.country || "MA"),
        content: String(row.suggestion_text || ""),
        reason_short: String(row.outcome_status || row.suggestion_status || "").trim() || undefined
      });
      suggestedRepliesByLead.set(leadId, current);
    }

    const suggestedReplies = leadItems.flatMap((lead) => {
      const existing = suggestedRepliesByLead.get(lead.id) || [];
      if (existing.length) return existing;
      return [
        {
          id: `fallback-${lead.id}`,
          leadId: lead.id,
          label: "Option 1",
          intent: "follow_up",
          tone: "premium",
          language: lead.language,
          content: `Merci ${lead.name.split(" ")[0] || ""}, ${mapNextBestAction(lead.currentStage).toLowerCase()}.`,
          reason_short: "Built from current stage and lead momentum."
        }
      ];
    });

    const nowIso = new Date().toISOString();
    const baseAgents = [
      { id: "agent-stage-detection", name: "Stage Detection", role: "Lifecycle inference", dependencies: ["whatsapp_lead_messages"] },
      { id: "agent-strategic-advisor", name: "Strategic Advisor", role: "Commercial strategy", dependencies: ["stage_detection"] },
      { id: "agent-reply-generator", name: "Reply Generator", role: "Response synthesis", dependencies: ["strategic_advisor"] },
      { id: "agent-brand-guardian", name: "Brand Guardian", role: "Tone and compliance guard", dependencies: ["reply_generator"] },
      { id: "agent-quote-approvals", name: "Quote Approvals", role: "Human approval queue", dependencies: ["quote_requests"] }
    ];
    const runsByAgent = new Map<string, typeof runsQ.rows>();
    for (const run of runsQ.rows) {
      const model = String(run.model || "").toLowerCase();
      const key = model.includes("gpt")
        ? "agent-reply-generator"
        : model.includes("claude")
          ? "agent-strategic-advisor"
          : "agent-stage-detection";
      const arr = runsByAgent.get(key) || [];
      arr.push(run);
      runsByAgent.set(key, arr);
    }
    const quoteApprovalRuns = pendingApprovalsQ.rows.map((row) => ({
      id: row.id,
      lead_id: row.lead_id,
      message_id: row.id,
      status: "pending",
      trigger_source: "quote_request",
      model: "policy",
      latency_ms: 0,
      error_text: null,
      created_at: row.created_at
    }));
    runsByAgent.set("agent-quote-approvals", quoteApprovalRuns);
    const agents = baseAgents.map((base) => {
      const agentRuns = runsByAgent.get(base.id) || [];
      const totalRuns = agentRuns.length;
      const successRuns = agentRuns.filter((run) => String(run.status || "").toLowerCase() === "success").length;
      const errors = agentRuns.filter((run) => String(run.status || "").toLowerCase() === "error");
      const avgRuntimeSec =
        totalRuns > 0
          ? Math.round(
              agentRuns.reduce((acc, run) => acc + Math.max(0, Number(run.latency_ms || 0)), 0) /
                totalRuns /
                1000
            )
          : 0;
      const lastRunAt = agentRuns[0]?.created_at ? toIsoDate(agentRuns[0].created_at) : nowIso;
      const status = errors.length > 0 ? "degraded" : totalRuns === 0 ? "idle" : "running";
      return {
        id: base.id,
        name: base.name,
        role: base.role,
        version: "v1",
        status,
        autonomyLevel: base.id === "agent-quote-approvals" ? "manual_guarded" : "semi_autonomous",
        lastRun: lastRunAt,
        totalRuns,
        successRate: totalRuns > 0 ? Math.round((successRuns / totalRuns) * 1000) / 10 : 0,
        avgRuntimeSec,
        primaryTriggers: ["whatsapp_inbound", "orchestrator_state_change"],
        mission: `${base.name} executes its stage in the Mobile-Lab pipeline.`,
        triggers: ["message_persisted", "manual_recompute", "operator_action"],
        expectedInputs: ["lead_state", "latest_message", "stage_context"],
        expectedOutputs: ["decision", "structured_payload"],
        dependencies: base.dependencies,
        recentRuns: agentRuns.slice(0, 5).map((run) => ({
          id: String(run.id || ""),
          timestamp: toIsoDate(run.created_at),
          summary: String(run.error_text || `Processed ${String(run.lead_id || "").slice(0, 8)}...`),
          status: String(run.status || "").toLowerCase() === "error" ? "error" : "success",
          durationSec: Math.round(Math.max(0, Number(run.latency_ms || 0)) / 1000)
        })),
        recentIssues: errors.slice(0, 5).map((run) => ({
          id: String(run.id || ""),
          timestamp: toIsoDate(run.created_at),
          type: "error",
          message: String(run.error_text || "Unknown error")
        }))
      };
    });

    return res.status(200).json({
      agents,
      leads: leadItems,
      runs,
      approvals,
      learningEvents,
      suggestedReplies,
      strategicAnalyses,
      conversations,
      activityFeed
    });
  } catch (error) {
    console.error("[agent-control-center-v1] live data build failed", { error });
    return res.status(503).json({ error: "agent_control_center_data_unavailable" });
  }
});

agentControlCenterV1Router.get("/agent-control-center-v1/strategicAdvisorAgentV1.js", (req, res, next) => {
  const assetsDir = resolveAssetsDir();
  if (assetsDir && existsSync(join(assetsDir, "strategicAdvisorAgentV1.js"))) {
    next();
    return;
  }

  const fallbackModule = `const defaultOutput = {
  leadId: "",
  probableStage: "PRODUCT_INTEREST",
  stageConfidence: 0.62,
  momentum: "medium",
  priorityRecommendation: "medium",
  keySignals: ["Limited context available"],
  risks: ["Strategic advisor module fallback in use"],
  opportunities: ["Continue with controlled next-step guidance"],
  missingInformation: [],
  nextBestAction: "reassure_and_progress",
  replyObjective: "Keep response concise while gathering missing context.",
  rationale: "Fallback strategic module served because deployment assets are out of sync.",
  humanApprovalRequired: false
};

export function generateStrategicAdvisorAnalysis(context) {
  const leadId = context?.lead?.id ?? "";
  const currentStage = context?.currentStage ?? context?.lead?.currentStage ?? "PRODUCT_INTEREST";
  const mappedStage = typeof currentStage === "string" ? currentStage : "PRODUCT_INTEREST";
  return { ...defaultOutput, leadId, probableStage: mappedStage };
}

export function generateStrategicAdvisorAnalysisRecord(context) {
  const output = generateStrategicAdvisorAnalysis(context);
  return {
    schemaVersion: "strategic_advisor_v1",
    leadId: output.leadId,
    conversationId: context?.conversation?.id ?? "",
    timestamp: new Date().toISOString(),
    provider: "fallback_strategic_advisor_v1",
    model: "fallback-rule",
    decisionSummary: "Fallback strategic advisor output",
    inputSnapshot: {
      currentStage: output.probableStage,
      priorityScore: Number(context?.priorityScore ?? 0),
      signalCount: Array.isArray(context?.signals) ? context.signals.length : 0,
      missingFields: Array.isArray(context?.missingFields) ? context.missingFields : [],
      openTaskCount: Array.isArray(context?.openTasks) ? context.openTasks.length : 0,
      lastOperatorAction: context?.lastOperatorAction ?? null,
      recentMessageCount: Array.isArray(context?.recentMessages) ? context.recentMessages.length : 0
    },
    output,
    confidenceIndicators: {
      stageConfidence: output.stageConfidence,
      actionConfidence: 0.58
    }
  };
}
`;

  res.status(200).type("application/javascript").send(fallbackModule);
});

agentControlCenterV1Router.use("/agent-control-center-v1", (req, res, next) => {
  const assetsDirs = resolveAssetsDirs();
  if (!assetsDirs.length) {
    next();
    return;
  }

  const staticOptions = {
    index: false,
    maxAge: "1h",
    etag: true
  };

  let currentIndex = 0;
  const serveFromNextDir = (): void => {
    if (currentIndex >= assetsDirs.length) {
      next();
      return;
    }

    const staticMiddleware = express.static(assetsDirs[currentIndex], staticOptions);
    currentIndex += 1;
    staticMiddleware(req, res, (error) => {
      if (error) {
        next(error);
        return;
      }
      serveFromNextDir();
    });
  };

  serveFromNextDir();
});

function renderAgentControlCenterShell(): string {
  const assetsDir = resolveAssetsDir();
  const assetsLoaded = Boolean(assetsDir);
  const assetsHasBundle = Boolean(assetsDir && existsSync(join(assetsDir, "bundle.js")));

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Mobile-Lab Agent Control Center V1</title>
    <meta name="description" content="Mission control interface for AI-powered WhatsApp sales operations." />

    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet" />

    <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>

    <style type="text/tailwindcss">
      @theme {
        --font-display: "Sora", ui-sans-serif, system-ui, sans-serif;
        --font-mono-display: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      @layer base {
        html, body, #root {
          min-height: 100%;
        }
        body {
          margin: 0;
          font-family: var(--font-display);
          background: #06080d;
          color: #f1f5f9;
          letter-spacing: 0.01em;
          -webkit-font-smoothing: antialiased;
          text-rendering: optimizeLegibility;
        }
        * {
          box-sizing: border-box;
        }
      }
    </style>

    <style>
      :root {
        --ml-bg: #06080d;
        --ml-surface: #0c1119;
        --ml-surface-2: #0f1520;
        --ml-surface-3: #121a27;
        --ml-border: rgba(148, 163, 184, 0.18);
        --ml-border-strong: rgba(148, 163, 184, 0.28);
        --ml-text: #f3f6fb;
        --ml-muted: #9aa5b7;
        --ml-soft: #6b778a;
        --ml-accent: #5dd9ff;
      }

      body::before {
        content: "";
        position: fixed;
        inset: 0;
        pointer-events: none;
        z-index: -1;
        background:
          radial-gradient(circle at 14% 18%, rgba(71, 132, 255, 0.14), transparent 34%),
          radial-gradient(circle at 86% 2%, rgba(46, 200, 167, 0.10), transparent 28%),
          linear-gradient(180deg, #05070b 0%, #070b12 46%, #070a10 100%);
      }

      body::after {
        content: "";
        position: fixed;
        inset: 0;
        pointer-events: none;
        z-index: -1;
        opacity: 0.24;
        background-image: linear-gradient(rgba(255, 255, 255, 0.018) 1px, transparent 1px);
        background-size: 100% 26px;
      }

      .ml-panel {
        position: relative;
        border: 1px solid var(--ml-border);
        background: linear-gradient(180deg, rgba(18, 24, 35, 0.95) 0%, rgba(12, 17, 26, 0.95) 100%);
        box-shadow:
          0 18px 42px -28px rgba(0, 0, 0, 0.88),
          inset 0 1px 0 rgba(255, 255, 255, 0.035);
      }

      .ml-panel-soft {
        border: 1px solid rgba(148, 163, 184, 0.14);
        background: linear-gradient(180deg, rgba(15, 22, 33, 0.85) 0%, rgba(10, 15, 24, 0.9) 100%);
      }

      .ml-interactive {
        transition: transform 180ms ease, border-color 180ms ease, box-shadow 180ms ease, background 180ms ease;
      }

      .ml-interactive:hover {
        border-color: var(--ml-border-strong);
        transform: translateY(-1px);
        box-shadow:
          0 24px 46px -30px rgba(0, 0, 0, 0.95),
          inset 0 1px 0 rgba(255, 255, 255, 0.05);
      }

      .ml-chip {
        border: 1px solid rgba(148, 163, 184, 0.24);
        background: linear-gradient(180deg, rgba(18, 25, 37, 0.9) 0%, rgba(13, 18, 28, 0.9) 100%);
      }

      .ml-button {
        border: 1px solid rgba(148, 163, 184, 0.25);
        background: linear-gradient(180deg, rgba(26, 34, 49, 0.95) 0%, rgba(18, 24, 35, 0.95) 100%);
        color: #d9e3f0;
        transition: border-color 160ms ease, background 160ms ease, transform 160ms ease, color 160ms ease;
      }

      .ml-button:hover {
        border-color: rgba(148, 163, 184, 0.4);
        transform: translateY(-1px);
      }

      .ml-button:focus-visible {
        outline: none;
        box-shadow: 0 0 0 2px rgba(93, 217, 255, 0.34);
      }

      .ml-button-primary {
        border-color: rgba(93, 217, 255, 0.36);
        background: linear-gradient(180deg, rgba(22, 68, 86, 0.42) 0%, rgba(12, 38, 51, 0.5) 100%);
        color: #d7f3ff;
      }

      .ml-button-primary:hover {
        border-color: rgba(93, 217, 255, 0.54);
        background: linear-gradient(180deg, rgba(28, 84, 105, 0.48) 0%, rgba(14, 47, 63, 0.56) 100%);
      }

      .ml-button-danger {
        border-color: rgba(251, 113, 133, 0.34);
        background: linear-gradient(180deg, rgba(91, 28, 43, 0.38) 0%, rgba(63, 20, 33, 0.46) 100%);
        color: #ffd3dc;
      }

      .ml-table-shell {
        border: 1px solid rgba(148, 163, 184, 0.18);
        background: linear-gradient(180deg, rgba(16, 22, 33, 0.9) 0%, rgba(10, 15, 24, 0.92) 100%);
      }

      .ml-table thead {
        background: linear-gradient(180deg, rgba(16, 23, 34, 1) 0%, rgba(13, 18, 28, 1) 100%);
      }

      .ml-table th {
        color: #8e9aaf;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.11em;
        font-weight: 600;
      }

      .ml-table td {
        color: #ced6e2;
      }

      .ml-table tbody tr {
        border-top: 1px solid rgba(148, 163, 184, 0.12);
      }

      .ml-table tbody tr:nth-child(2n) {
        background: rgba(11, 17, 26, 0.28);
      }

      .ml-table tbody tr:hover {
        background: rgba(29, 42, 60, 0.46);
      }

      .scroll-dark {
        scrollbar-width: thin;
        scrollbar-color: #334155 #111827;
      }
      .scroll-dark::-webkit-scrollbar {
        width: 8px;
      }
      .scroll-dark::-webkit-scrollbar-track {
        background: #0e1420;
      }
      .scroll-dark::-webkit-scrollbar-thumb {
        background: #334155;
        border-radius: 99px;
      }

      .ml-code {
        font-family: var(--font-mono-display);
      }
    </style>
  </head>

  <body>
    <div id="root">${
      assetsLoaded
        ? `<div id="acc-boot-fallback" style="padding:24px;font-family:Sora,system-ui,sans-serif;color:#e4e4e7;background:#07090f;min-height:100vh;">
             <div style="max-width:840px;margin:0 auto;">
               <p style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#67e8f9;margin:0 0 8px 0;">Mobile-Lab</p>
               <h1 style="font-size:22px;line-height:1.3;margin:0 0 8px 0;">Agent Control Center Booting…</h1>
               <p id="acc-boot-fallback-message" style="margin:0;color:#9ca3af;font-size:14px;">
                 Initializing frontend modules. If this message stays visible, a runtime bootstrap error occurred.
               </p>
             </div>
           </div>`
        : `<div style="padding:24px;font-family:Sora,system-ui,sans-serif;color:#e4e4e7;background:#07090f;min-height:100vh;">
             Agent Control Center assets are missing. Build frontend/mobile-lab-agent-control-center-v1 before loading this route.
           </div>`
    }</div>

    <script>
      (function () {
        var fallback = document.getElementById("acc-boot-fallback");
        var fallbackMessage = document.getElementById("acc-boot-fallback-message");
        function showError(message) {
          if (!fallback || !fallbackMessage) return;
          fallback.style.display = "block";
          fallbackMessage.textContent = message;
          fallbackMessage.style.color = "#fecaca";
        }
        window.addEventListener("error", function (event) {
          var reason = event && event.message ? event.message : "Unknown runtime error";
          showError("Frontend failed to start: " + reason);
        });
        window.addEventListener("unhandledrejection", function (event) {
          var reason = event && event.reason ? String(event.reason) : "Unknown promise rejection";
          showError("Frontend failed to start: " + reason);
        });
        setTimeout(function () {
          if (window.__ACC_BOOTED__) {
            if (fallback) fallback.style.display = "none";
            return;
          }
          var message = window.__ACC_BOOT_ERROR__
            ? "Frontend failed to start: " + window.__ACC_BOOT_ERROR__
            : "Frontend did not finish booting. Open browser console and check failed module/script requests.";
          showError(message);
        }, 3500);
      })();
    </script>

    ${
      assetsLoaded && !assetsHasBundle
        ? `<script type="importmap">
      {
        "imports": {
          "react": "https://esm.sh/react@19.2.4",
          "react/jsx-runtime": "https://esm.sh/react@19.2.4/jsx-runtime",
          "react-dom/client": "https://esm.sh/react-dom@19.2.4/client",
          "framer-motion": "https://esm.sh/framer-motion@12.34.3?bundle"
        }
      }
    </script>`
        : ""
    }

    ${
      assetsLoaded
        ? `<script type="module" src="/agent-control-center-v1/${assetsHasBundle ? "bundle.js" : "main.js"}"></script>`
        : ""
    }
  </body>
</html>`;
}

function isStaticAssetPath(pathname: string): boolean {
  return /\.[a-z0-9]+$/i.test(pathname);
}

agentControlCenterV1Router.get(["/agent-control-center-v1", "/agent-control-center-v1/*"], (req, res, next) => {
  if (isStaticAssetPath(req.path)) {
    next();
    return;
  }

  const html = renderAgentControlCenterShell();

  res.status(200).type("html").send(html);
});
