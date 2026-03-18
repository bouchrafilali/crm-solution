create table if not exists whatsapp_human_queries (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references whatsapp_leads(id) on delete cascade,
  question text not null,
  context jsonb,
  status text not null default 'pending' check (status in ('pending', 'answered', 'cancelled')),
  answer text,
  created_at timestamptz not null default now(),
  answered_at timestamptz
);

create index if not exists idx_whatsapp_human_queries_lead_status_created
  on whatsapp_human_queries(lead_id, status, created_at desc);
