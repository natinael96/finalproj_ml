-- Minimal schema for ESP32 BP telemetry + predictions.
-- Apply in Supabase SQL editor.

-- Extensions
create extension if not exists "pgcrypto";

-- Devices owned by a user
create table if not exists public.devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id text not null,
  label text,
  created_at timestamptz not null default now(),
  unique (user_id, device_id)
);

-- Measurement sessions
create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id text not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  notes text
);

-- One row per extracted window (raw optional, features + predictions)
create table if not exists public.telemetry_windows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid references public.sessions(id) on delete set null,
  device_id text not null,
  ts_ms_start bigint not null,
  fs_hz int not null,
  window_s real not null,

  -- feature vector (aligned to model schema_names)
  schema_names jsonb,
  features jsonb not null,

  -- predictions
  sbp_pred real,
  dbp_pred real,
  -- simple uncertainty proxy (optional)
  sbp_std real,
  dbp_std real,
  synthetic boolean not null default false,

  -- raw samples (optional; can be null to save space)
  ecg jsonb,
  ppg jsonb,
  accel jsonb,
  gyro jsonb,

  created_at timestamptz not null default now()
);

create index if not exists telemetry_windows_user_time_idx
  on public.telemetry_windows(user_id, created_at desc);
create index if not exists telemetry_windows_device_time_idx
  on public.telemetry_windows(device_id, created_at desc);
create index if not exists telemetry_windows_session_time_idx
  on public.telemetry_windows(session_id, created_at desc);

-- Raw ESP32 batches (every HTTP POST); see esp32_raw_batches.sql for RLS policies
create table if not exists public.esp32_raw_batches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  session_id uuid references public.sessions(id) on delete set null,
  device_id text not null,
  ts_ms_start bigint not null,
  fs_hz int not null,
  window_s real not null,
  sample_count int not null check (sample_count > 0),
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

-- Custom labels for 2000-sample prediction cycles
create table if not exists public.cycle_labels (
  cycle_id   text not null,
  user_id    uuid not null references auth.users(id) on delete cascade,
  label      text not null,
  created_at timestamptz not null default now(),
  primary key (cycle_id, user_id)
);

-- RLS
alter table public.devices enable row level security;
alter table public.sessions enable row level security;
alter table public.telemetry_windows enable row level security;
alter table public.esp32_raw_batches enable row level security;
alter table public.cycle_labels enable row level security;

-- Devices
drop policy if exists "devices_select_own" on public.devices;
create policy "devices_select_own"
  on public.devices for select
  using (auth.uid() = user_id);

drop policy if exists "devices_insert_own" on public.devices;
create policy "devices_insert_own"
  on public.devices for insert
  with check (auth.uid() = user_id);

drop policy if exists "devices_update_own" on public.devices;
create policy "devices_update_own"
  on public.devices for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "devices_delete_own" on public.devices;
create policy "devices_delete_own"
  on public.devices for delete
  using (auth.uid() = user_id);

-- Sessions
drop policy if exists "sessions_select_own" on public.sessions;
create policy "sessions_select_own"
  on public.sessions for select
  using (auth.uid() = user_id);

drop policy if exists "sessions_insert_own" on public.sessions;
create policy "sessions_insert_own"
  on public.sessions for insert
  with check (auth.uid() = user_id);

drop policy if exists "sessions_update_own" on public.sessions;
create policy "sessions_update_own"
  on public.sessions for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "sessions_delete_own" on public.sessions;
create policy "sessions_delete_own"
  on public.sessions for delete
  using (auth.uid() = user_id);

-- Telemetry windows
drop policy if exists "telemetry_windows_select_own" on public.telemetry_windows;
create policy "telemetry_windows_select_own"
  on public.telemetry_windows for select
  using (auth.uid() = user_id);

drop policy if exists "telemetry_windows_insert_own" on public.telemetry_windows;
create policy "telemetry_windows_insert_own"
  on public.telemetry_windows for insert
  with check (auth.uid() = user_id);

drop policy if exists "telemetry_windows_update_own" on public.telemetry_windows;
create policy "telemetry_windows_update_own"
  on public.telemetry_windows for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "telemetry_windows_delete_own" on public.telemetry_windows;
create policy "telemetry_windows_delete_own"
  on public.telemetry_windows for delete
  using (auth.uid() = user_id);

-- ESP32 raw batches
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

-- Cycle labels
drop policy if exists "cycle_labels_select_own" on public.cycle_labels;
create policy "cycle_labels_select_own"
  on public.cycle_labels for select
  using (auth.uid() = user_id);

drop policy if exists "cycle_labels_insert_own" on public.cycle_labels;
create policy "cycle_labels_insert_own"
  on public.cycle_labels for insert
  with check (auth.uid() = user_id);

drop policy if exists "cycle_labels_update_own" on public.cycle_labels;
create policy "cycle_labels_update_own"
  on public.cycle_labels for update
  using (auth.uid() = user_id);

drop policy if exists "cycle_labels_delete_own" on public.cycle_labels;
create policy "cycle_labels_delete_own"
  on public.cycle_labels for delete
  using (auth.uid() = user_id);
