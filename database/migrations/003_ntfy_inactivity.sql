alter table if exists orders
  add column if not exists last_interaction_at timestamptz,
  add column if not exists manual_payment_notification_sent_at timestamptz,
  add column if not exists manual_payment_notification_sent_by text,
  add column if not exists automatic_payment_notification_key text,
  add column if not exists manually_approved_by text,
  add column if not exists manually_approved_at timestamptz;

update orders
set last_interaction_at = coalesce(last_interaction_at, updated_at, created_at)
where last_interaction_at is null;

create index if not exists idx_orders_open_last_interaction
  on orders(last_interaction_at) where status = 'open';

create unique index if not exists idx_orders_automatic_notification_key
  on orders(automatic_payment_notification_key)
  where automatic_payment_notification_key is not null;
