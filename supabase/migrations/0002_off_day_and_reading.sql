alter table public.daily_records
  add column if not exists is_off_day boolean not null default false,
  add column if not exists beneficial_activities boolean,
  add column if not exists reading boolean;