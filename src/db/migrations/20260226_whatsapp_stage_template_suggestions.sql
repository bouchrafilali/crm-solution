create table if not exists stage_template_suggestions (
  id uuid primary key default gen_random_uuid(),
  stage text not null check (stage in ('NEW','PRODUCT_INTEREST','QUALIFICATION_PENDING','QUALIFIED','PRICE_SENT','VIDEO_PROPOSED','DEPOSIT_PENDING','CONFIRMED','CONVERTED','LOST')),
  template_name text not null,
  priority int not null default 100,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(stage, template_name)
);

create index if not exists idx_stage_template_suggestions_stage on stage_template_suggestions(stage, enabled, priority asc);
