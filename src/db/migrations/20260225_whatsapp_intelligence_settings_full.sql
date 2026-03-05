create table if not exists ai_settings_global (
  id int primary key default 1 check (id = 1),
  tone text not null default 'QUIET_LUXURY' check (tone in ('FORMEL', 'QUIET_LUXURY', 'DIRECT')),
  message_length text not null default 'SHORT' check (message_length in ('SHORT', 'MEDIUM')),
  no_emojis boolean not null default true,
  avoid_follow_up_phrase boolean not null default true,
  signature_enabled boolean not null default false,
  signature_text text,
  updated_at timestamptz not null default now()
);

create table if not exists ai_settings_by_country_group (
  country_group text primary key check (country_group in ('MA', 'FR', 'INTL')),
  language text not null default 'AUTO' check (language in ('AUTO', 'FR', 'EN')),
  price_policy text not null default 'AFTER_QUALIFIED' check (price_policy in ('NEVER_FIRST', 'AFTER_QUALIFIED')),
  video_policy text not null default 'WHEN_HIGH_INTENT' check (video_policy in ('NEVER', 'WHEN_HIGH_INTENT', 'ALWAYS')),
  urgency_style text not null default 'SUBTLE' check (urgency_style in ('SUBTLE', 'NEUTRAL')),
  followup_delay_hours int not null default 48,
  updated_at timestamptz not null default now()
);

create table if not exists keyword_rules (
  id uuid primary key default gen_random_uuid(),
  language text not null check (language in ('FR', 'EN')),
  tag text not null check (tag in ('PRICE_REQUEST','EVENT_DATE','SHIPPING','SIZING','RESERVATION_INTENT','PAYMENT','VIDEO_INTEREST','URGENCY','PRODUCT_LINK','INTEREST')),
  keywords text[] not null default '{}',
  patterns text[] not null default '{}',
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists stage_rules (
  id uuid primary key default gen_random_uuid(),
  rule_name text not null,
  required_tags text[] not null default '{}',
  forbidden_tags text[] not null default '{}',
  recommended_stage text not null check (recommended_stage in ('NEW','PRODUCT_INTEREST','QUALIFICATION_PENDING','QUALIFIED','PRICE_SENT','VIDEO_PROPOSED','DEPOSIT_PENDING','CONVERTED','LOST')),
  priority int not null default 100,
  enabled boolean not null default true
);

create table if not exists reply_templates (
  id uuid primary key default gen_random_uuid(),
  stage text not null check (stage in ('NEW','PRODUCT_INTEREST','QUALIFICATION_PENDING','QUALIFIED','PRICE_SENT','VIDEO_PROPOSED','DEPOSIT_PENDING','CONVERTED','LOST')),
  language text not null check (language in ('FR', 'EN')),
  country_group text check (country_group in ('MA', 'FR', 'INTL')),
  template_name text not null,
  text text not null,
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

create index if not exists idx_keyword_rules_language_tag on keyword_rules(language, tag);
create index if not exists idx_stage_rules_priority on stage_rules(priority asc);
create index if not exists idx_reply_templates_lookup on reply_templates(stage, language, country_group, enabled);

insert into ai_settings_global (id) values (1) on conflict (id) do nothing;
insert into ai_settings_by_country_group (country_group) values ('MA'), ('FR'), ('INTL') on conflict (country_group) do nothing;
