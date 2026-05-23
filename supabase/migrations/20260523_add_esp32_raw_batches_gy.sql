-- Fix missing gyro Y column on esp32_raw_batches (run once in Supabase SQL editor).
alter table public.esp32_raw_batches
  add column if not exists gy jsonb;

-- Refresh PostgREST schema cache (Supabase usually picks this up within seconds).
notify pgrst, 'reload schema';
