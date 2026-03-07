create table if not exists whatsapp_mobile_lab_skips (
  lead_id uuid not null references whatsapp_leads(id) on delete cascade,
  feed_type text not null check (feed_type in ('active', 'reactivation')),
  skipped_until timestamptz not null,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (lead_id, feed_type)
);

create index if not exists idx_whatsapp_mobile_lab_skips_active on whatsapp_mobile_lab_skips(skipped_until desc, feed_type);
