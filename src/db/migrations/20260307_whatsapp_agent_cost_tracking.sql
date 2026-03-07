alter table whatsapp_agent_run_steps
  add column if not exists model text,
  add column if not exists input_tokens int,
  add column if not exists output_tokens int,
  add column if not exists cached_input_tokens int,
  add column if not exists unit_input_price_per_million numeric(12,6),
  add column if not exists unit_output_price_per_million numeric(12,6),
  add column if not exists estimated_cost_usd numeric(12,6);

alter table whatsapp_agent_runs
  add column if not exists total_input_tokens int,
  add column if not exists total_output_tokens int,
  add column if not exists total_estimated_cost_usd numeric(12,6);
