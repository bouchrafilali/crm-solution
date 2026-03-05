do $$
begin
  begin
    alter type whatsapp_lead_stage add value if not exists 'CONFIRMED';
  exception when duplicate_object then null;
  end;
end
$$;

alter table whatsapp_leads add column if not exists stage_auto_source_message_id text;
alter table whatsapp_leads add column if not exists stage_auto_confidence int;
alter table whatsapp_leads add column if not exists stage_auto_updated_at timestamptz;
alter table whatsapp_leads add column if not exists shopify_order_id text;
alter table whatsapp_leads add column if not exists shopify_financial_status text;
alter table whatsapp_leads add column if not exists deposit_paid boolean not null default false;
alter table whatsapp_leads add column if not exists converted_at timestamptz;

alter table stage_rules drop constraint if exists stage_rules_recommended_stage_check;
alter table stage_rules
  add constraint stage_rules_recommended_stage_check
  check (recommended_stage in ('NEW','PRODUCT_INTEREST','QUALIFICATION_PENDING','QUALIFIED','PRICE_SENT','VIDEO_PROPOSED','DEPOSIT_PENDING','CONFIRMED','CONVERTED','LOST'));

alter table reply_templates drop constraint if exists reply_templates_stage_check;
alter table reply_templates
  add constraint reply_templates_stage_check
  check (stage in ('NEW','PRODUCT_INTEREST','QUALIFICATION_PENDING','QUALIFIED','PRICE_SENT','VIDEO_PROPOSED','DEPOSIT_PENDING','CONFIRMED','CONVERTED','LOST'));
