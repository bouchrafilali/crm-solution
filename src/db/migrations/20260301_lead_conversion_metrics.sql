create table if not exists lead_conversion_metrics (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null unique references whatsapp_leads(id) on delete cascade,
  ticket_value numeric,
  total_messages int not null default 0,
  first_response_delay_minutes int,
  avg_response_delay_minutes int,
  price_sent_delay_minutes int,
  suggestion_used boolean not null default false,
  template_used boolean not null default false,
  follow_up_triggered boolean not null default false,
  video_proposed boolean not null default false,
  conversion_probability_at_price int,
  country text,
  created_at timestamptz not null default now()
);

create index if not exists idx_lead_conversion_metrics_created_at on lead_conversion_metrics(created_at desc);
create index if not exists idx_lead_conversion_metrics_country on lead_conversion_metrics(country);
