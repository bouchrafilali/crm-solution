create table if not exists whatsapp_suggestion_feedback (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references whatsapp_leads(id) on delete cascade,
  source text not null,
  suggestion_type text,
  suggestion_text text not null,
  suggestion_payload jsonb,
  accepted boolean,
  final_text text,
  final_message_id uuid references whatsapp_lead_messages(id) on delete set null,
  outcome_label text check (outcome_label in ('NO_REPLY', 'REPLIED', 'PAYMENT_QUESTION', 'DEPOSIT_LINK_SENT', 'CONFIRMED', 'CONVERTED', 'LOST')),
  outcome_at timestamptz,
  review_status text not null default 'OPEN' check (review_status in ('OPEN', 'REVIEWED', 'ARCHIVED')),
  review_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_whatsapp_suggestion_feedback_lead on whatsapp_suggestion_feedback(lead_id, created_at desc);
create index if not exists idx_whatsapp_suggestion_feedback_status on whatsapp_suggestion_feedback(review_status, created_at desc);
create index if not exists idx_whatsapp_suggestion_feedback_outcome on whatsapp_suggestion_feedback(outcome_label, created_at desc);
