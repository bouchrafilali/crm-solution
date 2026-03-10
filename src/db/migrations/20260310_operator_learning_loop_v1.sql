alter table if exists whatsapp_suggestion_feedback
  add column if not exists conversation_id uuid references whatsapp_leads(id) on delete set null,
  add column if not exists operator_id text,
  add column if not exists stage_before_reply text,
  add column if not exists stage_after_reply text,
  add column if not exists suggestion_status text not null default 'GENERATED',
  add column if not exists final_human_text text,
  add column if not exists was_ai_generated boolean not null default true,
  add column if not exists send_message_id uuid references whatsapp_lead_messages(id) on delete set null,
  add column if not exists generated_at timestamptz not null default now(),
  add column if not exists acted_at timestamptz,
  add column if not exists outcome_status text,
  add column if not exists outcome_evaluated_at timestamptz;

update whatsapp_suggestion_feedback
set conversation_id = coalesce(conversation_id, lead_id),
    final_human_text = coalesce(final_human_text, final_text),
    send_message_id = coalesce(send_message_id, final_message_id),
    generated_at = coalesce(generated_at, created_at)
where true;

do $$
begin
  alter table whatsapp_suggestion_feedback drop constraint if exists whatsapp_suggestion_feedback_suggestion_status_check;
exception
  when undefined_table then null;
end $$;

alter table whatsapp_suggestion_feedback
  add constraint whatsapp_suggestion_feedback_suggestion_status_check
  check (suggestion_status in ('GENERATED', 'ACCEPTED', 'EDITED', 'REJECTED', 'IGNORED', 'EXPIRED'));

do $$
begin
  alter table whatsapp_suggestion_feedback drop constraint if exists whatsapp_suggestion_feedback_outcome_status_check;
exception
  when undefined_table then null;
end $$;

alter table whatsapp_suggestion_feedback
  add constraint whatsapp_suggestion_feedback_outcome_status_check
  check (outcome_status in ('CLIENT_REPLIED', 'STAGE_ADVANCED', 'DEPOSIT_SIGNAL', 'CONVERTED', 'LOST', 'NO_RESPONSE_24H', 'NO_RESPONSE_72H', 'UNKNOWN'));

create index if not exists idx_whatsapp_suggestion_feedback_status_generated_at
  on whatsapp_suggestion_feedback(suggestion_status, generated_at desc);
create index if not exists idx_whatsapp_suggestion_feedback_outcome_status
  on whatsapp_suggestion_feedback(outcome_status, outcome_evaluated_at desc);
create index if not exists idx_whatsapp_suggestion_feedback_conversation
  on whatsapp_suggestion_feedback(conversation_id, generated_at desc);
create index if not exists idx_whatsapp_suggestion_feedback_send_message
  on whatsapp_suggestion_feedback(send_message_id);

create table if not exists whatsapp_suggestion_learning_signals (
  id uuid primary key default gen_random_uuid(),
  suggestion_feedback_id uuid not null references whatsapp_suggestion_feedback(id) on delete cascade,
  lead_id uuid not null references whatsapp_leads(id) on delete cascade,
  conversation_id uuid references whatsapp_leads(id) on delete set null,
  decision_type text not null check (decision_type in ('ACCEPTED', 'EDITED', 'REJECTED', 'MANUAL')),
  similarity_score numeric(6,5),
  edit_distance int,
  flags jsonb not null default '{}'::jsonb,
  outcome_positive boolean,
  outcome_status text,
  created_at timestamptz not null default now()
);

create index if not exists idx_whatsapp_suggestion_learning_signals_feedback
  on whatsapp_suggestion_learning_signals(suggestion_feedback_id, created_at desc);
create index if not exists idx_whatsapp_suggestion_learning_signals_lead
  on whatsapp_suggestion_learning_signals(lead_id, created_at desc);
create index if not exists idx_whatsapp_suggestion_learning_signals_decision
  on whatsapp_suggestion_learning_signals(decision_type, created_at desc);

-- Extend ml_events enums for operator learning loop events.
do $$
begin
  alter table ml_events drop constraint if exists ml_events_event_type_check;
exception
  when undefined_table then null;
end $$;

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
      'MESSAGE_PERSISTED',
      'INFERENCE',
      'SUGGESTION_GENERATED',
      'SUGGESTION_ACCEPTED',
      'SUGGESTION_EDITED',
      'SUGGESTION_IGNORED',
      'MANUAL_REPLY_SENT'
    )
  );
