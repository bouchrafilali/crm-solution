alter table whatsapp_leads add column if not exists last_activity_at timestamptz;
alter table whatsapp_leads add column if not exists internal_notes text;

update whatsapp_leads
set last_activity_at = coalesce(last_activity_at, last_message_at, created_at)
where last_activity_at is null;

create index if not exists idx_whatsapp_leads_last_activity_at on whatsapp_leads(last_activity_at desc);
