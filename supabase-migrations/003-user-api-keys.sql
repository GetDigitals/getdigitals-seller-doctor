-- ============================================================
-- Seller Doctor — Phase 3: AI Product Photoshoot (Bring Your Own Key)
-- Run this once in Supabase → SQL Editor → New Query → Run
-- ============================================================

-- One row per user, storing their OWN Gemini API key. All image-generation
-- calls are billed to the seller's own Google account, not ours — this
-- table just remembers the key so they don't paste it every time.
create table if not exists public.user_api_keys (
  user_id uuid primary key references auth.users(id) on delete cascade,
  gemini_api_key text,
  updated_at timestamptz not null default now()
);

alter table public.user_api_keys enable row level security;

-- RLS policies alone aren't enough — the underlying Postgres role also
-- needs basic table-level privileges, or every query fails with
-- "permission denied for table user_api_keys" before RLS even runs.
grant select, insert, update, delete on public.user_api_keys to authenticated;

create policy "Users can view their own api key"
  on public.user_api_keys for select
  using (auth.uid() = user_id);

create policy "Users can insert their own api key"
  on public.user_api_keys for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own api key"
  on public.user_api_keys for update
  using (auth.uid() = user_id);

create policy "Users can delete their own api key"
  on public.user_api_keys for delete
  using (auth.uid() = user_id);
