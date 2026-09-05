-- Habit Tracker — initial schema
-- Run this once in your Supabase project's SQL Editor.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------
-- user_settings: one row per user, holds editable habit targets
-- ---------------------------------------------------------------
create table if not exists public.user_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  sleep_time_target time not null default '23:30',
  wake_time_target time not null default '06:30',
  sleep_min_hours numeric not null default 6,
  sleep_max_hours numeric not null default 8,
  office_target time not null default '09:00',
  exercise_target_minutes integer not null default 30,
  updated_at timestamptz not null default now()
);

alter table public.user_settings enable row level security;

drop policy if exists "settings: select own" on public.user_settings;
create policy "settings: select own" on public.user_settings
  for select using (auth.uid() = user_id);

drop policy if exists "settings: insert own" on public.user_settings;
create policy "settings: insert own" on public.user_settings
  for insert with check (auth.uid() = user_id);

drop policy if exists "settings: update own" on public.user_settings;
create policy "settings: update own" on public.user_settings
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "settings: delete own" on public.user_settings;
create policy "settings: delete own" on public.user_settings
  for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------
-- daily_records: one row per user per calendar date
-- ---------------------------------------------------------------
create table if not exists public.daily_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  date date not null,
  sleep_time time,
  wake_time time,
  subuh boolean,              -- null = not recorded, true = done, false = missed
  office_arrival time,
  avoid_sugar boolean,        -- null = not recorded, true = done, false = missed
  exercise_completed boolean, -- null = not recorded, true = done, false = missed
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint daily_records_user_date_unique unique (user_id, date),
  constraint notes_length check (char_length(notes) <= 500)
);

create index if not exists daily_records_user_date_idx
  on public.daily_records (user_id, date desc);

alter table public.daily_records enable row level security;

drop policy if exists "records: select own" on public.daily_records;
create policy "records: select own" on public.daily_records
  for select using (auth.uid() = user_id);

drop policy if exists "records: insert own" on public.daily_records;
create policy "records: insert own" on public.daily_records
  for insert with check (auth.uid() = user_id);

drop policy if exists "records: update own" on public.daily_records;
create policy "records: update own" on public.daily_records
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "records: delete own" on public.daily_records;
create policy "records: delete own" on public.daily_records
  for delete using (auth.uid() = user_id);
