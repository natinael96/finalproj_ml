-- Add cycle_id to esp32_raw_batches.
-- Each 2000-sample accumulation window gets a unique UUID (generated server-side).
-- All raw batches collected during the same window share the same cycle_id.
-- When the buffer is flushed for prediction the server rotates to a new cycle_id.

alter table public.esp32_raw_batches
  add column if not exists cycle_id text;

create index if not exists esp32_raw_batches_cycle_idx
  on public.esp32_raw_batches (device_id, cycle_id);
