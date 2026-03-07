create table if not exists whatsapp_operator_events (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references whatsapp_leads(id) on delete cascade,
  surface text not null check (surface in ('priority_desk', 'reactivation_queue', 'mobile_lab', 'chat')),
  feed_type text check (feed_type in ('active', 'reactivation')),
  action_type text not null check (
    action_type in (
      'feed_item_opened',
      'feed_item_skipped',
      'feed_item_unskipped',
      'reply_card_inserted',
      'reply_card_sent',
      'reply_card_dismissed',
      'reactivation_card_inserted',
      'reactivation_card_sent',
      'reactivation_card_dismissed'
    )
  ),
  stage text,
  recommended_action text,
  card_label text,
  card_intent text,
  mode text,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_whatsapp_operator_events_lead_created_at on whatsapp_operator_events(lead_id, created_at desc);
create index if not exists idx_whatsapp_operator_events_surface_created_at on whatsapp_operator_events(surface, created_at desc);
create index if not exists idx_whatsapp_operator_events_action_created_at on whatsapp_operator_events(action_type, created_at desc);
