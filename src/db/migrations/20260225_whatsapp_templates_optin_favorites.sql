alter table whatsapp_leads add column if not exists marketing_opt_in boolean not null default false;
alter table whatsapp_leads add column if not exists marketing_opt_in_source text;
alter table whatsapp_leads add column if not exists marketing_opt_in_at timestamptz;

alter table whatsapp_lead_messages add column if not exists metadata jsonb;

create table if not exists whatsapp_templates_cache (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null check (category in ('UTILITY','MARKETING','AUTHENTICATION')),
  language text not null,
  components jsonb,
  variables_count int not null default 0,
  updated_at timestamptz not null default now(),
  unique(name, language)
);

create table if not exists whatsapp_template_favorites (
  id uuid primary key default gen_random_uuid(),
  template_name text not null unique,
  created_at timestamptz not null default now()
);

create index if not exists idx_whatsapp_templates_cache_updated_at on whatsapp_templates_cache(updated_at desc);
create index if not exists idx_whatsapp_template_favorites_template_name on whatsapp_template_favorites(template_name);
