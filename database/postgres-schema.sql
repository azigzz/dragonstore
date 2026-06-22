-- Dragon Store transactional schema.
-- Target: PostgreSQL / Neon / Supabase.

create table if not exists guilds (
  id text primary key,
  name text not null default '',
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists bot_json_store (
  key text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists panels (
  id text primary key,
  guild_id text not null references guilds(id) on delete cascade,
  scope_id text not null default 'default',
  title text not null,
  description text not null default '',
  color text not null default '#9b00ff',
  image_url text not null default '',
  thumbnail_url text not null default '',
  channel_id text not null default '',
  published_channel_id text not null default '',
  published_message_id text not null default '',
  quick_order jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (guild_id, scope_id)
);

create table if not exists products (
  id text primary key,
  panel_id text not null references panels(id) on delete cascade,
  guild_id text not null references guilds(id) on delete cascade,
  name text not null,
  price_label text not null default 'R$ 0,00',
  price_cents integer,
  description text not null default '',
  stock_label text not null default 'infinito',
  stock_quantity integer,
  type text not null default 'product',
  image_url text not null default '',
  rewards jsonb not null default '[]'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists orders (
  id text primary key,
  guild_id text not null references guilds(id) on delete cascade,
  panel_id text references panels(id) on delete set null,
  panel_scope_id text not null default 'default',
  channel_id text not null,
  user_id text not null,
  username text not null default '',
  status text not null default 'open'
    check (status in ('open', 'processing', 'closed', 'cancelled', 'expired')),
  version integer not null default 0,
  discount jsonb,
  gross_amount_cents integer not null default 0,
  discount_amount_cents integer not null default 0,
  paid_amount_cents integer not null default 0,
  assigned_admin_id text,
  assigned_admin_name text,
  processing_by_admin_id text,
  processing_by_admin_name text,
  delivered_by_admin_id text,
  delivered_by_admin_name text,
  delivery_message text,
  closed_by_admin_id text,
  closed_by_admin_name text,
  processing_started_at timestamptz,
  delivered_at timestamptz,
  closed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_orders_guild_status on orders(guild_id, status);
create index if not exists idx_orders_channel on orders(guild_id, channel_id);

alter table if exists orders add column if not exists processing_by_admin_id text;
alter table if exists orders add column if not exists processing_by_admin_name text;
alter table if exists orders add column if not exists delivered_by_admin_id text;
alter table if exists orders add column if not exists delivered_by_admin_name text;
alter table if exists orders add column if not exists delivery_message text;
alter table if exists orders add column if not exists delivered_at timestamptz;
alter table if exists products add column if not exists stock_quantity integer;

create table if not exists order_items (
  id bigserial primary key,
  order_id text not null references orders(id) on delete cascade,
  product_id text,
  source_panel_id text,
  name text not null,
  price_label text not null default '',
  price_cents integer,
  description text not null default '',
  stock_label text not null default '',
  type text not null default 'product',
  image_url text not null default '',
  rewards jsonb not null default '[]'::jsonb,
  quantity integer not null default 1 check (quantity > 0),
  created_at timestamptz not null default now()
);

create table if not exists staff (
  guild_id text not null references guilds(id) on delete cascade,
  user_id text not null,
  display_name text not null default '',
  pix_key_encrypted text,
  qr_code_url text not null default '',
  note text not null default '',
  online boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (guild_id, user_id)
);

create table if not exists payments (
  id bigserial primary key,
  external_id text unique,
  order_id text not null references orders(id) on delete cascade,
  guild_id text not null references guilds(id) on delete cascade,
  status text not null default 'manual_pending'
    check (status in ('manual_pending', 'proof_received', 'marked_paid', 'refunded', 'failed')),
  amount_cents integer not null default 0,
  method text not null default 'pix_manual',
  staff_user_id text,
  proof_attachment_url text,
  marked_paid_at timestamptz,
  created_at timestamptz not null default now()
);

alter table if exists payments add column if not exists external_id text unique;
alter table if exists payments add column if not exists proof_attachment_url text;

do $$
begin
  if exists (
    select 1
    from information_schema.table_constraints
    where table_name = 'payments'
      and constraint_name = 'payments_status_check'
  ) then
    alter table payments drop constraint payments_status_check;
  end if;

  alter table payments
    add constraint payments_status_check
    check (status in ('manual_pending', 'proof_received', 'marked_paid', 'refunded', 'failed'));
exception
  when duplicate_object then null;
end $$;

create table if not exists stock_items (
  id bigserial primary key,
  product_id text not null references products(id) on delete cascade,
  guild_id text not null references guilds(id) on delete cascade,
  payload_encrypted text,
  status text not null default 'available'
    check (status in ('available', 'reserved', 'delivered', 'void')),
  order_id text references orders(id) on delete set null,
  reserved_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists audit_logs (
  id bigserial primary key,
  external_id text unique,
  guild_id text not null references guilds(id) on delete cascade,
  actor_id text,
  actor_name text not null default '',
  action text not null,
  order_id text,
  target_user_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_audit_logs_guild_created on audit_logs(guild_id, created_at desc);
create index if not exists idx_audit_logs_order on audit_logs(order_id);

create table if not exists customer_stats (
  guild_id text not null references guilds(id) on delete cascade,
  user_id text not null,
  username text not null default '',
  total_spent_cents integer not null default 0,
  order_count integer not null default 0,
  periods jsonb not null default '{}'::jsonb,
  last_order_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (guild_id, user_id)
);

create table if not exists admin_sales (
  guild_id text not null references guilds(id) on delete cascade,
  admin_user_id text not null,
  username text not null default '',
  total_sold_cents integer not null default 0,
  order_count integer not null default 0,
  total_items integer not null default 0,
  periods jsonb not null default '{}'::jsonb,
  last_sale_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (guild_id, admin_user_id)
);

-- Idempotent finalization pattern:
-- update orders
-- set status = 'processing', processing_started_at = now(), version = version + 1
-- where id = $1 and status = 'open';
--
-- Only proceed when row_count = 1. Then commit final sale with:
-- update orders set status = 'closed', closed_at = now(), version = version + 1 where id = $1 and status = 'processing';
