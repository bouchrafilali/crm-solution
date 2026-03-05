delete from whatsapp_leads
where coalesce(inquiry_source, '') <> 'Zoko';

with ranked as (
  select
    id,
    row_number() over (
      partition by trim(phone_number)
      order by coalesce(last_activity_at, created_at) desc, created_at desc, id desc
    ) as rn
  from whatsapp_leads
  where trim(coalesce(phone_number, '')) <> ''
)
delete from whatsapp_leads w
using ranked r
where w.id = r.id and r.rn > 1;

create unique index if not exists idx_whatsapp_leads_phone_unique on whatsapp_leads(phone_number);

