-- ============================================================
-- Seller Doctor — Phase 2: Products & SKUs history + Activity Log
-- Run this once in Supabase → SQL Editor → New Query → Run
-- (Requires 001-snapshots-phase1-briefing.sql to already be applied)
-- ============================================================

-- Per-SKU history — one row per SKU per analysis, so "Products & SKUs"
-- can show how each individual SKU's profit/margin changes over time.
create table if not exists public.sku_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  sku text not null,
  name text,
  platform text,
  sales numeric,
  units int,
  returns int,
  profit numeric,
  margin_percent numeric
);

alter table public.sku_snapshots enable row level security;

create policy "Users can insert their own sku snapshots"
  on public.sku_snapshots for insert
  with check (auth.uid() = user_id);

create policy "Users can view their own sku snapshots"
  on public.sku_snapshots for select
  using (auth.uid() = user_id);

create index if not exists sku_snapshots_user_sku_idx
  on public.sku_snapshots (user_id, sku, created_at desc);


-- Activity log — one row per meaningful action, so "Activity Log" can
-- show a real history of what the seller has done in the tool.
-- action_type values used by the app: 'settlement_upload', 'pdf_download',
-- 'label_crop', 'listing_draft', 'payment'
create table if not exists public.activity_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  action_type text not null,
  details jsonb
);

alter table public.activity_log enable row level security;

create policy "Users can insert their own activity"
  on public.activity_log for insert
  with check (auth.uid() = user_id);

create policy "Users can view their own activity"
  on public.activity_log for select
  using (auth.uid() = user_id);

create index if not exists activity_log_user_created_idx
  on public.activity_log (user_id, created_at desc);
