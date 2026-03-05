export const DB_SCHEMA_SQL = `
create extension if not exists pgcrypto;

create table if not exists orders (
  id text primary key,
  name text not null,
  created_at timestamptz not null,
  customer_id text,
  customer_label text,
  customer_email text,
  customer_phone text,
  currency text not null,
  total_amount numeric(12,2) not null,
  outstanding_amount numeric(12,2) not null,
  financial_status text,
  shipping_status text,
  payment_gateway text,
  order_location text,
  raw jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists order_items (
  id bigserial primary key,
  order_id text not null references orders(id) on delete cascade,
  line_id text not null,
  title text not null,
  quantity int not null,
  unit_price numeric(12,2) not null,
  status text,
  unique(order_id, line_id)
);

create table if not exists order_payments (
  id bigserial primary key,
  order_id text not null references orders(id) on delete cascade,
  gateway text not null,
  amount numeric(12,2) not null,
  currency text not null,
  occurred_at timestamptz
);

create index if not exists idx_orders_created_at on orders(created_at);
create index if not exists idx_order_items_order_id on order_items(order_id);
create index if not exists idx_order_payments_order_id on order_payments(order_id);

create table if not exists forecast_runs (
  id bigserial primary key,
  horizon_days int not null,
  mode text not null,
  model_name text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_forecast_runs_created_at on forecast_runs(created_at desc);

create table if not exists forecast_v3_runs (
  id bigserial primary key,
  horizon_days int not null,
  mode text not null default 'v3',
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_forecast_v3_runs_created_at on forecast_v3_runs(created_at desc);

create table if not exists appointments (
  id text primary key,
  shop text not null,
  customer_name text not null,
  customer_phone text not null,
  customer_email text,
  appointment_at timestamptz not null,
  status text not null default 'scheduled',
  location text,
  notes text,
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists appointment_messages (
  id bigserial primary key,
  appointment_id text not null references appointments(id) on delete cascade,
  shop text not null,
  direction text not null default 'outbound',
  channel text not null default 'whatsapp',
  message_type text,
  template_name text,
  payload jsonb,
  provider_status text,
  sent_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists idx_appointment_messages_appointment on appointment_messages(appointment_id, sent_at desc);
create index if not exists idx_appointment_messages_shop on appointment_messages(shop, created_at desc);

alter table appointments add column if not exists end_at timestamptz;
alter table appointments add column if not exists type text;
alter table appointments add column if not exists duration_minutes int;
alter table appointments add column if not exists order_id text;
alter table appointments add column if not exists order_name text;
alter table appointments add column if not exists order_total_amount numeric(12,2);
alter table appointments add column if not exists order_currency text;
alter table appointments add column if not exists shopify_order_id text;
alter table appointments add column if not exists order_status text;
alter table appointments add column if not exists reminder_d1_enabled boolean;
alter table appointments add column if not exists reminder_h3_enabled boolean;
alter table appointments add column if not exists reminder_designer_enabled boolean;
alter table appointments add column if not exists reminder_d1_sent_at timestamptz;
alter table appointments add column if not exists reminder_h3_sent_at timestamptz;
alter table appointments add column if not exists reminder_designer_sent_at timestamptz;

update appointments
set
  shopify_order_id = coalesce(shopify_order_id, order_id),
  order_status = coalesce(order_status, case when coalesce(shopify_order_id, order_id) is not null then 'active' else order_status end),
  type = coalesce(nullif(type, ''), 'fitting'),
  duration_minutes = coalesce(duration_minutes, 60),
  end_at = coalesce(end_at, appointment_at + make_interval(mins => coalesce(duration_minutes, 60))),
  reminder_d1_enabled = coalesce(reminder_d1_enabled, true),
  reminder_h3_enabled = coalesce(reminder_h3_enabled, true),
  reminder_designer_enabled = coalesce(reminder_designer_enabled, true)
where
  end_at is null
  or duration_minutes is null
  or type is null
  or reminder_d1_enabled is null
  or reminder_h3_enabled is null
  or reminder_designer_enabled is null;

alter table appointments alter column type set default 'fitting';
alter table appointments alter column type set not null;
alter table appointments alter column duration_minutes set default 60;
alter table appointments alter column duration_minutes set not null;
alter table appointments alter column reminder_d1_enabled set default true;
alter table appointments alter column reminder_d1_enabled set not null;
alter table appointments alter column reminder_h3_enabled set default true;
alter table appointments alter column reminder_h3_enabled set not null;
alter table appointments alter column reminder_designer_enabled set default true;
alter table appointments alter column reminder_designer_enabled set not null;

create index if not exists idx_appointments_shop_time on appointments(shop, appointment_at desc);
create index if not exists idx_appointments_shop_time_window on appointments(shop, appointment_at, end_at);
create index if not exists idx_appointments_shop_location on appointments(shop, location, appointment_at);
create index if not exists idx_appointments_shopify_order_id on appointments(shopify_order_id);

update appointments
set
  shopify_order_id = order_id
where
  shopify_order_id is null
  and order_id is not null;

do $$
begin
  create type whatsapp_lead_stage as enum (
    'NEW',
    'PRODUCT_INTEREST',
    'QUALIFICATION_PENDING',
    'PRICE_SENT',
    'QUALIFIED',
    'VIDEO_PROPOSED',
    'DEPOSIT_PENDING',
    'CONFIRMED',
    'CONVERTED',
    'LOST'
  );
exception
  when duplicate_object then null;
end
$$;

create table if not exists whatsapp_leads (
  id uuid primary key,
  shop text,
  client_name text not null,
  phone_number text not null,
  profile_image_url text,
  channel_type text not null default 'API' check (channel_type in ('API', 'SHARED')),
  ai_mode text not null default 'ACTIVE' check (ai_mode in ('ACTIVE', 'ANALYZE_ONLY')),
  country text,
  inquiry_source text,
  product_reference text,
  price_sent boolean not null default false,
  production_time_sent boolean not null default false,
  stage whatsapp_lead_stage not null default 'NEW',
  last_message_at timestamptz,
  last_activity_at timestamptz,
  first_response_time_minutes int,
  internal_notes text,
  qualification_tags text[] not null default '{}',
  intent_level text,
  stage_confidence numeric(5,4),
  stage_auto boolean not null default false,
  stage_auto_reason text,
  stage_auto_source_message_id text,
  stage_auto_confidence int,
  stage_auto_updated_at timestamptz,
  follow_up_48_sent boolean not null default false,
  follow_up_72_sent boolean not null default false,
  sla_due_at timestamptz,
  sla_status text not null default 'OK',
  conversion_value numeric(12,2),
  ticket_value numeric,
  ticket_currency text,
  conversion_score int not null default 0,
  converted_at timestamptz,
  conversion_source text,
  shopify_order_id text,
  shopify_financial_status text,
  payment_received boolean not null default false,
  deposit_paid boolean not null default false,
  marketing_opt_in boolean not null default false,
  marketing_opt_in_source text,
  marketing_opt_in_at timestamptz,
  event_date date,
  event_date_text text,
  event_date_confidence int,
  event_date_source_message_id text,
  event_date_updated_at timestamptz,
  event_date_manual boolean not null default false,
  price_intent boolean not null default false,
  video_intent boolean not null default false,
  payment_intent boolean not null default false,
  deposit_intent boolean not null default false,
  confirmation_intent boolean not null default false,
  is_test boolean not null default false,
  test_tag text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table whatsapp_leads add column if not exists has_product_interest boolean not null default false;
alter table whatsapp_leads add column if not exists has_price_sent boolean not null default false;
alter table whatsapp_leads add column if not exists has_video_proposed boolean not null default false;
alter table whatsapp_leads add column if not exists has_payment_question boolean not null default false;
alter table whatsapp_leads add column if not exists has_deposit_link_sent boolean not null default false;
alter table whatsapp_leads add column if not exists chat_confirmed boolean not null default false;
alter table whatsapp_leads add column if not exists last_signal_at timestamptz;
alter table whatsapp_leads add column if not exists product_interest_source_message_id text;
alter table whatsapp_leads add column if not exists price_sent_source_message_id text;
alter table whatsapp_leads add column if not exists video_proposed_source_message_id text;
alter table whatsapp_leads add column if not exists payment_question_source_message_id text;
alter table whatsapp_leads add column if not exists deposit_link_source_message_id text;
alter table whatsapp_leads add column if not exists chat_confirmed_source_message_id text;
alter table whatsapp_leads add column if not exists is_test boolean not null default false;
alter table whatsapp_leads add column if not exists test_tag text;

create table if not exists whatsapp_lead_messages (
  id uuid primary key,
  lead_id uuid not null references whatsapp_leads(id) on delete cascade,
  direction text not null check (direction in ('IN','OUT')),
  text text not null,
  provider text not null default 'manual',
  message_type text not null default 'text',
  template_name text,
  external_id text,
  metadata jsonb,
  created_at timestamptz not null default now()
);

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

create table if not exists ai_insights (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references whatsapp_leads(id) on delete cascade,
  intents jsonb not null default '{}'::jsonb,
  suggested_replies jsonb not null default '[]'::jsonb,
  proposed_stage text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_ai_insights_conversation on ai_insights(conversation_id, created_at desc);

create table if not exists suggestion_learning_settings (
  id int primary key default 1 check (id = 1),
  learning_window_days int not null default 90,
  min_samples int not null default 3,
  success_weight int not null default 20,
  accepted_weight int not null default 10,
  lost_weight int not null default 14,
  boost_min int not null default -15,
  boost_max int not null default 20,
  success_outcomes text[] not null default '{"CONFIRMED","CONVERTED"}',
  failure_outcomes text[] not null default '{"LOST"}',
  updated_at timestamptz not null default now()
);

create table if not exists whatsapp_templates (
  id text primary key,
  name text not null,
  category text,
  language text,
  components jsonb,
  variables_count int not null default 0,
  raw jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists whatsapp_templates_cache (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null check (category in ('UTILITY','MARKETING','AUTHENTICATION')),
  language text not null,
  components jsonb,
  variables_count int not null default 0,
  updated_at timestamptz not null default now(),
  unique(name, language)
);

create table if not exists product_previews_cache (
  id uuid primary key default gen_random_uuid(),
  handle text not null unique,
  title text,
  image_url text,
  product_url text,
  updated_at timestamptz not null default now()
);

create table if not exists whatsapp_template_favorites (
  id uuid primary key default gen_random_uuid(),
  template_name text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists whatsapp_lead_events (
  id bigserial primary key,
  lead_id uuid not null references whatsapp_leads(id) on delete cascade,
  shop text,
  event_type text not null,
  payload jsonb,
  created_at timestamptz not null default now()
);

create table if not exists lead_conversion_metrics (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null unique references whatsapp_leads(id) on delete cascade,
  ticket_value numeric,
  total_messages int not null default 0,
  first_response_delay_minutes int,
  avg_response_delay_minutes int,
  price_sent_delay_minutes int,
  suggestion_used boolean not null default false,
  template_used boolean not null default false,
  follow_up_triggered boolean not null default false,
  video_proposed boolean not null default false,
  conversion_probability_at_price int,
  country text,
  created_at timestamptz not null default now()
);

create index if not exists idx_lead_conversion_metrics_created_at on lead_conversion_metrics(created_at desc);
create index if not exists idx_lead_conversion_metrics_country on lead_conversion_metrics(country);

create table if not exists lead_scoring_factors (
  lead_id uuid primary key references whatsapp_leads(id) on delete cascade,
  score int not null default 0,
  factors jsonb not null default '{}'::jsonb,
  computed_at timestamptz not null default now()
);

create table if not exists ai_agent_runs (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references whatsapp_leads(id) on delete cascade,
  message_id uuid not null references whatsapp_lead_messages(id) on delete cascade,
  status text not null check (status in ('queued', 'success', 'error')),
  trigger_source text,
  model text,
  latency_ms int,
  tokens_in int,
  tokens_out int,
  prompt_text text not null,
  response_json jsonb,
  error_text text,
  created_at timestamptz not null default now()
);

create index if not exists idx_lead_scoring_factors_computed_at on lead_scoring_factors(computed_at desc);
create index if not exists idx_ai_agent_runs_lead_created on ai_agent_runs(lead_id, created_at desc);
create index if not exists idx_ai_agent_runs_message on ai_agent_runs(message_id);
create index if not exists idx_ai_agent_runs_lead_status_created on ai_agent_runs(lead_id, status, created_at desc);

create table if not exists lead_price_quotes (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references whatsapp_leads(id) on delete cascade,
  message_id uuid not null references whatsapp_lead_messages(id) on delete cascade,
  amount numeric not null,
  currency text not null check (currency in ('USD', 'EUR', 'MAD')),
  formatted text not null,
  product_title text,
  product_handle text,
  qty int not null default 1 check (qty > 0),
  confidence int not null default 70 check (confidence >= 0 and confidence <= 100),
  created_at timestamptz not null default now()
);

create table if not exists quote_requests (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references whatsapp_leads(id) on delete cascade,
  product_handle text not null,
  product_title text not null,
  product_image_url text,
  availability jsonb not null default '{}'::jsonb,
  price_options jsonb not null default '[]'::jsonb,
  status text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'REJECTED')),
  approved_option_id text,
  approved_price_amount numeric,
  approved_currency text,
  approved_availability boolean,
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists quote_actions (
  id uuid primary key default gen_random_uuid(),
  quote_request_id uuid not null references quote_requests(id) on delete cascade,
  action_type text not null check (
    action_type in ('APPROVE_PRICE', 'REQUEST_PRICE_EDIT', 'MARK_READY_PIECE', 'PRICE_OVERRIDE', 'MARK_OOS', 'SEND_TO_CLIENT')
  ),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists quote_approval_metrics (
  id uuid primary key default gen_random_uuid(),
  quote_request_id uuid not null references quote_requests(id) on delete cascade,
  decision_time_seconds int not null check (decision_time_seconds >= 0),
  approved boolean not null,
  created_at timestamptz not null default now()
);

create table if not exists ai_settings (
  id int primary key default 1 check (id = 1),
  default_language text not null default 'AUTO' check (default_language in ('AUTO', 'FR', 'EN')),
  tone text not null default 'QUIET_LUXURY' check (tone in ('FORMEL', 'QUIET_LUXURY', 'DIRECT')),
  message_length text not null default 'SHORT' check (message_length in ('SHORT', 'MEDIUM')),
  include_price_policy text not null default 'AFTER_QUALIFIED' check (include_price_policy in ('NEVER_FIRST', 'AFTER_QUALIFIED')),
  include_video_call text not null default 'WHEN_HIGH_INTENT' check (include_video_call in ('NEVER', 'WHEN_HIGH_INTENT', 'ALWAYS')),
  urgency_style text not null default 'SUBTLE' check (urgency_style in ('SUBTLE', 'NEUTRAL')),
  no_emojis boolean not null default true,
  avoid_follow_up_phrase boolean not null default true,
  signature_enabled boolean not null default false,
  signature_text text,
  updated_at timestamptz not null default now()
);

create table if not exists ai_settings_global (
  id int primary key default 1 check (id = 1),
  tone text not null default 'QUIET_LUXURY' check (tone in ('FORMEL', 'QUIET_LUXURY', 'DIRECT')),
  message_length text not null default 'SHORT' check (message_length in ('SHORT', 'MEDIUM')),
  no_emojis boolean not null default true,
  avoid_follow_up_phrase boolean not null default true,
  signature_enabled boolean not null default false,
  signature_text text,
  updated_at timestamptz not null default now()
);

create table if not exists ai_settings_by_country_group (
  country_group text primary key check (country_group in ('MA', 'FR', 'INTL')),
  language text not null default 'AUTO' check (language in ('AUTO', 'FR', 'EN')),
  price_policy text not null default 'AFTER_QUALIFIED' check (price_policy in ('NEVER_FIRST', 'AFTER_QUALIFIED')),
  video_policy text not null default 'WHEN_HIGH_INTENT' check (video_policy in ('NEVER', 'WHEN_HIGH_INTENT', 'ALWAYS')),
  urgency_style text not null default 'SUBTLE' check (urgency_style in ('SUBTLE', 'NEUTRAL')),
  followup_delay_hours int not null default 48,
  updated_at timestamptz not null default now()
);

create table if not exists keyword_rules (
  id uuid primary key default gen_random_uuid(),
  language text not null check (language in ('FR', 'EN')),
  tag text not null check (tag in ('PRICE_REQUEST','EVENT_DATE','SHIPPING','SIZING','RESERVATION_INTENT','PAYMENT','VIDEO_INTEREST','URGENCY','PRODUCT_LINK','INTEREST')),
  keywords text[] not null default '{}',
  patterns text[] not null default '{}',
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists stage_rules (
  id uuid primary key default gen_random_uuid(),
  rule_name text not null,
  required_tags text[] not null default '{}',
  forbidden_tags text[] not null default '{}',
  recommended_stage text not null check (recommended_stage in ('NEW','PRODUCT_INTEREST','QUALIFICATION_PENDING','QUALIFIED','PRICE_SENT','VIDEO_PROPOSED','DEPOSIT_PENDING','CONFIRMED','CONVERTED','LOST')),
  priority int not null default 100,
  enabled boolean not null default true
);

create table if not exists reply_templates (
  id uuid primary key default gen_random_uuid(),
  stage text not null check (stage in ('NEW','PRODUCT_INTEREST','QUALIFICATION_PENDING','QUALIFIED','PRICE_SENT','VIDEO_PROPOSED','DEPOSIT_PENDING','CONFIRMED','CONVERTED','LOST')),
  language text not null check (language in ('FR', 'EN')),
  country_group text check (country_group in ('MA', 'FR', 'INTL')),
  template_name text not null,
  text text not null,
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists stage_template_suggestions (
  id uuid primary key default gen_random_uuid(),
  stage text not null check (stage in ('NEW','PRODUCT_INTEREST','QUALIFICATION_PENDING','QUALIFIED','PRICE_SENT','VIDEO_PROPOSED','DEPOSIT_PENDING','CONFIRMED','CONVERTED','LOST')),
  template_name text not null,
  priority int not null default 100,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(stage, template_name)
);

alter table whatsapp_leads add column if not exists last_activity_at timestamptz;
alter table whatsapp_leads add column if not exists profile_image_url text;
alter table whatsapp_leads add column if not exists channel_type text not null default 'API';
alter table whatsapp_leads add column if not exists ai_mode text not null default 'ACTIVE';
alter table whatsapp_leads add column if not exists internal_notes text;
alter table whatsapp_leads add column if not exists qualification_tags text[] not null default '{}';
alter table whatsapp_leads add column if not exists intent_level text;
alter table whatsapp_leads add column if not exists stage_confidence numeric(5,4);
alter table whatsapp_leads add column if not exists stage_auto boolean not null default false;
alter table whatsapp_leads add column if not exists stage_auto_reason text;
alter table whatsapp_leads add column if not exists stage_auto_source_message_id text;
alter table whatsapp_leads add column if not exists stage_auto_confidence int;
alter table whatsapp_leads add column if not exists stage_auto_updated_at timestamptz;
alter table whatsapp_leads add column if not exists recommended_stage whatsapp_lead_stage;
alter table whatsapp_leads add column if not exists recommended_stage_reason text;
alter table whatsapp_leads add column if not exists recommended_stage_confidence numeric(5,4);
alter table whatsapp_leads add column if not exists detected_signals jsonb not null default '{}'::jsonb;
alter table whatsapp_leads add column if not exists converted_at timestamptz;
alter table whatsapp_leads add column if not exists conversion_source text;
alter table whatsapp_leads add column if not exists sla_due_at timestamptz;
alter table whatsapp_leads add column if not exists sla_status text not null default 'OK';
alter table whatsapp_leads add column if not exists ticket_value numeric;
alter table whatsapp_leads add column if not exists ticket_currency text;
alter table whatsapp_leads add column if not exists conversion_score int not null default 0;
alter table whatsapp_leads add column if not exists shopify_order_id text;
alter table whatsapp_leads add column if not exists shopify_financial_status text;
alter table whatsapp_leads add column if not exists payment_received boolean not null default false;
alter table whatsapp_leads add column if not exists deposit_paid boolean not null default false;
alter table whatsapp_leads add column if not exists marketing_opt_in boolean not null default false;
alter table whatsapp_leads add column if not exists marketing_opt_in_source text;
alter table whatsapp_leads add column if not exists marketing_opt_in_at timestamptz;
alter table whatsapp_leads add column if not exists event_date date;
alter table whatsapp_leads add column if not exists event_date_text text;
alter table whatsapp_leads add column if not exists event_date_confidence int;
alter table whatsapp_leads add column if not exists event_date_source_message_id text;
alter table whatsapp_leads add column if not exists event_date_updated_at timestamptz;
alter table whatsapp_leads add column if not exists event_date_manual boolean not null default false;
alter table whatsapp_leads add column if not exists ship_city text;
alter table whatsapp_leads add column if not exists ship_region text;
alter table whatsapp_leads add column if not exists ship_country text;
alter table whatsapp_leads add column if not exists ship_destination_text text;
alter table whatsapp_leads add column if not exists ship_destination_confidence int;
alter table whatsapp_leads add column if not exists ship_destination_source_message_id text;
alter table whatsapp_leads add column if not exists ship_destination_updated_at timestamptz;
alter table whatsapp_leads add column if not exists ship_destination_manual boolean not null default false;
alter table whatsapp_leads add column if not exists price_intent boolean not null default false;
alter table whatsapp_leads add column if not exists video_intent boolean not null default false;
alter table whatsapp_leads add column if not exists payment_intent boolean not null default false;
alter table whatsapp_leads add column if not exists deposit_intent boolean not null default false;
alter table whatsapp_leads add column if not exists confirmation_intent boolean not null default false;
alter table whatsapp_lead_messages add column if not exists provider text not null default 'manual';
alter table whatsapp_lead_messages add column if not exists message_type text not null default 'text';
alter table whatsapp_lead_messages add column if not exists template_name text;
alter table whatsapp_lead_messages add column if not exists external_id text;
alter table whatsapp_lead_messages add column if not exists metadata jsonb;
alter table whatsapp_lead_messages alter column id set default gen_random_uuid();

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'whatsapp_leads_channel_type_check'
  ) then
    alter table whatsapp_leads
      add constraint whatsapp_leads_channel_type_check check (channel_type in ('API', 'SHARED'));
  end if;
  if not exists (
    select 1
    from pg_constraint
    where conname = 'whatsapp_leads_ai_mode_check'
  ) then
    alter table whatsapp_leads
      add constraint whatsapp_leads_ai_mode_check check (ai_mode in ('ACTIVE', 'ANALYZE_ONLY'));
  end if;
end
$$;

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

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'whatsapp_leads_sla_status_check'
  ) then
    alter table whatsapp_leads
      add constraint whatsapp_leads_sla_status_check check (sla_status in ('OK', 'DUE_SOON', 'BREACHED'));
  end if;
end
$$;

update whatsapp_leads
set ai_mode = 'ANALYZE_ONLY'
where coalesce(channel_type, 'API') = 'SHARED';

update whatsapp_leads
set ai_mode = 'ACTIVE'
where coalesce(channel_type, 'API') = 'API'
  and coalesce(ai_mode, '') <> 'ACTIVE';

do $$
begin
  begin
    alter type whatsapp_lead_stage add value if not exists 'PRODUCT_INTEREST';
  exception
    when duplicate_object then null;
  end;
  begin
    alter type whatsapp_lead_stage add value if not exists 'QUALIFICATION_PENDING';
  exception
    when duplicate_object then null;
  end;

  if exists (
    select 1
    from information_schema.columns
    where table_name = 'whatsapp_lead_messages'
      and column_name = 'external_message_id'
  ) then
    execute '
      update whatsapp_lead_messages
      set external_id = external_message_id
      where external_id is null and external_message_id is not null
    ';
    execute 'alter table whatsapp_lead_messages drop column if exists external_message_id';
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'whatsapp_lead_messages_direction_check'
  ) then
    alter table whatsapp_lead_messages
      add constraint whatsapp_lead_messages_direction_check check (direction in ('IN','OUT'));
  end if;
end
$$;

do $$
begin
  begin
    alter type whatsapp_lead_stage add value if not exists 'CONFIRMED';
  exception when duplicate_object then null;
  end;
end
$$;

create index if not exists idx_whatsapp_leads_stage on whatsapp_leads(stage);
create index if not exists idx_whatsapp_leads_created_at on whatsapp_leads(created_at desc);
create index if not exists idx_whatsapp_leads_phone_number on whatsapp_leads(phone_number);
create index if not exists idx_whatsapp_leads_last_activity_at on whatsapp_leads(last_activity_at desc);
create index if not exists idx_whatsapp_leads_has_product_interest on whatsapp_leads(has_product_interest);
create index if not exists idx_whatsapp_leads_has_price_sent on whatsapp_leads(has_price_sent);
create index if not exists idx_whatsapp_leads_has_video_proposed on whatsapp_leads(has_video_proposed);
create index if not exists idx_whatsapp_leads_has_payment_question on whatsapp_leads(has_payment_question);
create index if not exists idx_whatsapp_leads_has_deposit_link_sent on whatsapp_leads(has_deposit_link_sent);
create index if not exists idx_whatsapp_leads_chat_confirmed on whatsapp_leads(chat_confirmed);
create index if not exists idx_whatsapp_leads_last_signal_at on whatsapp_leads(last_signal_at desc);
create index if not exists idx_whatsapp_leads_shop_created_at on whatsapp_leads(shop, created_at desc);
create index if not exists idx_whatsapp_leads_is_test on whatsapp_leads(is_test);
create index if not exists idx_whatsapp_lead_events_lead_id on whatsapp_lead_events(lead_id, created_at desc);
create index if not exists idx_whatsapp_lead_messages_lead_created on whatsapp_lead_messages(lead_id, created_at desc);
create unique index if not exists idx_whatsapp_lead_messages_external_id_unique on whatsapp_lead_messages(external_id) where external_id is not null;
create index if not exists idx_lead_price_quotes_lead_created on lead_price_quotes(lead_id, created_at desc);
create index if not exists idx_lead_price_quotes_lead_product_handle on lead_price_quotes(lead_id, product_handle);
create index if not exists idx_lead_price_quotes_message_id on lead_price_quotes(message_id);
create unique index if not exists idx_lead_price_quotes_dedupe
  on lead_price_quotes(lead_id, message_id, amount, currency, product_handle, qty);
create index if not exists idx_quote_requests_lead_created on quote_requests(lead_id, created_at desc);
create index if not exists idx_quote_requests_status_created on quote_requests(status, created_at desc);
create index if not exists idx_quote_actions_request_created on quote_actions(quote_request_id, created_at);
create index if not exists idx_quote_approval_metrics_created on quote_approval_metrics(created_at desc);
create index if not exists idx_quote_approval_metrics_quote_request on quote_approval_metrics(quote_request_id);
create index if not exists idx_whatsapp_templates_cache_updated_at on whatsapp_templates_cache(updated_at desc);
create index if not exists idx_product_previews_cache_updated_at on product_previews_cache(updated_at desc);
create index if not exists idx_whatsapp_template_favorites_template_name on whatsapp_template_favorites(template_name);

insert into ai_settings (id)
values (1)
on conflict (id) do nothing;

insert into suggestion_learning_settings (id)
values (1)
on conflict (id) do nothing;

update whatsapp_leads
set last_activity_at = coalesce(last_activity_at, last_message_at, created_at)
where last_activity_at is null;

update whatsapp_leads l
set product_reference = (
  select substring(m.text from 'https?://[^[:space:]''"<>]*?/products/[^[:space:]''"<>]*')
  from whatsapp_lead_messages m
  where m.lead_id = l.id
    and m.direction = 'IN'
    and m.text ~* '/products/'
  order by m.created_at desc
  limit 1
)
where nullif(trim(coalesce(l.product_reference, '')), '') is null
  and exists (
    select 1
    from whatsapp_lead_messages m2
    where m2.lead_id = l.id
      and m2.direction = 'IN'
      and m2.text ~* '/products/'
  );

update whatsapp_leads
set country = case
  when regexp_replace(coalesce(phone_number, ''), '[^0-9]', '', 'g') like '212%' then 'MA'
  when regexp_replace(coalesce(phone_number, ''), '[^0-9]', '', 'g') like '33%' then 'FR'
  when regexp_replace(coalesce(phone_number, ''), '[^0-9]', '', 'g') like '971%' then 'AE'
  when regexp_replace(coalesce(phone_number, ''), '[^0-9]', '', 'g') like '966%' then 'SA'
  when regexp_replace(coalesce(phone_number, ''), '[^0-9]', '', 'g') like '965%' then 'KW'
  when regexp_replace(coalesce(phone_number, ''), '[^0-9]', '', 'g') like '974%' then 'QA'
  when regexp_replace(coalesce(phone_number, ''), '[^0-9]', '', 'g') like '973%' then 'BH'
  when regexp_replace(coalesce(phone_number, ''), '[^0-9]', '', 'g') like '968%' then 'OM'
  when regexp_replace(coalesce(phone_number, ''), '[^0-9]', '', 'g') like '44%' then 'GB'
  when regexp_replace(coalesce(phone_number, ''), '[^0-9]', '', 'g') like '1%' then 'US'
  else country
end
where nullif(trim(coalesce(country, '')), '') is null;

delete from whatsapp_leads
where coalesce(inquiry_source, '') <> 'Zoko'
  and coalesce(channel_type, 'API') <> 'SHARED';

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
create index if not exists idx_keyword_rules_language_tag on keyword_rules(language, tag);
create index if not exists idx_stage_rules_priority on stage_rules(priority asc);
create index if not exists idx_reply_templates_lookup on reply_templates(stage, language, country_group, enabled);
create index if not exists idx_stage_template_suggestions_stage on stage_template_suggestions(stage, enabled, priority asc);

insert into ai_settings_global (id)
values (1)
on conflict (id) do nothing;

insert into ai_settings_by_country_group (country_group, language, price_policy, video_policy, urgency_style, followup_delay_hours)
values
  ('MA', 'AUTO', 'AFTER_QUALIFIED', 'WHEN_HIGH_INTENT', 'SUBTLE', 48),
  ('FR', 'FR', 'AFTER_QUALIFIED', 'WHEN_HIGH_INTENT', 'SUBTLE', 48),
  ('INTL', 'EN', 'AFTER_QUALIFIED', 'WHEN_HIGH_INTENT', 'NEUTRAL', 48)
on conflict (country_group) do nothing;

insert into keyword_rules (language, tag, keywords, patterns, enabled)
values
  ('FR','PRICE_REQUEST',array['prix','combien','tarif'],array['\\bprix\\b','\\bcombien\\b'],true),
  ('FR','EVENT_DATE',array['mariage','date','avril','mai'],array['\\bdans\\s+\\d+\\s+semaines?\\b'],true),
  ('FR','SHIPPING',array['livraison','france','paris','international'],array['\\blivraison\\b'],true),
  ('FR','SIZING',array['taille','mesure','tour de poitrine'],array['\\btaille\\b'],true),
  ('FR','RESERVATION_INTENT',array['réserver','réservation','tenir'],array['\\br[ée]serv'],true),
  ('FR','PAYMENT',array['acompte','payer','paiement'],array['\\bacompte\\b'],true),
  ('FR','VIDEO_INTEREST',array['visio','appel vidéo','video call'],array['\\bvisio\\b'],true),
  ('FR','URGENCY',array['urgent','semaine prochaine'],array['\\burgent\\b'],true),
  ('FR','PRODUCT_LINK',array['/products/'],array['\\/products\\/'],true),
  ('FR','INTEREST',array['intéressé','je veux','j''aime'],array['\\bint[ée]ress[ée]?\\b'],true),
  ('EN','PRICE_REQUEST',array['price','how much','cost'],array['\\bprice\\b','\\bhow\\s+much\\b'],true),
  ('EN','EVENT_DATE',array['wedding','date','next week'],array['\\bin\\s+\\d+\\s+weeks?\\b'],true),
  ('EN','SHIPPING',array['shipping','france','paris','international'],array['\\bshipping\\b'],true),
  ('EN','SIZING',array['size','measurement','measurements'],array['\\bsize\\b'],true),
  ('EN','RESERVATION_INTENT',array['reserve','reservation','book'],array['\\breserv'],true),
  ('EN','PAYMENT',array['deposit','pay','payment'],array['\\bdeposit\\b'],true),
  ('EN','VIDEO_INTEREST',array['video call','video'],array['\\bvideo\\s+call\\b'],true),
  ('EN','URGENCY',array['urgent','next week','asap'],array['\\burgent\\b'],true),
  ('EN','PRODUCT_LINK',array['/products/'],array['\\/products\\/'],true),
  ('EN','INTEREST',array['interested','i want','i like'],array['\\binterested\\b'],true)
on conflict do nothing;

insert into stage_rules (rule_name, required_tags, forbidden_tags, recommended_stage, priority, enabled)
values
  ('product_interest_no_price', array['PRODUCT_LINK','INTEREST'], array['PRICE_REQUEST'], 'PRODUCT_INTEREST', 10, true),
  ('qualified_event_shipping', array['EVENT_DATE','SHIPPING'], array[]::text[], 'QUALIFIED', 20, true),
  ('qualified_event_sizing', array['EVENT_DATE','SIZING'], array[]::text[], 'QUALIFIED', 21, true),
  ('price_request_to_qualification_pending', array['PRICE_REQUEST'], array[]::text[], 'QUALIFICATION_PENDING', 30, true),
  ('video_interest', array['VIDEO_INTEREST'], array[]::text[], 'VIDEO_PROPOSED', 40, true),
  ('payment_intent', array['PAYMENT'], array[]::text[], 'DEPOSIT_PENDING', 50, true),
  ('reservation_intent', array['RESERVATION_INTENT'], array[]::text[], 'DEPOSIT_PENDING', 51, true)
on conflict do nothing;

insert into reply_templates (stage, language, country_group, template_name, text, enabled)
values
  ('NEW','FR',null,'new_fr_a','Merci pour votre message {client_name}. Pour vous orienter avec précision, pourriez-vous me confirmer la date de votre événement et la ville/pays de livraison ?',true),
  ('NEW','FR',null,'new_fr_b','Avec plaisir. Avant de vous proposer la meilleure option, j’ai besoin de deux détails: votre date d’événement et votre ville/pays de livraison.',true),
  ('NEW','EN',null,'new_en_a','Thank you for your message {client_name}. Could you share your event date and shipping city/country so I can guide you precisely?',true),
  ('NEW','EN',null,'new_en_b','With pleasure. Before I advise accurately, may I have your event date and shipping city/country?',true),
  ('PRODUCT_INTEREST','FR',null,'pi_fr_a','Ravi(e) que ce modèle vous plaise. Pour vous guider au mieux, pouvez-vous me confirmer votre date d’événement et la ville/pays de livraison ?',true),
  ('PRODUCT_INTEREST','FR',null,'pi_fr_b','Excellente sélection. Je peux vous conseiller précisément dès que j’ai votre date d’événement et votre destination de livraison.',true),
  ('PRODUCT_INTEREST','EN',null,'pi_en_a','I am glad you like this piece. Please share your event date and shipping city/country so I can guide you accurately.',true),
  ('PRODUCT_INTEREST','EN',null,'pi_en_b','Excellent choice. I can advise precisely once I have your event date and shipping destination.',true),
  ('QUALIFICATION_PENDING','FR',null,'qp_fr_a','Merci. Dès confirmation de votre date et de votre destination, je vous envoie une proposition structurée.',true),
  ('QUALIFICATION_PENDING','FR',null,'qp_fr_b','Parfait. Je finalise votre recommandation dès que vous me confirmez la date et le lieu de livraison.',true),
  ('QUALIFICATION_PENDING','EN',null,'qp_en_a','Thank you. Once your date and destination are confirmed, I will share a structured proposal.',true),
  ('QUALIFICATION_PENDING','EN',null,'qp_en_b','Perfect. I will finalize your recommendation as soon as date and delivery location are confirmed.',true),
  ('QUALIFIED','FR',null,'q_fr_a','Parfait, nous sommes dans les délais pour {event_date}. Le prix est de {price} avec un délai de confection de {production_time}. Si vous le souhaitez, nous pouvons faire une courte visio privée.',true),
  ('QUALIFIED','FR',null,'q_fr_b','Très bien. Pour votre échéance {event_date}, le prix est {price} et la confection prend {production_time}. Je peux aussi vous proposer une visio rapide.',true),
  ('QUALIFIED','EN',null,'q_en_a','Perfect, we are on time for {event_date}. The price is {price} with a production time of {production_time}. If helpful, we can schedule a short private video call.',true),
  ('QUALIFIED','EN',null,'q_en_b','Great. For your timeline {event_date}, pricing is {price} and production is {production_time}. I can also arrange a short private video call.',true),
  ('PRICE_SENT','FR',null,'ps_fr_a','Merci pour votre retour. Si vous le souhaitez, nous pouvons valider les mesures et réserver votre créneau de confection.',true),
  ('PRICE_SENT','FR',null,'ps_fr_b','Je reste à votre disposition pour finaliser les détails (mesures, finitions, réservation de créneau).',true),
  ('PRICE_SENT','EN',null,'ps_en_a','Thank you for your reply. If you wish, we can now confirm measurements and reserve your production slot.',true),
  ('PRICE_SENT','EN',null,'ps_en_b','I remain available to finalize details (measurements, finishing, production slot reservation).',true),
  ('VIDEO_PROPOSED','FR',null,'vp_fr_a','Je peux vous proposer une visio privée demain à 11h00 ou 16h30. Dites-moi le créneau qui vous convient.',true),
  ('VIDEO_PROPOSED','FR',null,'vp_fr_b','Avec plaisir. Préférez-vous une visio à 10h30 ou 17h00 demain ?',true),
  ('VIDEO_PROPOSED','EN',null,'vp_en_a','I can offer a short private video call tomorrow at 11:00 or 16:30. Let me know which slot suits you.',true),
  ('VIDEO_PROPOSED','EN',null,'vp_en_b','With pleasure. Would 10:30 or 17:00 tomorrow work better for a quick private video call?',true),
  ('DEPOSIT_PENDING','FR',null,'dp_fr_a','Parfait. Pour confirmer votre réservation, voici la prochaine étape d’acompte: {invoice_link}.',true),
  ('DEPOSIT_PENDING','FR',null,'dp_fr_b','Nous pouvons sécuriser votre créneau dès l’acompte validé. Je vous envoie le lien de facture: {invoice_link}.',true),
  ('DEPOSIT_PENDING','EN',null,'dp_en_a','Perfect. To confirm your reservation, here is the deposit step: {invoice_link}.',true),
  ('DEPOSIT_PENDING','EN',null,'dp_en_b','We can secure your slot as soon as the deposit is confirmed. Invoice link: {invoice_link}.',true),
  ('CONVERTED','FR',null,'cv_fr_a','Merci pour votre confiance. Votre commande est confirmée et nous lançons la confection.',true),
  ('CONVERTED','FR',null,'cv_fr_b','Parfait, votre projet est confirmé. Nous vous tiendrons informé(e) des prochaines étapes.',true),
  ('CONVERTED','EN',null,'cv_en_a','Thank you for your trust. Your order is confirmed and production is now scheduled.',true),
  ('CONVERTED','EN',null,'cv_en_b','Perfect, your project is confirmed. We will keep you updated on each next step.',true),
  ('LOST','FR',null,'lost_fr_a','Merci pour votre échange. Je reste disponible si vous souhaitez reprendre ce projet plus tard.',true),
  ('LOST','FR',null,'lost_fr_b','Bien noté. N’hésitez pas à revenir vers nous à tout moment, ce sera un plaisir de vous accompagner.',true),
  ('LOST','EN',null,'lost_en_a','Thank you for the exchange. I remain available whenever you wish to revisit this project.',true),
  ('LOST','EN',null,'lost_en_b','Understood. Feel free to return at any time; it would be a pleasure to assist you.',true)
on conflict do nothing;

create table if not exists ml_models (
  id uuid primary key default gen_random_uuid(),
  model_key text not null unique,
  name text not null,
  description text,
  model_type text not null check (model_type in ('CLASSIFICATION', 'REGRESSION', 'CLUSTERING', 'NLP', 'FORECASTING')),
  status text not null default 'INACTIVE' check (status in ('ACTIVE', 'INACTIVE', 'TRAINING', 'DEPRECATED')),
  version text not null default '1.0.0',
  accuracy_score numeric(5, 4),
  last_trained_at timestamptz,
  config jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_ml_models_status on ml_models(status);
create index if not exists idx_ml_models_model_key on ml_models(model_key);

create table if not exists automation_rules (
  id uuid primary key default gen_random_uuid(),
  rule_key text not null unique,
  name text not null,
  description text,
  rule_type text not null check (rule_type in ('STAGE_AUTO', 'RISK_ALERT', 'FOLLOW_UP', 'QUALIFICATION', 'TEMPLATE_SUGGEST')),
  enabled boolean not null default true,
  priority int not null default 50,
  conditions jsonb not null default '{}',
  actions jsonb not null default '{}',
  model_id uuid references ml_models(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_automation_rules_enabled on automation_rules(enabled);
create index if not exists idx_automation_rules_rule_type on automation_rules(rule_type);
create index if not exists idx_automation_rules_model_id on automation_rules(model_id);

create table if not exists ml_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (event_type in ('RULE_TRIGGERED', 'MODEL_PREDICTION', 'SUGGESTIONS_GENERATED', 'SUGGESTION_USED', 'SUGGESTION_REJECTED', 'AUTO_STAGE_CHANGE', 'MESSAGE_PERSISTED', 'INFERENCE')),
  model_key text,
  rule_id uuid references automation_rules(id) on delete set null,
  lead_id uuid,
  source text check (source in ('OUTBOUND_TEMPLATE', 'OUTBOUND_MANUAL', 'OUTBOUND_SUGGESTION', 'INBOUND', 'SYSTEM', 'SYSTEM_BACKFILL')),
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);

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
      'MESSAGE_PERSISTED',
      'INFERENCE'
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
      'SYSTEM',
      'SYSTEM_BACKFILL'
    )
  );

create index if not exists idx_ml_events_event_type on ml_events(event_type);
create index if not exists idx_ml_events_model_key on ml_events(model_key);
create index if not exists idx_ml_events_rule_id on ml_events(rule_id);
create index if not exists idx_ml_events_lead_id on ml_events(lead_id);
create index if not exists idx_ml_events_source on ml_events(source);
create index if not exists idx_ml_events_created_at on ml_events(created_at desc);

insert into ml_models (model_key, name, description, model_type, status, version, accuracy_score, last_trained_at, config)
values
  ('lead_qualification_v1', 'Lead Qualification Model', 'Classifies leads based on conversation signals and behavior patterns', 'CLASSIFICATION', 'ACTIVE', '1.2.0', 0.8750, now() - interval '3 days', '{"threshold": 0.75, "features": ["message_count", "response_time", "intent_signals"]}'),
  ('risk_detection_v1', 'Risk Detection Model', 'Identifies high-risk conversations requiring immediate attention', 'CLASSIFICATION', 'ACTIVE', '1.1.0', 0.9200, now() - interval '5 days', '{"threshold": 0.80, "categories": ["payment_dispute", "negative_sentiment", "churn_risk"]}'),
  ('stage_prediction_v2', 'Stage Progression Model', 'Predicts optimal next stage based on conversation context', 'CLASSIFICATION', 'ACTIVE', '2.0.1', 0.8650, now() - interval '1 day', '{"stages": ["INQUIRY", "QUALIFIED", "PRICE_SENT", "DEPOSIT_PENDING", "CONFIRMED"]}'),
  ('sentiment_analysis_v1', 'Sentiment Analysis', 'Analyzes customer sentiment from message content', 'NLP', 'ACTIVE', '1.0.0', 0.9100, now() - interval '7 days', '{"model": "distilbert-base-uncased-finetuned-sst-2-english"}'),
  ('revenue_forecast_v3', 'Revenue Forecasting', 'Predicts monthly revenue based on pipeline and historical data', 'FORECASTING', 'ACTIVE', '3.1.2', 0.9450, now() - interval '2 days', '{"horizon_days": 30, "confidence_interval": 0.95}')
on conflict (model_key) do nothing;

insert into automation_rules (rule_key, name, description, rule_type, enabled, priority, conditions, actions)
values
  ('auto_qualify_high_intent', 'Auto-Qualify High Intent Leads', 'Automatically moves leads to QUALIFIED stage when high intent signals detected', 'STAGE_AUTO', true, 90, '{"min_messages": 3, "intent_threshold": 0.8}', '{"target_stage": "QUALIFIED", "notify": true}'),
  ('risk_alert_negative_sentiment', 'Risk Alert: Negative Sentiment', 'Triggers alert when negative sentiment detected in conversation', 'RISK_ALERT', true, 95, '{"sentiment_threshold": -0.6}', '{"alert_type": "NEGATIVE_SENTIMENT", "notify_team": true}'),
  ('follow_up_48h_no_response', '48H Follow-Up Trigger', 'Suggests follow-up template after 48 hours of no customer response', 'FOLLOW_UP', true, 70, '{"hours_since_last_message": 48, "stage": "PRICE_SENT"}', '{"template_type": "48H_PRICE", "auto_send": false}'),
  ('suggest_video_call_qualified', 'Suggest Video Call (Qualified)', 'Recommends video call template for qualified high-value leads', 'TEMPLATE_SUGGEST', true, 80, '{"stage": "QUALIFIED", "intent_score": 0.75}', '{"template_category": "VIDEO_CALL", "priority": "HIGH"}'),
  ('auto_deposit_pending', 'Auto-Move to Deposit Pending', 'Moves lead to DEPOSIT_PENDING when price confirmed verbally', 'STAGE_AUTO', true, 85, '{"price_sent": true, "verbal_confirmation": true}', '{"target_stage": "DEPOSIT_PENDING", "notify": true}')
on conflict (rule_key) do nothing;
`;
