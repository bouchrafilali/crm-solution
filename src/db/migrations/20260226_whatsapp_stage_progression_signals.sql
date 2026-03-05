alter table whatsapp_leads add column if not exists stage_auto_source_message_id text;
alter table whatsapp_leads add column if not exists stage_auto_confidence int;
alter table whatsapp_leads add column if not exists shopify_order_id text;
alter table whatsapp_leads add column if not exists payment_received boolean not null default false;
alter table whatsapp_leads add column if not exists deposit_paid boolean not null default false;
