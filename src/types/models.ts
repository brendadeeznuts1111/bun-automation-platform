/**
 * Database entity models for bun:sqlite tables.
 *
 * Defined as classes (not interfaces) so they can be used with
 * `db.query(sql).as(MyClass)` — Bun's native query-to-class mapping
 * that eliminates `as` casts at the call site.
 *
 * Ref: node_modules/bun-types/docs/runtime/sqlite.mdx#as-class
 *
 * Note: `.as(Class)` does NOT call the constructor. It assigns the
 * prototype (methods, getters) and sets columns as properties via
 * `Object.create`. Constructor parameters are not invoked.
 */

export class AgentRow {
  id!: number;
  username!: string;
  password!: string;
  created_at!: string;
  updated_at!: string;
}

export class TaskRow {
  id!: number;
  agent_id!: number;
  url!: string;
  status!: "pending" | "running" | "completed" | "failed";
  progress!: number;
  priority!: number;
  proxy!: string | null;
  user_agent!: string | null;
  geo_lat!: number | null;
  geo_lon!: number | null;
  error!: string | null;
  result!: string | null;
  created_at!: string;
  updated_at!: string;
  started_at!: string | null;
  completed_at!: string | null;
}

export class SessionRow {
  id!: number;
  task_id!: number;
  cookies!: string;
  local_storage!: string;
  session_storage!: string;
  screenshot_path!: string | null;
  screenshot_color!: string | null;
  expires_at!: string | null;
  last_healthy!: string | null;
  created_at!: string;
}

export class AuditLogRow {
  id!: number;
  agent_id!: number | null;
  action!: string;
  resource!: string | null;
  details!: string | null;
  ip_address!: string | null;
  created_at!: string;
}

export class RateLimitRow {
  key!: string;
  window_start!: number;
  count!: number;
}

export class CircuitBreakerRow {
  site!: string;
  failures!: number;
  tripped_at!: string | null;
  last_failure!: string | null;
}

// --- Ad-hoc query result types ----------------------------------------------
// These are not full table rows — they're projections from specific queries.

/** `SELECT COUNT(*) as count FROM ...` */
export class CountRow {
  count!: number;
}

/** `SELECT status, COUNT(*) as count FROM tasks GROUP BY status` */
export class TaskStatusCountRow {
  status!: string;
  count!: number;
}

/** `SELECT id, agent_id FROM auth_sessions WHERE token = ?` */
export class SessionTokenRow {
  id!: number;
  agent_id!: number;
}

/** `SELECT screenshot_path FROM sessions ...` */
export class ScreenshotPathRow {
  screenshot_path!: string;
}

/** `SELECT name FROM sqlite_master WHERE ...` */
export class TableNameRow {
  name!: string;
}

/** `SELECT ts, pool_status, uptime, bun_version FROM health_log ...` */
export class HealthLogRow {
  ts!: number;
  pool_status!: string;
  uptime!: number;
  bun_version!: string;
}

/** `SELECT failures, tripped_at FROM circuit_breakers WHERE site = ?` */
export class CircuitStatusRow {
  failures!: number;
  tripped_at!: string | null;
}

/** `SELECT value FROM _meta WHERE key = ?` */
export class MetaRow {
  value!: string;
}

/** `SELECT id, username, password FROM agents WHERE username = ?` */
export class AgentLoginRow {
  id!: number;
  username!: string;
  password!: string;
}

/** Session list projection (JOIN sessions + tasks, filtered by agent_id) */
export class SessionListRow {
  id!: number;
  task_id!: number;
  screenshot_path!: string | null;
  screenshot_color!: string | null;
  expires_at!: string | null;
  last_healthy!: string | null;
  created_at!: string;
}

/** Task list projection (subset of TaskRow columns for list views) */
export class TaskListRow {
  id!: number;
  agent_id!: number;
  url!: string;
  status!: "pending" | "running" | "completed" | "failed";
  progress!: number;
  priority!: number;
  error!: string | null;
  created_at!: string;
  updated_at!: string;
  completed_at!: string | null;
}
