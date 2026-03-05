alter table whatsapp_leads
  add column if not exists conversion_score int not null default 0;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'whatsapp_leads_conversion_score_check'
  ) then
    alter table whatsapp_leads
      add constraint whatsapp_leads_conversion_score_check check (conversion_score >= 0 and conversion_score <= 100);
  end if;
end
$$;
