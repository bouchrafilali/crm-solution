do $$
begin
  alter table ml_events drop constraint if exists ml_events_event_type_check;
  alter table ml_events drop constraint if exists ml_events_source_check;
exception
  when undefined_table then
    null;
end$$;

alter table if exists ml_events
  add constraint ml_events_event_type_check
  check (
    event_type in (
      'RULE_TRIGGERED',
      'MODEL_PREDICTION',
      'SUGGESTIONS_GENERATED',
      'SUGGESTION_USED',
      'SUGGESTION_REJECTED',
      'AUTO_STAGE_CHANGE',
      'MESSAGE_PERSISTED'
    )
  );

alter table if exists ml_events
  add constraint ml_events_source_check
  check (
    source in (
      'OUTBOUND_TEMPLATE',
      'OUTBOUND_MANUAL',
      'OUTBOUND_SUGGESTION',
      'INBOUND',
      'SYSTEM'
    )
  );
