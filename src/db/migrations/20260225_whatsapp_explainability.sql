alter table whatsapp_leads add column if not exists recommended_stage whatsapp_lead_stage;
alter table whatsapp_leads add column if not exists recommended_stage_reason text;
alter table whatsapp_leads add column if not exists recommended_stage_confidence numeric(5,4);
alter table whatsapp_leads add column if not exists detected_signals jsonb not null default '{}'::jsonb;
