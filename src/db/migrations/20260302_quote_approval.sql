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
  action_type text not null check (action_type in ('APPROVE_PRICE', 'MARK_OOS')),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_quote_requests_lead_created on quote_requests(lead_id, created_at desc);
create index if not exists idx_quote_requests_status_created on quote_requests(status, created_at desc);
create index if not exists idx_quote_actions_request_created on quote_actions(quote_request_id, created_at);
