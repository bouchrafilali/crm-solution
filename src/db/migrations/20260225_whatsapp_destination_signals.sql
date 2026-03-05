alter table whatsapp_leads add column if not exists event_date date;
alter table whatsapp_leads add column if not exists event_date_text text;
alter table whatsapp_leads add column if not exists event_date_confidence int;
alter table whatsapp_leads add column if not exists event_date_source_message_id text;
alter table whatsapp_leads add column if not exists event_date_updated_at timestamptz;
alter table whatsapp_leads add column if not exists event_date_manual boolean not null default false;

alter table whatsapp_leads add column if not exists ship_city text;
alter table whatsapp_leads add column if not exists ship_region text;
alter table whatsapp_leads add column if not exists ship_country text;
alter table whatsapp_leads add column if not exists ship_destination_text text;
alter table whatsapp_leads add column if not exists ship_destination_confidence int;
alter table whatsapp_leads add column if not exists ship_destination_source_message_id text;
alter table whatsapp_leads add column if not exists ship_destination_updated_at timestamptz;
alter table whatsapp_leads add column if not exists ship_destination_manual boolean not null default false;
