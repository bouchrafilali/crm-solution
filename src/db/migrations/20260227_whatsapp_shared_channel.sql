alter table whatsapp_leads
  add column if not exists channel_type text not null default 'API',
  add column if not exists ai_mode text not null default 'ACTIVE';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'whatsapp_leads_channel_type_check'
  ) then
    alter table whatsapp_leads
      add constraint whatsapp_leads_channel_type_check
      check (channel_type in ('API', 'SHARED'));
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'whatsapp_leads_ai_mode_check'
  ) then
    alter table whatsapp_leads
      add constraint whatsapp_leads_ai_mode_check
      check (ai_mode in ('ACTIVE', 'ANALYZE_ONLY'));
  end if;
end $$;

update whatsapp_leads
set ai_mode = 'ANALYZE_ONLY'
where coalesce(channel_type, 'API') = 'SHARED';

update whatsapp_leads
set ai_mode = 'ACTIVE'
where coalesce(channel_type, 'API') = 'API'
  and coalesce(ai_mode, '') <> 'ACTIVE';

create table if not exists ai_insights (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references whatsapp_leads(id) on delete cascade,
  intents jsonb not null default '{}'::jsonb,
  suggested_replies jsonb not null default '[]'::jsonb,
  proposed_stage text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_ai_insights_conversation
  on ai_insights(conversation_id, created_at desc);
