-- Add synthetic provenance flag for telemetry audit trail.
alter table public.telemetry_windows
  add column if not exists synthetic boolean not null default false;

create index if not exists telemetry_windows_synthetic_idx
  on public.telemetry_windows(user_id, synthetic, created_at desc);
