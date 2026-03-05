alter table whatsapp_leads add column if not exists has_product_interest boolean not null default false;
alter table whatsapp_leads add column if not exists has_price_sent boolean not null default false;
alter table whatsapp_leads add column if not exists has_video_proposed boolean not null default false;
alter table whatsapp_leads add column if not exists has_payment_question boolean not null default false;
alter table whatsapp_leads add column if not exists has_deposit_link_sent boolean not null default false;
alter table whatsapp_leads add column if not exists chat_confirmed boolean not null default false;
alter table whatsapp_leads add column if not exists last_signal_at timestamptz;

alter table whatsapp_leads add column if not exists product_interest_source_message_id text;
alter table whatsapp_leads add column if not exists price_sent_source_message_id text;
alter table whatsapp_leads add column if not exists video_proposed_source_message_id text;
alter table whatsapp_leads add column if not exists payment_question_source_message_id text;
alter table whatsapp_leads add column if not exists deposit_link_source_message_id text;
alter table whatsapp_leads add column if not exists chat_confirmed_source_message_id text;

create index if not exists idx_whatsapp_leads_has_product_interest on whatsapp_leads(has_product_interest);
create index if not exists idx_whatsapp_leads_has_price_sent on whatsapp_leads(has_price_sent);
create index if not exists idx_whatsapp_leads_has_video_proposed on whatsapp_leads(has_video_proposed);
create index if not exists idx_whatsapp_leads_has_payment_question on whatsapp_leads(has_payment_question);
create index if not exists idx_whatsapp_leads_has_deposit_link_sent on whatsapp_leads(has_deposit_link_sent);
create index if not exists idx_whatsapp_leads_chat_confirmed on whatsapp_leads(chat_confirmed);
create index if not exists idx_whatsapp_leads_last_signal_at on whatsapp_leads(last_signal_at desc);
