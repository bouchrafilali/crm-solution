do $$
begin
  begin
    alter type whatsapp_lead_stage add value if not exists 'PRODUCT_INTEREST';
  exception
    when duplicate_object then null;
  end;
end
$$;

