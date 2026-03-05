alter table whatsapp_leads add column if not exists converted_at timestamptz;
alter table whatsapp_leads add column if not exists conversion_source text;

