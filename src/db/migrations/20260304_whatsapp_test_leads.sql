alter table whatsapp_leads
  add column if not exists is_test boolean not null default false;

alter table whatsapp_leads
  add column if not exists test_tag text;

create index if not exists idx_whatsapp_leads_is_test on whatsapp_leads(is_test);
