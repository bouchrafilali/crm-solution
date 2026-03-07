create table if not exists whatsapp_lead_outcomes (
  lead_id uuid primary key references whatsapp_leads(id) on delete cascade,
  outcome text not null check (outcome in ('open', 'converted', 'lost', 'stalled')),
  final_stage text,
  outcome_at timestamptz not null,
  order_value numeric(12,2),
  currency text,
  source text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_whatsapp_lead_outcomes_outcome_at on whatsapp_lead_outcomes(outcome_at desc);
create index if not exists idx_whatsapp_lead_outcomes_outcome on whatsapp_lead_outcomes(outcome, outcome_at desc);
