alter table whatsapp_agent_lead_state
  add column if not exists structured_state jsonb,
  add column if not exists reasoning_source text;
