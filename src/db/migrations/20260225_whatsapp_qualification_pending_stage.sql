do $$
begin
  begin
    alter type whatsapp_lead_stage add value if not exists 'QUALIFICATION_PENDING';
  exception
    when duplicate_object then null;
  end;
end
$$;

