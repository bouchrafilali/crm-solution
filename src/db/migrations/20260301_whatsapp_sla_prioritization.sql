alter table whatsapp_leads
  add column if not exists sla_due_at timestamptz;

alter table whatsapp_leads
  add column if not exists sla_status text not null default 'OK';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'whatsapp_leads_sla_status_check'
  ) then
    alter table whatsapp_leads
      add constraint whatsapp_leads_sla_status_check
      check (sla_status in ('OK', 'DUE_SOON', 'BREACHED'));
  end if;
end
$$;
