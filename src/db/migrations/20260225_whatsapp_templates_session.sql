alter table whatsapp_lead_messages add column if not exists template_name text;

create table if not exists whatsapp_templates (
  id text primary key,
  name text not null,
  category text,
  language text,
  components jsonb,
  variables_count int not null default 0,
  raw jsonb,
  updated_at timestamptz not null default now()
);
