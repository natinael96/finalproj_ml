-- Raw ESP32 HTTP ingest batches (one row per POST, before server-side buffering).
-- Apply in Supabase SQL editor after schema.sql.

create table if not exists public.esp32_raw_batches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  session_id uuid references public.sessions(id) on delete set null,
  device_id text not null,
  ts_ms_start bigint not null,
  fs_hz int not null,
  window_s real not null,
  sample_count int not null check (sample_count > 0),

  -- Identifies the 2000-sample accumulation window this batch belongs to.
  -- Rotated server-side after every completed prediction window.
  cycle_id text,

  ecg jsonb not null,
  ppg jsonb not null,
  ax jsonb,
  ay jsonb,
  az jsonb,
  gx jsonb,
  gy jsonb,
  gz jsonb,

  created_at timestamptz not null default now()
);

create index if not exists esp32_raw_batches_user_time_idx
  on public.esp32_raw_batches(user_id, created_at desc);
create index if not exists esp32_raw_batches_device_time_idx
  on public.esp32_raw_batches(device_id, created_at desc);
create index if not exists esp32_raw_batches_cycle_idx
  on public.esp32_raw_batches(device_id, cycle_id);

alter table public.esp32_raw_batches enable row level security;

drop policy if exists "esp32_raw_batches_select_own" on public.esp32_raw_batches;
create policy "esp32_raw_batches_select_own"
  on public.esp32_raw_batches for select
  using (user_id is not null and auth.uid() = user_id);

drop policy if exists "esp32_raw_batches_insert_own" on public.esp32_raw_batches;
create policy "esp32_raw_batches_insert_own"
  on public.esp32_raw_batches for insert
  with check (user_id is not null and auth.uid() = user_id);

drop policy if exists "esp32_raw_batches_delete_own" on public.esp32_raw_batches;
create policy "esp32_raw_batches_delete_own"
  on public.esp32_raw_batches for delete
  using (user_id is not null and auth.uid() = user_id);
