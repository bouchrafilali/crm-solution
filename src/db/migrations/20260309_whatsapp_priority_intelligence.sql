create table if not exists whatsapp_priority_intelligence (
  lead_id uuid primary key references whatsapp_leads(id) on delete cascade,
  stage text not null,
  facts jsonb not null default '{}'::jsonb,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  event_date date,
  payment_intent boolean not null default false,
  awaiting_reply boolean not null default false,
  ticket_value_estimate numeric(12,2),
  conversion_probability numeric(8,4) not null,
  dropoff_risk numeric(8,4) not null,
  priority_score int not null,
  priority_band text not null check (priority_band in ('critical', 'high', 'medium', 'low')),
  recommended_attention text not null,
  reason_codes jsonb not null default '[]'::jsonb,
  primary_reason_code text,
  input_signature text not null,
  computed_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_whatsapp_priority_intelligence_priority
  on whatsapp_priority_intelligence(priority_score desc, updated_at desc);

create index if not exists idx_whatsapp_priority_intelligence_updated_at
  on whatsapp_priority_intelligence(updated_at desc);
