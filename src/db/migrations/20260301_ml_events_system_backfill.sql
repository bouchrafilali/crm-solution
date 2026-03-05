do $$
begin
  alter table ml_events drop constraint if exists ml_events_source_check;
exception
  when undefined_table then
    null;
end$$;

alter table if exists ml_events
  add constraint ml_events_source_check
  check (
    source in (
      'OUTBOUND_TEMPLATE',
      'OUTBOUND_MANUAL',
      'OUTBOUND_SUGGESTION',
      'INBOUND',
      'SYSTEM',
      'SYSTEM_BACKFILL'
    )
  );
