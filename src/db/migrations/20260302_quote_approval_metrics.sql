create table if not exists quote_approval_metrics (
  id uuid primary key default gen_random_uuid(),
  quote_request_id uuid not null references quote_requests(id) on delete cascade,
  decision_time_seconds int not null check (decision_time_seconds >= 0),
  approved boolean not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_quote_approval_metrics_created on quote_approval_metrics(created_at desc);
create index if not exists idx_quote_approval_metrics_quote_request on quote_approval_metrics(quote_request_id);
