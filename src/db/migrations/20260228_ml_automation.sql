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
  event_type text not null check (event_type in ('RULE_TRIGGERED', 'MODEL_PREDICTION', 'SUGGESTIONS_GENERATED', 'SUGGESTION_USED', 'SUGGESTION_REJECTED', 'AUTO_STAGE_CHANGE', 'MESSAGE_PERSISTED')),
  model_key text,
  rule_id uuid references automation_rules(id) on delete set null,
  lead_id uuid,
  source text check (source in ('OUTBOUND_TEMPLATE', 'OUTBOUND_MANUAL', 'OUTBOUND_SUGGESTION', 'INBOUND', 'SYSTEM')),
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
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
