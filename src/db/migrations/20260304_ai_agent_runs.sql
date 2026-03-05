create table if not exists ai_agent_runs (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null,
  message_id uuid not null,
  status text not null check (status in ('queued', 'success', 'error')),
  model text,
  latency_ms int,
  prompt_text text not null,
  response_json jsonb,
  error_text text,
  created_at timestamptz not null default now()
);

create index if not exists idx_ai_agent_runs_lead_created on ai_agent_runs(lead_id, created_at desc);
create index if not exists idx_ai_agent_runs_message on ai_agent_runs(message_id);
