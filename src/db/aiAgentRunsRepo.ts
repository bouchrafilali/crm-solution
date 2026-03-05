import { getDbPool } from "./client.js";

export type AiAgentRunStatus = "queued" | "success" | "error";

export type AiAgentRunRecord = {
  id: string;
  leadId: string;
  messageId: string;
  status: AiAgentRunStatus;
  triggerSource: string | null;
  model: string | null;
  latencyMs: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  promptText: string;
  responseJson: Record<string, unknown> | null;
  errorText: string | null;
  createdAt: string;
};

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function mapRow(row: {
  id: string;
  lead_id: string;
  message_id: string;
  status: string;
  trigger_source: string | null;
  model: string | null;
  latency_ms: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  prompt_text: string;
  response_json: unknown;
  error_text: string | null;
  created_at: string;
}): AiAgentRunRecord {
  return {
    id: row.id,
    leadId: row.lead_id,
    messageId: row.message_id,
    status: String(row.status || "queued").toLowerCase() as AiAgentRunStatus,
    triggerSource: row.trigger_source ? String(row.trigger_source) : null,
    model: row.model ? String(row.model) : null,
    latencyMs: row.latency_ms == null ? null : Number(row.latency_ms),
    tokensIn: row.tokens_in == null ? null : Number(row.tokens_in),
    tokensOut: row.tokens_out == null ? null : Number(row.tokens_out),
    promptText: String(row.prompt_text || ""),
    responseJson: toRecord(row.response_json),
    errorText: row.error_text ? String(row.error_text) : null,
    createdAt: String(row.created_at)
  };
}

export async function createAiAgentRun(input: {
  leadId: string;
  messageId: string;
  status: AiAgentRunStatus;
  triggerSource?: string | null;
  model?: string | null;
  promptText: string;
}): Promise<AiAgentRunRecord> {
  const db = getDbPool();
  if (!db) throw new Error("DATABASE_URL is not configured");
  const q = await db.query<{
    id: string;
    lead_id: string;
    message_id: string;
    status: string;
    trigger_source: string | null;
    model: string | null;
    latency_ms: number | null;
    tokens_in: number | null;
    tokens_out: number | null;
    prompt_text: string;
    response_json: unknown;
    error_text: string | null;
    created_at: string;
  }>(
    `
      insert into ai_agent_runs (
        lead_id, message_id, status, trigger_source, model, prompt_text
      )
      values (
        $1::uuid, $2::uuid, $3::text, nullif(trim($4::text), ''), nullif(trim($5::text), ''), $6::text
      )
      returning *
    `,
    [input.leadId, input.messageId, input.status, input.triggerSource || null, input.model || null, input.promptText]
  );
  return mapRow(q.rows[0]);
}

export async function updateAiAgentRun(input: {
  id: string;
  status: AiAgentRunStatus;
  model?: string | null;
  latencyMs?: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  responseJson?: Record<string, unknown> | null;
  errorText?: string | null;
}): Promise<void> {
  const db = getDbPool();
  if (!db) throw new Error("DATABASE_URL is not configured");
  await db.query(
    `
      update ai_agent_runs
      set
        status = $2::text,
        model = coalesce(nullif(trim($3::text), ''), model),
        latency_ms = $4::int,
        tokens_in = $5::int,
        tokens_out = $6::int,
        response_json = $7::jsonb,
        error_text = $8::text
      where id = $1::uuid
    `,
    [
      input.id,
      input.status,
      input.model || null,
      input.latencyMs == null ? null : Math.max(0, Math.round(input.latencyMs)),
      input.tokensIn == null ? null : Math.max(0, Math.round(input.tokensIn)),
      input.tokensOut == null ? null : Math.max(0, Math.round(input.tokensOut)),
      input.responseJson == null ? null : JSON.stringify(input.responseJson),
      input.errorText == null ? null : String(input.errorText)
    ]
  );
}

export async function listAiAgentRunsByLead(leadId: string, limit = 20): Promise<AiAgentRunRecord[]> {
  const db = getDbPool();
  if (!db) throw new Error("DATABASE_URL is not configured");
  const safeLimit = Math.max(1, Math.min(100, Math.round(limit || 20)));
  const q = await db.query<{
    id: string;
    lead_id: string;
    message_id: string;
    status: string;
    trigger_source: string | null;
    model: string | null;
    latency_ms: number | null;
    tokens_in: number | null;
    tokens_out: number | null;
    prompt_text: string;
    response_json: unknown;
    error_text: string | null;
    created_at: string;
  }>(
    `
      select *
      from ai_agent_runs
      where lead_id = $1::uuid
      order by created_at desc
      limit $2::int
    `,
    [leadId, safeLimit]
  );
  return q.rows.map(mapRow);
}

export async function getLatestSuccessfulAiAgentRunByLead(leadId: string): Promise<AiAgentRunRecord | null> {
  const db = getDbPool();
  if (!db) throw new Error("DATABASE_URL is not configured");
  const q = await db.query<{
    id: string;
    lead_id: string;
    message_id: string;
    status: string;
    trigger_source: string | null;
    model: string | null;
    latency_ms: number | null;
    tokens_in: number | null;
    tokens_out: number | null;
    prompt_text: string;
    response_json: unknown;
    error_text: string | null;
    created_at: string;
  }>(
    `
      select *
      from ai_agent_runs
      where lead_id = $1::uuid
        and status = 'success'
        and response_json is not null
      order by created_at desc
      limit 1
    `,
    [leadId]
  );
  return q.rows[0] ? mapRow(q.rows[0]) : null;
}

export async function getLatestAiAgentRunByLead(leadId: string): Promise<AiAgentRunRecord | null> {
  const db = getDbPool();
  if (!db) throw new Error("DATABASE_URL is not configured");
  const q = await db.query<{
    id: string;
    lead_id: string;
    message_id: string;
    status: string;
    trigger_source: string | null;
    model: string | null;
    latency_ms: number | null;
    tokens_in: number | null;
    tokens_out: number | null;
    prompt_text: string;
    response_json: unknown;
    error_text: string | null;
    created_at: string;
  }>(
    `
      select *
      from ai_agent_runs
      where lead_id = $1::uuid
      order by created_at desc
      limit 1
    `,
    [leadId]
  );
  return q.rows[0] ? mapRow(q.rows[0]) : null;
}

export async function getAiAgentRunById(runId: string): Promise<AiAgentRunRecord | null> {
  const db = getDbPool();
  if (!db) throw new Error("DATABASE_URL is not configured");
  const q = await db.query<{
    id: string;
    lead_id: string;
    message_id: string;
    status: string;
    trigger_source: string | null;
    model: string | null;
    latency_ms: number | null;
    tokens_in: number | null;
    tokens_out: number | null;
    prompt_text: string;
    response_json: unknown;
    error_text: string | null;
    created_at: string;
  }>(
    `
      select *
      from ai_agent_runs
      where id = $1::uuid
      limit 1
    `,
    [runId]
  );
  return q.rows[0] ? mapRow(q.rows[0]) : null;
}
