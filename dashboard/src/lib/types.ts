export type DashboardMode = "user" | "detailed";

export type TelemetryWindow = {
  id: string;
  created_at: string;
  ts_ms_start?: number | null;
  device_id: string;
  sbp_pred: number | null;
  dbp_pred: number | null;
  sbp_std?: number | null;
  dbp_std?: number | null;
  synthetic?: boolean | null;
};

export type ApiHealth = {
  ok?: boolean;
  model_loaded?: boolean;
  feature_count?: number;
  supabase_configured?: boolean;
  model_path?: string;
  [key: string]: unknown;
};

export type PredictionResponse = {
  sbp?: number;
  dbp?: number;
  sbp_std?: number;
  dbp_std?: number;
  schema_names?: string[];
  [key: string]: unknown;
};
