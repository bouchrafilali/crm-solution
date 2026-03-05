alter table whatsapp_lead_messages add column if not exists external_message_id text;

create unique index if not exists idx_whatsapp_lead_messages_external_id_unique
  on whatsapp_lead_messages(external_message_id)
  where external_message_id is not null;

