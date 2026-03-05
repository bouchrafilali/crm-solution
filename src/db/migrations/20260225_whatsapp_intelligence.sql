-- WhatsApp Intelligence module

do $$
begin
  create type whatsapp_lead_stage as enum (
    'NEW',
    'PRICE_SENT',
    'QUALIFIED',
    'VIDEO_PROPOSED',
    'DEPOSIT_PENDING',
    'CONVERTED',
    'LOST'
  );
exception
  when duplicate_object then null;
end
$$;

create table if not exists whatsapp_leads (
  id uuid primary key,
  shop text,
  client_name text not null,
  phone_number text not null,
  country text,
  inquiry_source text,
  product_reference text,
  price_sent boolean not null default false,
  production_time_sent boolean not null default false,
  stage whatsapp_lead_stage not null default 'NEW',
  last_message_at timestamptz,
  last_activity_at timestamptz,
  first_response_time_minutes int,
  internal_notes text,
  qualification_tags text[] not null default '{}',
  intent_level text,
  stage_confidence numeric(5,4),
  stage_auto boolean not null default false,
  stage_auto_reason text,
  follow_up_48_sent boolean not null default false,
  follow_up_72_sent boolean not null default false,
  conversion_value numeric(12,2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists whatsapp_lead_events (
  id bigserial primary key,
  lead_id uuid not null references whatsapp_leads(id) on delete cascade,
  shop text,
  event_type text not null,
  payload jsonb,
  created_at timestamptz not null default now()
);

create table if not exists whatsapp_lead_messages (
  id uuid primary key,
  lead_id uuid not null references whatsapp_leads(id) on delete cascade,
  direction text not null,
  text text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_whatsapp_leads_stage on whatsapp_leads(stage);
create index if not exists idx_whatsapp_leads_created_at on whatsapp_leads(created_at desc);
create index if not exists idx_whatsapp_leads_phone_number on whatsapp_leads(phone_number);
create index if not exists idx_whatsapp_leads_last_activity_at on whatsapp_leads(last_activity_at desc);
create index if not exists idx_whatsapp_leads_shop_created_at on whatsapp_leads(shop, created_at desc);
create index if not exists idx_whatsapp_lead_events_lead_id on whatsapp_lead_events(lead_id, created_at desc);
create index if not exists idx_whatsapp_lead_messages_lead_created on whatsapp_lead_messages(lead_id, created_at desc);
