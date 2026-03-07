create table if not exists whatsapp_agent_runs (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references whatsapp_leads(id) on delete cascade,
  message_id uuid not null references whatsapp_lead_messages(id) on delete cascade,
  status text not null check (status in ('running', 'completed', 'failed', 'partial')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_whatsapp_agent_runs_lead_created_at on whatsapp_agent_runs(lead_id, created_at desc);
create index if not exists idx_whatsapp_agent_runs_message_created_at on whatsapp_agent_runs(message_id, created_at desc);

create table if not exists whatsapp_agent_run_steps (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references whatsapp_agent_runs(id) on delete cascade,
  step_name text not null,
  step_order int not null,
  status text not null check (status in ('pending', 'running', 'completed', 'failed', 'skipped')),
  provider text,
  started_at timestamptz,
  finished_at timestamptz,
  output_json jsonb,
  error text,
  created_at timestamptz not null default now(),
  unique (run_id, step_name)
);

create index if not exists idx_whatsapp_agent_run_steps_run_order on whatsapp_agent_run_steps(run_id, step_order asc, created_at asc);

create table if not exists whatsapp_agent_lead_state (
  lead_id uuid primary key references whatsapp_leads(id) on delete cascade,
  latest_run_id uuid references whatsapp_agent_runs(id) on delete set null,
  latest_message_id uuid references whatsapp_lead_messages(id) on delete set null,
  stage_analysis jsonb,
  facts jsonb,
  priority_item jsonb,
  strategy jsonb,
  reply_options jsonb,
  brand_review jsonb,
  top_reply_card jsonb,
  providers jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_whatsapp_agent_lead_state_updated_at on whatsapp_agent_lead_state(updated_at desc);
