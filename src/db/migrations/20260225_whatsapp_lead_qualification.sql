create table if not exists whatsapp_lead_messages (
  id uuid primary key,
  lead_id uuid not null references whatsapp_leads(id) on delete cascade,
  direction text not null,
  text text not null,
  created_at timestamptz not null default now()
);

alter table whatsapp_leads add column if not exists qualification_tags text[] not null default '{}';
alter table whatsapp_leads add column if not exists intent_level text;
alter table whatsapp_leads add column if not exists stage_confidence numeric(5,4);
alter table whatsapp_leads add column if not exists stage_auto boolean not null default false;
alter table whatsapp_leads add column if not exists stage_auto_reason text;

create index if not exists idx_whatsapp_lead_messages_lead_created on whatsapp_lead_messages(lead_id, created_at desc);
