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

create index if not exists idx_lead_price_quotes_lead_created on lead_price_quotes(lead_id, created_at desc);
create index if not exists idx_lead_price_quotes_lead_product_handle on lead_price_quotes(lead_id, product_handle);
create index if not exists idx_lead_price_quotes_message_id on lead_price_quotes(message_id);
create unique index if not exists idx_lead_price_quotes_dedupe
  on lead_price_quotes(lead_id, message_id, amount, currency, product_handle, qty);
