alter table ai_agent_runs
  add column if not exists trigger_source text,
  add column if not exists tokens_in int,
  add column if not exists tokens_out int;

create index if not exists idx_ai_agent_runs_lead_status_created
  on ai_agent_runs(lead_id, status, created_at desc);
