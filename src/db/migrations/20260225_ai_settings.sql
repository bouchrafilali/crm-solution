create table if not exists ai_settings (
  id int primary key default 1 check (id = 1),
  default_language text not null default 'AUTO' check (default_language in ('AUTO', 'FR', 'EN')),
  tone text not null default 'QUIET_LUXURY' check (tone in ('FORMEL', 'QUIET_LUXURY', 'DIRECT')),
  message_length text not null default 'SHORT' check (message_length in ('SHORT', 'MEDIUM')),
  include_price_policy text not null default 'AFTER_QUALIFIED' check (include_price_policy in ('NEVER_FIRST', 'AFTER_QUALIFIED')),
  include_video_call text not null default 'WHEN_HIGH_INTENT' check (include_video_call in ('NEVER', 'WHEN_HIGH_INTENT', 'ALWAYS')),
  urgency_style text not null default 'SUBTLE' check (urgency_style in ('SUBTLE', 'NEUTRAL')),
  no_emojis boolean not null default true,
  avoid_follow_up_phrase boolean not null default true,
  signature_enabled boolean not null default false,
  signature_text text,
  updated_at timestamptz not null default now()
);

insert into ai_settings (id)
values (1)
on conflict (id) do nothing;
