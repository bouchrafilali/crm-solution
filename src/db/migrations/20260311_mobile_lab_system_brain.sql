-- Mobile-Lab System Brain: flows, prompt governance, execution traces, token economy

create table if not exists ml_flow_definitions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  environment text not null check (environment in ('draft', 'staging', 'production')),
  status text not null check (status in ('active', 'disabled', 'archived')) default 'active',
  version text not null,
  is_current boolean not null default false,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists idx_ml_flow_definitions_env_current on ml_flow_definitions(environment) where is_current = true;
create index if not exists idx_ml_flow_definitions_name on ml_flow_definitions(name);

create table if not exists ml_flow_nodes (
  id uuid primary key default gen_random_uuid(),
  flow_id uuid not null references ml_flow_definitions(id) on delete cascade,
  node_key text not null,
  node_type text not null,
  label text not null,
  provider text,
  model text,
  prompt_definition_id uuid,
  prompt_version_id uuid,
  config_json jsonb not null default '{}'::jsonb,
  x numeric(10,2) not null default 0,
  y numeric(10,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(flow_id, node_key)
);
create index if not exists idx_ml_flow_nodes_flow on ml_flow_nodes(flow_id);
create index if not exists idx_ml_flow_nodes_prompt_version on ml_flow_nodes(prompt_version_id);

create table if not exists ml_flow_edges (
  id uuid primary key default gen_random_uuid(),
  flow_id uuid not null references ml_flow_definitions(id) on delete cascade,
  edge_key text not null,
  from_node_id uuid not null references ml_flow_nodes(id) on delete cascade,
  to_node_id uuid not null references ml_flow_nodes(id) on delete cascade,
  edge_kind text not null check (edge_kind in ('default', 'fallback', 'condition_true', 'condition_false')),
  condition_expr text,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(flow_id, edge_key)
);
create index if not exists idx_ml_flow_edges_flow on ml_flow_edges(flow_id);

create table if not exists ml_prompt_definitions (
  id uuid primary key default gen_random_uuid(),
  prompt_key text not null unique,
  name text not null,
  purpose text,
  owner_team text,
  default_provider text,
  default_model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists ml_prompt_versions (
  id uuid primary key default gen_random_uuid(),
  prompt_definition_id uuid not null references ml_prompt_definitions(id) on delete cascade,
  version text not null,
  status text not null check (status in ('draft', 'staging', 'production', 'deprecated')),
  prompt_text text not null,
  schema_json jsonb,
  token_size_estimate integer,
  changelog text,
  created_by text,
  created_at timestamptz not null default now(),
  unique(prompt_definition_id, version)
);
create index if not exists idx_ml_prompt_versions_definition on ml_prompt_versions(prompt_definition_id, created_at desc);

create table if not exists ml_prompt_deployments (
  id uuid primary key default gen_random_uuid(),
  prompt_version_id uuid not null references ml_prompt_versions(id) on delete cascade,
  environment text not null check (environment in ('staging', 'production')),
  deployed_by text,
  deployed_at timestamptz not null default now(),
  rollback_of_deployment_id uuid references ml_prompt_deployments(id),
  notes text
);
create index if not exists idx_ml_prompt_deployments_env on ml_prompt_deployments(environment, deployed_at desc);

create table if not exists ml_step_configurations (
  id uuid primary key default gen_random_uuid(),
  step_name text not null,
  environment text not null check (environment in ('draft', 'staging', 'production')),
  provider text,
  model text,
  prompt_version_id uuid references ml_prompt_versions(id),
  token_budget integer,
  max_latency_ms integer,
  fallback_policy_json jsonb not null default '{}'::jsonb,
  cache_policy_json jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_ml_step_configurations_step_env on ml_step_configurations(step_name, environment, is_active);

create table if not exists ml_provider_settings (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  environment text not null check (environment in ('staging', 'production')),
  default_model text,
  enabled boolean not null default true,
  rate_limit_per_min integer,
  timeout_ms integer,
  config_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(provider, environment)
);

create table if not exists ml_execution_logs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid,
  lead_id uuid,
  conversation_id uuid,
  flow_id uuid references ml_flow_definitions(id),
  step_name text,
  provider text,
  model text,
  status text,
  cache_hit boolean,
  joined_inflight boolean,
  fallback_triggered boolean,
  input_tokens integer,
  output_tokens integer,
  latency_ms integer,
  error_code text,
  error_message text,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_ml_execution_logs_lead_created on ml_execution_logs(lead_id, created_at desc);
create index if not exists idx_ml_execution_logs_step_created on ml_execution_logs(step_name, created_at desc);

create table if not exists ml_token_metrics_daily (
  id uuid primary key default gen_random_uuid(),
  metric_date date not null,
  step_name text,
  provider text,
  model text,
  total_input_tokens bigint not null default 0,
  total_output_tokens bigint not null default 0,
  total_cost_usd numeric(12,6) not null default 0,
  total_runs bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(metric_date, step_name, provider, model)
);
create index if not exists idx_ml_token_metrics_daily_date on ml_token_metrics_daily(metric_date desc);

create table if not exists ml_pipeline_snapshots (
  id uuid primary key default gen_random_uuid(),
  run_id uuid,
  lead_id uuid,
  flow_id uuid references ml_flow_definitions(id),
  flow_version text,
  stage_result_json jsonb,
  strategy_result_json jsonb,
  reply_result_json jsonb,
  brand_result_json jsonb,
  final_output_json jsonb,
  prompt_versions_json jsonb,
  token_trace_json jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_ml_pipeline_snapshots_lead_created on ml_pipeline_snapshots(lead_id, created_at desc);

create table if not exists ml_debugger_traces (
  id uuid primary key default gen_random_uuid(),
  trace_key text not null unique,
  run_id uuid,
  lead_id uuid,
  pipeline_snapshot_id uuid references ml_pipeline_snapshots(id) on delete set null,
  trace_json jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_ml_debugger_traces_lead_created on ml_debugger_traces(lead_id, created_at desc);

create table if not exists ml_feature_flags (
  id uuid primary key default gen_random_uuid(),
  flag_key text not null unique,
  environment text not null check (environment in ('staging', 'production')),
  enabled boolean not null default false,
  rollout_percentage integer not null default 100,
  config_json jsonb not null default '{}'::jsonb,
  updated_by text,
  updated_at timestamptz not null default now()
);
create index if not exists idx_ml_feature_flags_env on ml_feature_flags(environment, flag_key);
