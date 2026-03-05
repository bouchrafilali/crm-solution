create table if not exists lead_scoring_factors (
  lead_id uuid primary key references whatsapp_leads(id) on delete cascade,
  score int not null default 0,
  factors jsonb not null default '{}'::jsonb,
  computed_at timestamptz not null default now()
);

create index if not exists idx_lead_scoring_factors_computed_at on lead_scoring_factors(computed_at desc);
