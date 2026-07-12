alter table if exists products
  add column if not exists stock_mode text not null default 'MANUAL';

alter table if exists staff
  add column if not exists pix_key_type text not null default '',
  add column if not exists pix_city text not null default '';

alter table if exists orders
  add column if not exists payment_method text,
  add column if not exists payment_state text,
  add column if not exists total_cents_snapshot integer,
  add column if not exists pagbank_order_id text,
  add column if not exists pagbank_reference_id text,
  add column if not exists pagbank_charge_id text,
  add column if not exists payment_expires_at timestamptz;

alter table if exists stock_items
  add column if not exists encrypted_value text,
  add column if not exists encryption_iv text,
  add column if not exists encryption_auth_tag text,
  add column if not exists value_fingerprint text,
  add column if not exists reserved_by_order_id text,
  add column if not exists sold_by_order_id text,
  add column if not exists sold_to_discord_user_id text,
  add column if not exists created_by_user_id text,
  add column if not exists sold_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

alter table if exists stock_items drop constraint if exists stock_items_status_check;
alter table if exists stock_items
  add constraint stock_items_status_check
  check (status in ('AVAILABLE', 'RESERVED', 'SOLD', 'DISABLED')) not valid;

update stock_items set status = case status
  when 'available' then 'AVAILABLE'
  when 'reserved' then 'RESERVED'
  when 'delivered' then 'SOLD'
  when 'void' then 'DISABLED'
  else status end;
update stock_items set status = 'DISABLED' where encrypted_value is null;

alter table if exists stock_items validate constraint stock_items_status_check;
create unique index if not exists uq_stock_items_product_fingerprint
  on stock_items(product_id, value_fingerprint) where value_fingerprint is not null;
create index if not exists idx_stock_items_available
  on stock_items(guild_id, product_id, status, id);
create index if not exists idx_orders_pagbank_reference
  on orders(pagbank_reference_id) where pagbank_reference_id is not null;
