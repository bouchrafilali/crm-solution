import { getDbPool } from "./client.js";

export type WhatsAppAgentRunStatus = "running" | "completed" | "failed" | "partial";
export type WhatsAppAgentRunStepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export type WhatsAppAgentRunRecord = {
  id: string;
  leadId: string;
  messageId: string;
  status: WhatsAppAgentRunStatus;
  startedAt: string;
  finishedAt: string | null;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  totalEstimatedCostUsd: number | null;
  createdAt: string;
};

export type WhatsAppAgentRunStepRecord = {
  id: string;
  runId: string;
  stepName: string;
  stepOrder: number;
  status: WhatsAppAgentRunStepStatus;
  provider: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  unitInputPricePerMillion: number | null;
  unitOutputPricePerMillion: number | null;
  estimatedCostUsd: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  outputJson: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
};

export type WhatsAppAgentLeadStateRecord = {
  leadId: string;
  latestRunId: string | null;
  latestMessageId: string | null;
  stageAnalysis: Record<string, unknown> | null;
  facts: Record<string, unknown> | null;
  structuredState?: Record<string, unknown> | null;
  priorityItem: Record<string, unknown> | null;
  strategy: Record<string, unknown> | null;
  replyOptions: Record<string, unknown> | null;
  brandReview: Record<string, unknown> | null;
  topReplyCard: Record<string, unknown> | null;
  providers: Record<string, unknown> | null;
  reasoningSource?: string | null;
  createdAt: string;
  updatedAt: string;
};

function getPoolOrThrow() {
  const db = getDbPool();
  if (!db) throw new Error("DATABASE_URL is not configured");
  return db;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function mapRunRow(row: {
  id: string;
  lead_id: string;
  message_id: string;
  status: WhatsAppAgentRunStatus;
  started_at: string;
  finished_at: string | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  total_estimated_cost_usd: string | number | null;
  created_at: string;
}): WhatsAppAgentRunRecord {
  return {
    id: row.id,
    leadId: row.lead_id,
    messageId: row.message_id,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    totalInputTokens: row.total_input_tokens == null ? null : Number(row.total_input_tokens),
    totalOutputTokens: row.total_output_tokens == null ? null : Number(row.total_output_tokens),
    totalEstimatedCostUsd: row.total_estimated_cost_usd == null ? null : Number(row.total_estimated_cost_usd),
    createdAt: row.created_at
  };
}

function mapStepRow(row: {
  id: string;
  run_id: string;
  step_name: string;
  step_order: number;
  status: WhatsAppAgentRunStepStatus;
  provider: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  unit_input_price_per_million: string | number | null;
  unit_output_price_per_million: string | number | null;
  estimated_cost_usd: string | number | null;
  started_at: string | null;
  finished_at: string | null;
  output_json: unknown;
  error: string | null;
  created_at: string;
}): WhatsAppAgentRunStepRecord {
  return {
    id: row.id,
    runId: row.run_id,
    stepName: row.step_name,
    stepOrder: Number(row.step_order || 0),
    status: row.status,
    provider: row.provider ? String(row.provider) : null,
    model: row.model ? String(row.model) : null,
    inputTokens: row.input_tokens == null ? null : Number(row.input_tokens),
    outputTokens: row.output_tokens == null ? null : Number(row.output_tokens),
    cachedInputTokens: row.cached_input_tokens == null ? null : Number(row.cached_input_tokens),
    unitInputPricePerMillion:
      row.unit_input_price_per_million == null ? null : Number(row.unit_input_price_per_million),
    unitOutputPricePerMillion:
      row.unit_output_price_per_million == null ? null : Number(row.unit_output_price_per_million),
    estimatedCostUsd: row.estimated_cost_usd == null ? null : Number(row.estimated_cost_usd),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    outputJson: asRecord(row.output_json),
    error: row.error ? String(row.error) : null,
    createdAt: row.created_at
  };
}

export async function createWhatsAppAgentRun(input: {
  leadId: string;
  messageId: string;
  status?: WhatsAppAgentRunStatus;
}): Promise<WhatsAppAgentRunRecord> {
  const db = getPoolOrThrow();
  const q = await db.query<{
    id: string;
    lead_id: string;
    message_id: string;
    status: WhatsAppAgentRunStatus;
    started_at: string;
    finished_at: string | null;
    total_input_tokens: number | null;
    total_output_tokens: number | null;
    total_estimated_cost_usd: string | number | null;
    created_at: string;
  }>(
    `
      insert into whatsapp_agent_runs (lead_id, message_id, status)
      values ($1::uuid, $2::uuid, $3::text)
      returning id, lead_id, message_id, status, started_at, finished_at, total_input_tokens, total_output_tokens, total_estimated_cost_usd, created_at
    `,
    [input.leadId, input.messageId, input.status || "running"]
  );
  return mapRunRow(q.rows[0]);
}

export async function updateWhatsAppAgentRun(input: {
  runId: string;
  status: WhatsAppAgentRunStatus;
  finishedAt?: string | null;
  totalInputTokens?: number | null;
  totalOutputTokens?: number | null;
  totalEstimatedCostUsd?: number | null;
}): Promise<void> {
  const db = getPoolOrThrow();
  await db.query(
    `
      update whatsapp_agent_runs
      set
        status = $2::text,
        finished_at = coalesce($3::timestamptz, case when $2::text = 'running' then null else now() end),
        total_input_tokens = coalesce($4::int, total_input_tokens),
        total_output_tokens = coalesce($5::int, total_output_tokens),
        total_estimated_cost_usd = coalesce($6::numeric(12,6), total_estimated_cost_usd)
      where id = $1::uuid
    `,
    [
      input.runId,
      input.status,
      input.finishedAt ?? null,
      input.totalInputTokens ?? null,
      input.totalOutputTokens ?? null,
      input.totalEstimatedCostUsd ?? null
    ]
  );
}

export async function upsertWhatsAppAgentRunStep(input: {
  runId: string;
  stepName: string;
  stepOrder: number;
  status: WhatsAppAgentRunStepStatus;
  provider?: string | null;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedInputTokens?: number | null;
  unitInputPricePerMillion?: number | null;
  unitOutputPricePerMillion?: number | null;
  estimatedCostUsd?: number | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  outputJson?: Record<string, unknown> | null;
  error?: string | null;
}): Promise<WhatsAppAgentRunStepRecord> {
  const db = getPoolOrThrow();
  const q = await db.query<{
    id: string;
    run_id: string;
    step_name: string;
    step_order: number;
    status: WhatsAppAgentRunStepStatus;
    provider: string | null;
    model: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
    cached_input_tokens: number | null;
    unit_input_price_per_million: string | number | null;
    unit_output_price_per_million: string | number | null;
    estimated_cost_usd: string | number | null;
    started_at: string | null;
    finished_at: string | null;
    output_json: unknown;
    error: string | null;
    created_at: string;
  }>(
    `
      insert into whatsapp_agent_run_steps (
        run_id,
        step_name,
        step_order,
        status,
        provider,
        model,
        input_tokens,
        output_tokens,
        cached_input_tokens,
        unit_input_price_per_million,
        unit_output_price_per_million,
        estimated_cost_usd,
        started_at,
        finished_at,
        output_json,
        error
      )
      values (
        $1::uuid,
        $2::text,
        $3::int,
        $4::text,
        nullif(trim($5::text), ''),
        nullif(trim($6::text), ''),
        $7::int,
        $8::int,
        $9::int,
        $10::numeric(12,6),
        $11::numeric(12,6),
        $12::numeric(12,6),
        $13::timestamptz,
        $14::timestamptz,
        $15::jsonb,
        nullif(trim($16::text), '')
      )
      on conflict (run_id, step_name)
      do update set
        step_order = excluded.step_order,
        status = excluded.status,
        provider = excluded.provider,
        model = coalesce(excluded.model, whatsapp_agent_run_steps.model),
        input_tokens = coalesce(excluded.input_tokens, whatsapp_agent_run_steps.input_tokens),
        output_tokens = coalesce(excluded.output_tokens, whatsapp_agent_run_steps.output_tokens),
        cached_input_tokens = coalesce(excluded.cached_input_tokens, whatsapp_agent_run_steps.cached_input_tokens),
        unit_input_price_per_million = coalesce(excluded.unit_input_price_per_million, whatsapp_agent_run_steps.unit_input_price_per_million),
        unit_output_price_per_million = coalesce(excluded.unit_output_price_per_million, whatsapp_agent_run_steps.unit_output_price_per_million),
        estimated_cost_usd = coalesce(excluded.estimated_cost_usd, whatsapp_agent_run_steps.estimated_cost_usd),
        started_at = coalesce(excluded.started_at, whatsapp_agent_run_steps.started_at),
        finished_at = coalesce(excluded.finished_at, whatsapp_agent_run_steps.finished_at),
        output_json = coalesce(excluded.output_json, whatsapp_agent_run_steps.output_json),
        error = excluded.error
      returning id, run_id, step_name, step_order, status, provider, model, input_tokens, output_tokens, cached_input_tokens, unit_input_price_per_million, unit_output_price_per_million, estimated_cost_usd, started_at, finished_at, output_json, error, created_at
    `,
    [
      input.runId,
      input.stepName,
      Math.max(1, Math.round(input.stepOrder || 1)),
      input.status,
      input.provider ?? null,
      input.model ?? null,
      input.inputTokens ?? null,
      input.outputTokens ?? null,
      input.cachedInputTokens ?? null,
      input.unitInputPricePerMillion ?? null,
      input.unitOutputPricePerMillion ?? null,
      input.estimatedCostUsd ?? null,
      input.startedAt ?? null,
      input.finishedAt ?? null,
      input.outputJson == null ? null : JSON.stringify(input.outputJson),
      input.error ?? null
    ]
  );
  return mapStepRow(q.rows[0]);
}

export async function getLatestWhatsAppAgentRunByLead(leadId: string): Promise<{
  run: WhatsAppAgentRunRecord;
  steps: WhatsAppAgentRunStepRecord[];
} | null> {
  const db = getPoolOrThrow();
  const runQ = await db.query<{
    id: string;
    lead_id: string;
    message_id: string;
    status: WhatsAppAgentRunStatus;
    started_at: string;
    finished_at: string | null;
    total_input_tokens: number | null;
    total_output_tokens: number | null;
    total_estimated_cost_usd: string | number | null;
    created_at: string;
  }>(
    `
      select id, lead_id, message_id, status, started_at, finished_at, total_input_tokens, total_output_tokens, total_estimated_cost_usd, created_at
      from whatsapp_agent_runs
      where lead_id = $1::uuid
      order by created_at desc
      limit 1
    `,
    [leadId]
  );
  const runRow = runQ.rows[0];
  if (!runRow) return null;

  const stepsQ = await db.query<{
    id: string;
    run_id: string;
    step_name: string;
    step_order: number;
    status: WhatsAppAgentRunStepStatus;
    provider: string | null;
    model: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
    cached_input_tokens: number | null;
    unit_input_price_per_million: string | number | null;
    unit_output_price_per_million: string | number | null;
    estimated_cost_usd: string | number | null;
    started_at: string | null;
    finished_at: string | null;
    output_json: unknown;
    error: string | null;
    created_at: string;
  }>(
    `
      select id, run_id, step_name, step_order, status, provider, model, input_tokens, output_tokens, cached_input_tokens, unit_input_price_per_million, unit_output_price_per_million, estimated_cost_usd, started_at, finished_at, output_json, error, created_at
      from whatsapp_agent_run_steps
      where run_id = $1::uuid
      order by step_order asc, created_at asc
    `,
    [runRow.id]
  );

  return {
    run: mapRunRow(runRow),
    steps: stepsQ.rows.map(mapStepRow)
  };
}

export async function getWhatsAppAgentRunById(runId: string): Promise<{
  run: WhatsAppAgentRunRecord;
  steps: WhatsAppAgentRunStepRecord[];
} | null> {
  const db = getPoolOrThrow();
  const runQ = await db.query<{
    id: string;
    lead_id: string;
    message_id: string;
    status: WhatsAppAgentRunStatus;
    started_at: string;
    finished_at: string | null;
    total_input_tokens: number | null;
    total_output_tokens: number | null;
    total_estimated_cost_usd: string | number | null;
    created_at: string;
  }>(
    `
      select id, lead_id, message_id, status, started_at, finished_at, total_input_tokens, total_output_tokens, total_estimated_cost_usd, created_at
      from whatsapp_agent_runs
      where id = $1::uuid
      limit 1
    `,
    [runId]
  );
  const runRow = runQ.rows[0];
  if (!runRow) return null;

  const stepsQ = await db.query<{
    id: string;
    run_id: string;
    step_name: string;
    step_order: number;
    status: WhatsAppAgentRunStepStatus;
    provider: string | null;
    model: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
    cached_input_tokens: number | null;
    unit_input_price_per_million: string | number | null;
    unit_output_price_per_million: string | number | null;
    estimated_cost_usd: string | number | null;
    started_at: string | null;
    finished_at: string | null;
    output_json: unknown;
    error: string | null;
    created_at: string;
  }>(
    `
      select id, run_id, step_name, step_order, status, provider, model, input_tokens, output_tokens, cached_input_tokens, unit_input_price_per_million, unit_output_price_per_million, estimated_cost_usd, started_at, finished_at, output_json, error, created_at
      from whatsapp_agent_run_steps
      where run_id = $1::uuid
      order by step_order asc, created_at asc
    `,
    [runRow.id]
  );

  return {
    run: mapRunRow(runRow),
    steps: stepsQ.rows.map(mapStepRow)
  };
}

export async function upsertWhatsAppAgentLeadState(input: {
  leadId: string;
  latestRunId?: string | null;
  latestMessageId?: string | null;
  stageAnalysis?: Record<string, unknown> | null;
  facts?: Record<string, unknown> | null;
  structuredState?: Record<string, unknown> | null;
  priorityItem?: Record<string, unknown> | null;
  strategy?: Record<string, unknown> | null;
  replyOptions?: Record<string, unknown> | null;
  brandReview?: Record<string, unknown> | null;
  topReplyCard?: Record<string, unknown> | null;
  providers?: Record<string, unknown> | null;
  reasoningSource?: string | null;
}): Promise<WhatsAppAgentLeadStateRecord> {
  const db = getPoolOrThrow();
  const q = await db.query<{
    lead_id: string;
    latest_run_id: string | null;
    latest_message_id: string | null;
    stage_analysis: unknown;
    facts: unknown;
    structured_state: unknown;
    priority_item: unknown;
    strategy: unknown;
    reply_options: unknown;
    brand_review: unknown;
    top_reply_card: unknown;
    providers: unknown;
    reasoning_source: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `
      insert into whatsapp_agent_lead_state (
        lead_id,
        latest_run_id,
        latest_message_id,
        stage_analysis,
        facts,
        structured_state,
        priority_item,
        strategy,
        reply_options,
        brand_review,
        top_reply_card,
        providers,
        reasoning_source
      )
      values (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        $4::jsonb,
        $5::jsonb,
        $6::jsonb,
        $7::jsonb,
        $8::jsonb,
        $9::jsonb,
        $10::jsonb,
        $11::jsonb,
        $12::jsonb,
        nullif(trim($13::text), '')
      )
      on conflict (lead_id)
      do update set
        latest_run_id = coalesce(excluded.latest_run_id, whatsapp_agent_lead_state.latest_run_id),
        latest_message_id = coalesce(excluded.latest_message_id, whatsapp_agent_lead_state.latest_message_id),
        stage_analysis = coalesce(excluded.stage_analysis, whatsapp_agent_lead_state.stage_analysis),
        facts = coalesce(excluded.facts, whatsapp_agent_lead_state.facts),
        structured_state = coalesce(excluded.structured_state, whatsapp_agent_lead_state.structured_state),
        priority_item = coalesce(excluded.priority_item, whatsapp_agent_lead_state.priority_item),
        strategy = coalesce(excluded.strategy, whatsapp_agent_lead_state.strategy),
        reply_options = coalesce(excluded.reply_options, whatsapp_agent_lead_state.reply_options),
        brand_review = coalesce(excluded.brand_review, whatsapp_agent_lead_state.brand_review),
        top_reply_card = coalesce(excluded.top_reply_card, whatsapp_agent_lead_state.top_reply_card),
        providers = coalesce(excluded.providers, whatsapp_agent_lead_state.providers),
        reasoning_source = coalesce(excluded.reasoning_source, whatsapp_agent_lead_state.reasoning_source),
        updated_at = now()
      returning
        lead_id,
        latest_run_id,
        latest_message_id,
        stage_analysis,
        facts,
        structured_state,
        priority_item,
        strategy,
        reply_options,
        brand_review,
        top_reply_card,
        providers,
        reasoning_source,
        created_at,
        updated_at
    `,
    [
      input.leadId,
      input.latestRunId ?? null,
      input.latestMessageId ?? null,
      input.stageAnalysis == null ? null : JSON.stringify(input.stageAnalysis),
      input.facts == null ? null : JSON.stringify(input.facts),
      input.structuredState == null ? null : JSON.stringify(input.structuredState),
      input.priorityItem == null ? null : JSON.stringify(input.priorityItem),
      input.strategy == null ? null : JSON.stringify(input.strategy),
      input.replyOptions == null ? null : JSON.stringify(input.replyOptions),
      input.brandReview == null ? null : JSON.stringify(input.brandReview),
      input.topReplyCard == null ? null : JSON.stringify(input.topReplyCard),
      input.providers == null ? null : JSON.stringify(input.providers),
      input.reasoningSource ?? null
    ]
  );
  const row = q.rows[0];
  return {
    leadId: row.lead_id,
    latestRunId: row.latest_run_id,
    latestMessageId: row.latest_message_id,
    stageAnalysis: asRecord(row.stage_analysis),
    facts: asRecord(row.facts),
    structuredState: asRecord(row.structured_state),
    priorityItem: asRecord(row.priority_item),
    strategy: asRecord(row.strategy),
    replyOptions: asRecord(row.reply_options),
    brandReview: asRecord(row.brand_review),
    topReplyCard: asRecord(row.top_reply_card),
    providers: asRecord(row.providers),
    reasoningSource: row.reasoning_source ? String(row.reasoning_source) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function getWhatsAppAgentLeadState(leadId: string): Promise<WhatsAppAgentLeadStateRecord | null> {
  const db = getPoolOrThrow();
  const q = await db.query<{
    lead_id: string;
    latest_run_id: string | null;
    latest_message_id: string | null;
    stage_analysis: unknown;
    facts: unknown;
    structured_state: unknown;
    priority_item: unknown;
    strategy: unknown;
    reply_options: unknown;
    brand_review: unknown;
    top_reply_card: unknown;
    providers: unknown;
    reasoning_source: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `
      select
        lead_id,
        latest_run_id,
        latest_message_id,
        stage_analysis,
        facts,
        structured_state,
        priority_item,
        strategy,
        reply_options,
        brand_review,
        top_reply_card,
        providers,
        reasoning_source,
        created_at,
        updated_at
      from whatsapp_agent_lead_state
      where lead_id = $1::uuid
      limit 1
    `,
    [leadId]
  );
  const row = q.rows[0];
  if (!row) return null;
  return {
    leadId: row.lead_id,
    latestRunId: row.latest_run_id,
    latestMessageId: row.latest_message_id,
    stageAnalysis: asRecord(row.stage_analysis),
    facts: asRecord(row.facts),
    structuredState: asRecord(row.structured_state),
    priorityItem: asRecord(row.priority_item),
    strategy: asRecord(row.strategy),
    replyOptions: asRecord(row.reply_options),
    brandReview: asRecord(row.brand_review),
    topReplyCard: asRecord(row.top_reply_card),
    providers: asRecord(row.providers),
    reasoningSource: row.reasoning_source ? String(row.reasoning_source) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
