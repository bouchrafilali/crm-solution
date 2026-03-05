ajcreate extension if not exists pgcrypto;

alter table whatsapp_lead_messages add column if not exists provider text not null default 'manual';
alter table whatsapp_lead_messages add column if not exists message_type text not null default 'text';
alter table whatsapp_lead_messages add column if not exists external_id text;
alter table whatsapp_lead_messages alter column id set default gen_random_uuid();

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_name = 'whatsapp_lead_messages'
      and column_name = 'external_message_id'
  ) then
    execute '
      update whatsapp_lead_messages
      set external_id = external_message_id
      where external_id is null and external_message_id is not null
    ';
    execute 'alter table whatsapp_lead_messages drop column if exists external_message_id';
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'whatsapp_lead_messages_direction_check'
  ) then
    alter table whatsapp_lead_messages
      add constraint whatsapp_lead_messages_direction_check check (direction in ('IN','OUT'));
  end if;
end
$$;

create index if not exists idx_whatsapp_lead_messages_lead_created
  on whatsapp_lead_messages(lead_id, created_at desc);

create unique index if not exists idx_whatsapp_lead_messages_external_id_unique
  on whatsapp_lead_messages(external_id)
  where external_id is not null;
