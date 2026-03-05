alter table whatsapp_leads add column if not exists price_intent boolean not null default false;
alter table whatsapp_leads add column if not exists video_intent boolean not null default false;
alter table whatsapp_leads add column if not exists payment_intent boolean not null default false;
alter table whatsapp_leads add column if not exists deposit_intent boolean not null default false;
alter table whatsapp_leads add column if not exists confirmation_intent boolean not null default false;

create index if not exists idx_whatsapp_leads_price_intent on whatsapp_leads(price_intent);
create index if not exists idx_whatsapp_leads_video_intent on whatsapp_leads(video_intent);
create index if not exists idx_whatsapp_leads_payment_intent on whatsapp_leads(payment_intent);
create index if not exists idx_whatsapp_leads_deposit_intent on whatsapp_leads(deposit_intent);
create index if not exists idx_whatsapp_leads_confirmation_intent on whatsapp_leads(confirmation_intent);
