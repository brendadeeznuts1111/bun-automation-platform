/**
 * Database entity models for bun:sqlite tables.
 */

export interface AgentRow {
  id: number;
  username: string;
  password: string;
  created_at: string;
  updated_at: string;
}

export interface TaskRow {
  id: number;
  agent_id: number;
  url: string;
  status: "pending" | "running" | "completed" | "failed";
  progress: number;
  priority: number;
  proxy: string | null;
  user_agent: string | null;
  geo_lat: number | null;
  geo_lon: number | null;
  error: string | null;
  result: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface SessionRow {
  id: number;
  task_id: number;
  cookies: string;
  local_storage: string;
  session_storage: string;
  screenshot_path: string | null;
  screenshot_color: string | null;
  expires_at: string | null;
  last_healthy: string | null;
  created_at: string;
}

export interface AuditLogRow {
  id: number;
  agent_id: number | null;
  action: string;
  resource: string | null;
  details: string | null;
  ip_address: string | null;
  created_at: string;
}

export interface RateLimitRow {
  key: string;
  window_start: number;
  count: number;
}

export interface CircuitBreakerRow {
  site: string;
  failures: number;
  tripped_at: string | null;
  last_failure: string | null;
}
