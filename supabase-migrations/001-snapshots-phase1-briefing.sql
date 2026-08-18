-- ============================================================
-- Seller Doctor — Phase 1: Daily Briefing
-- Run this once in Supabase → SQL Editor → New Query → Run
-- ============================================================

create table if not exists public.snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  total_sales numeric,
  total_profit numeric,
  total_loss numeric,
  critical_count int,
  warning_count int,
  sku_count int,
  top_issues jsonb
);

alter table public.snapshots enable row level security;

-- Har user sirf apna hi snapshot insert kar sakta hai
create policy "Users can insert their own snapshots"
  on public.snapshots for insert
  with check (auth.uid() = user_id);

-- Har user sirf apne hi snapshots dekh sakta hai
create policy "Users can view their own snapshots"
  on public.snapshots for select
  using (auth.uid() = user_id);

-- Fast lookup for "latest snapshot for this user"
create index if not exists snapshots_user_created_idx
  on public.snapshots (user_id, created_at desc);
