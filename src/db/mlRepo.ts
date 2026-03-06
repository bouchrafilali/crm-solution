import { getDbPool } from "./client.js";

export type MlModel = {
  id: string;
  modelKey: string;
  name: string;
  description: string | null;
  modelType: "CLASSIFICATION" | "REGRESSION" | "CLUSTERING" | "NLP" | "FORECASTING";
  status: "ACTIVE" | "INACTIVE" | "TRAINING" | "DEPRECATED";
  version: string;
  accuracyScore: number | null;
  lastTrainedAt: string | null;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type AutomationRule = {
  id: string;
  ruleKey: string;
  name: string;
  description: string | null;
  ruleType: "STAGE_AUTO" | "RISK_ALERT" | "FOLLOW_UP" | "QUALIFICATION" | "TEMPLATE_SUGGEST";
  enabled: boolean;
  priority: number;
  conditions: Record<string, unknown>;
  actions: Record<string, unknown>;
  modelId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MlEvent = {
  id: string;
  eventType:
    | "RULE_TRIGGERED"
    | "MODEL_PREDICTION"
    | "SUGGESTIONS_GENERATED"
    | "SUGGESTION_USED"
    | "SUGGESTION_REJECTED"
    | "AUTO_STAGE_CHANGE"
    | "MESSAGE_PERSISTED"
    | "INFERENCE";
  modelKey: string | null;
  ruleId: string | null;
  leadId: string | null;
  source: "OUTBOUND_TEMPLATE" | "OUTBOUND_MANUAL" | "OUTBOUND_SUGGESTION" | "INBOUND" | "SYSTEM" | "SYSTEM_BACKFILL" | null;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type MlOverview = {
  automatedDecisions7d: number;
  riskAlerts7d: number;
  suggestionUsed7d: number;
  templateUsed7d: number;
  manualSent7d: number;
  activeModels: number;
  projectedRevenue30d: number;
  actualRevenue30d: number;
};

function getPoolOrThrow() {
  const db = getDbPool();
  if (!db) throw new Error("DATABASE_URL is not configured");
  return db;
}

function toObject(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

export async function listMlModels(): Promise<MlModel[]> {
  const db = getPoolOrThrow();
  const q = await db.query<{
    id: string;
    model_key: string;
    name: string;
    description: string | null;
    model_type: string;
    status: string;
    version: string;
    accuracy_score: string | null;
    last_trained_at: string | null;
    config: unknown;
    created_at: string;
    updated_at: string;
  }>(
    `
      select *
      from ml_models
      order by status desc, name asc
    `
  );

  return q.rows.map((row) => ({
    id: row.id,
    modelKey: row.model_key,
    name: row.name,
    description: row.description,
    modelType: row.model_type as MlModel["modelType"],
    status: row.status as MlModel["status"],
    version: row.version,
    accuracyScore: row.accuracy_score ? parseFloat(row.accuracy_score) : null,
    lastTrainedAt: row.last_trained_at,
    config: toObject(row.config),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

export async function listAutomationRules(): Promise<AutomationRule[]> {
  const db = getPoolOrThrow();
  const q = await db.query<{
    id: string;
    rule_key: string;
    name: string;
    description: string | null;
    rule_type: string;
    enabled: boolean;
    priority: number;
    conditions: unknown;
    actions: unknown;
    model_id: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `
      select *
      from automation_rules
      order by priority desc, name asc
    `
  );

  return q.rows.map((row) => ({
    id: row.id,
    ruleKey: row.rule_key,
    name: row.name,
    description: row.description,
    ruleType: row.rule_type as AutomationRule["ruleType"],
    enabled: row.enabled,
    priority: row.priority,
    conditions: toObject(row.conditions),
    actions: toObject(row.actions),
    modelId: row.model_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

export async function updateAutomationRuleEnabled(id: string, enabled: boolean): Promise<AutomationRule | null> {
  const db = getPoolOrThrow();
  const q = await db.query<{
    id: string;
    rule_key: string;
    name: string;
    description: string | null;
    rule_type: string;
    enabled: boolean;
    priority: number;
    conditions: unknown;
    actions: unknown;
    model_id: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `
      update automation_rules
      set enabled = $2, updated_at = now()
      where id = $1::uuid
      returning *
    `,
    [id, enabled]
  );

  const row = q.rows[0];
  if (!row) return null;

  return {
    id: row.id,
    ruleKey: row.rule_key,
    name: row.name,
    description: row.description,
    ruleType: row.rule_type as AutomationRule["ruleType"],
    enabled: row.enabled,
    priority: row.priority,
    conditions: toObject(row.conditions),
    actions: toObject(row.actions),
    modelId: row.model_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function getMlOverview(): Promise<MlOverview> {
  const db = getPoolOrThrow();
  
  const q = await db.query<{
    automated_decisions_7d: string;
    risk_alerts_7d: string;
    suggestion_used_7d: string;
    template_used_7d: string;
    manual_sent_7d: string;
    active_models: string;
    projected_revenue_30d: string;
    actual_revenue_30d: string;
  }>(
    `
      select
        (
          select count(*)
          from ml_events
          where event_type = 'RULE_TRIGGERED'
            and created_at >= now() - interval '7 days'
        ) as automated_decisions_7d,
        (
          select count(*)
          from ml_events
          where event_type = 'RULE_TRIGGERED'
            and created_at >= now() - interval '7 days'
            and (
              payload->>'category' = 'RISK_ALERT'
              or model_key like '%risk%'
            )
        ) as risk_alerts_7d,
        (
          select count(*)
          from ml_events
          where event_type = 'SUGGESTION_USED'
            and created_at >= now() - interval '7 days'
        ) as suggestion_used_7d,
        (
          select count(*)
          from ml_events
          where event_type = 'MESSAGE_PERSISTED'
            and source = 'OUTBOUND_TEMPLATE'
            and created_at >= now() - interval '7 days'
        ) as template_used_7d,
        (
          select count(*)
          from ml_events
          where event_type = 'MESSAGE_PERSISTED'
            and source = 'OUTBOUND_MANUAL'
            and created_at >= now() - interval '7 days'
        ) as manual_sent_7d,
        (
          select count(*)
          from ml_models
          where status = 'ACTIVE'
        ) as active_models,
        (
          select coalesce(sum((coalesce(conversion_score, 0)::numeric / 100.0) * coalesce(conversion_value, 0)::numeric), 0)
          from whatsapp_leads
          where stage not in ('CONVERTED', 'LOST')
            and coalesce(conversion_value, 0) > 0
        ) as projected_revenue_30d,
        (
          select coalesce(sum(coalesce(conversion_value, 0)::numeric), 0)
          from whatsapp_leads
          where stage = 'CONVERTED'
            and coalesce(converted_at, created_at) >= now() - interval '30 days'
        ) as actual_revenue_30d
    `
  );

  const row = q.rows[0];
  return {
    automatedDecisions7d: parseInt(row.automated_decisions_7d, 10) || 0,
    riskAlerts7d: parseInt(row.risk_alerts_7d, 10) || 0,
    suggestionUsed7d: parseInt(row.suggestion_used_7d, 10) || 0,
    templateUsed7d: parseInt(row.template_used_7d, 10) || 0,
    manualSent7d: parseInt(row.manual_sent_7d, 10) || 0,
    activeModels: parseInt(row.active_models, 10) || 0,
    projectedRevenue30d: Number(row.projected_revenue_30d || 0),
    actualRevenue30d: Number(row.actual_revenue_30d || 0)
  };
}

export async function createMlEvent(input: {
  eventType: MlEvent["eventType"];
  modelKey?: string | null;
  ruleId?: string | null;
  leadId?: string | null;
  source?: MlEvent["source"];
  payload?: Record<string, unknown>;
}): Promise<MlEvent> {
  const db = getPoolOrThrow();
  const q = await db.query<{
    id: string;
    event_type: string;
    model_key: string | null;
    rule_id: string | null;
    lead_id: string | null;
    source: string | null;
    payload: unknown;
    created_at: string;
  }>(
    `
      insert into ml_events (event_type, model_key, rule_id, lead_id, source, payload)
      values ($1, $2, $3::uuid, $4::uuid, $5, $6::jsonb)
      returning *
    `,
    [
      input.eventType,
      input.modelKey || null,
      input.ruleId || null,
      input.leadId || null,
      input.source || null,
      JSON.stringify(input.payload || {})
    ]
  );

  const row = q.rows[0];
  return {
    id: row.id,
    eventType: row.event_type as MlEvent["eventType"],
    modelKey: row.model_key,
    ruleId: row.rule_id,
    leadId: row.lead_id,
    source: row.source as MlEvent["source"],
    payload: toObject(row.payload),
    createdAt: row.created_at
  };
}

export async function hasMlInferenceEventForMessage(input: {
  leadId: string;
  messageId: string;
  modelKey: string;
}): Promise<boolean> {
  const db = getPoolOrThrow();
  const q = await db.query<{ ok: number }>(
    `
      select 1 as ok
      from ml_events
      where event_type = 'INFERENCE'
        and lead_id = $1::uuid
        and model_key = $2::text
        and payload->>'message_id' = $3::text
      order by created_at desc
      limit 1
    `,
    [input.leadId, String(input.modelKey || "").trim(), String(input.messageId || "").trim()]
  );
  return Boolean(q.rows[0]?.ok);
}

export async function getLatestMlInferenceEventByLead(input: {
  leadId: string;
  modelKey: string;
}): Promise<MlEvent | null> {
  const db = getPoolOrThrow();
  const q = await db.query<{
    id: string;
    event_type: string;
    model_key: string | null;
    rule_id: string | null;
    lead_id: string | null;
    source: string | null;
    payload: unknown;
    created_at: string;
  }>(
    `
      select id, event_type, model_key, rule_id, lead_id, source, payload, created_at
      from ml_events
      where event_type = 'INFERENCE'
        and lead_id = $1::uuid
        and model_key = $2::text
      order by created_at desc
      limit 1
    `,
    [input.leadId, String(input.modelKey || "").trim()]
  );
  const row = q.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    eventType: row.event_type as MlEvent["eventType"],
    modelKey: row.model_key,
    ruleId: row.rule_id,
    leadId: row.lead_id,
    source: row.source as MlEvent["source"],
    payload: toObject(row.payload),
    createdAt: row.created_at
  };
}
