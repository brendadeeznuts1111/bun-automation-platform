// Admin and management routes — shell, feature toggle, config, logs, processes, runtime.
//
// Ref: https://bun.com/docs/runtime/http/routing

import type { BunRequest } from "bun";
import { audit } from "../db/audit";
import { deleteCredential, listCredentials, upsertCredential } from "../db/credentials";
import { getLogCount, getLogs, log } from "../utils/log";
import { getPoolStatus } from "../workers/pool";
import { router } from "./router";
import { errorResponse, json, withAuth, withCsrf } from "./shared";

// --- Route reload callback (set by server.ts to avoid circular import) -----

let reloadRoutesCallback: (() => void) | null = null;

/** Called by server.ts to wire in the route reload function. */
export function setReloadRoutes(fn: () => void): void {
  reloadRoutesCallback = fn;
}

// --- Pre-execve cleanup callback (set by server.ts) -------------------------
// Called before process.execve() to gracefully stop the server, notify
// workers, and close the DB — prevents orphaned workers and DB corruption.

let prepareForExecveCallback: (() => Promise<void>) | null = null;

/** Called by server.ts to wire in the pre-execve cleanup function. */
export function setPrepareForExecve(fn: () => Promise<void>): void {
  prepareForExecveCallback = fn;
}

// --- Handlers ---------------------------------------------------------------

// Bun.shell — safe admin commands
// Ref: node_modules/bun-types/docs/runtime/shell.mdx
const adminShellHandler = withCsrf<"/api/admin/shell">(
  async (req: BunRequest<"/api/admin/shell">): Promise<Response> => {
    // JUSTIFIED: req.json() returns unknown; narrowing to the admin command shape
    const body = (await req.json()) as { command: string };
    const allowedCommands = ["vacuum", "status", "workers", "git", "disk", "env"];
    if (!allowedCommands.includes(body.command)) {
      return json({ error: `command must be one of: ${allowedCommands.join(", ")}` }, 400);
    }
    const { $ } = await import("bun");
    try {
      let output = "";
      if (body.command === "vacuum") {
        output =
          await $`echo "VACUUM;" | bun -e "import {Database} from 'bun:sqlite'; const db = new Database(process.env.DB_PATH ?? './data/platform.db'); db.exec('VACUUM'); console.log('VACUUM complete')"`.text();
      } else if (body.command === "status") {
        output =
          await $`bun -e "console.log(JSON.stringify({uptime: process.uptime(), version: Bun.version, pid: process.pid}, null, 2))"`.text();
      } else if (body.command === "workers") {
        const pool = getPoolStatus();
        output = JSON.stringify(pool, null, 2);
      } else if (body.command === "git") {
        output = await $`git status --short`.text();
      } else if (body.command === "disk") {
        output = await $`du -sh ./data ./public ./exports 2>/dev/null || echo "no data dirs"`.text();
      } else if (body.command === "env") {
        const safe = ["NODE_ENV", "PORT", "HOST", "BUN_VERSION", "ENABLE_PWA", "ENABLE_SITEMAP"];
        output = safe.map((k) => `${k}=${process.env[k] ?? "unset"}`).join("\n");
      }
      await audit({ action: "admin_command", resource: body.command, details: "shell exec" });
      return json({ command: body.command, output });
    } catch (err) {
      return json({ error: "command failed", details: String(err) }, 500);
    }
  },
);

// Dynamic feature toggle — update feature flags at runtime without restart
// Ref: src/features/registry.ts
const featureToggleHandler = withCsrf<"/api/features/toggle">(
  async (req: BunRequest<"/api/features/toggle">): Promise<Response> => {
    // JUSTIFIED: req.json() returns unknown; narrowing to the toggle body shape
    const body = (await req.json()) as { key: string; enabled: boolean };
    const { toggleFeature } = await import("../features/registry");
    const result = toggleFeature(body.key, body.enabled);
    if (!result.ok) {
      return json({ error: result.error }, 400);
    }
    await audit({ action: "feature_toggle", resource: body.key, details: `enabled=${body.enabled}` });
    // Reload routes so the toggled feature takes effect immediately
    // (e.g. enabling/disabling sitemap or dashboard routes at runtime)
    if (reloadRoutesCallback) {
      try {
        reloadRoutesCallback();
      } catch (e) {
        log("admin", "error", "route reload failed after feature toggle", e);
      }
    }
    return json({
      ok: true,
      key: body.key,
      enabled: body.enabled,
      active: result.active,
      routesReloaded: !!reloadRoutesCallback,
    });
  },
);

// Bun.console — structured logging endpoint
// Ref: node_modules/bun-types/docs/runtime/console.mdx
const logsHandler = withAuth<"">((req: BunRequest<"">): Response => {
  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);
  return json({ logs: getLogs(limit), count: getLogCount() });
});

// Bun.spawn — process manager (list running processes)
// Ref: node_modules/bun-types/bun.d.ts#Bun.spawn
const processesHandler = withAuth<"">(async (): Promise<Response> => {
  try {
    const proc = Bun.spawn(["ps", "aux"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(proc.stdout).text();
    const lines = text.trim().split("\n");
    const processes = lines.slice(1, 21).map((line) => {
      const parts = line.split(/\s+/);
      return {
        user: parts[0],
        pid: parts[1],
        cpu: parts[2],
        mem: parts[3],
        command: parts.slice(10).join(" ").slice(0, 80),
      };
    });
    return json({ processes, count: processes.length, total: lines.length - 1 });
  } catch (err) {
    return json({ error: "process listing failed", details: String(err) }, 500);
  }
});

// Bun.gc + Bun.nanoseconds + Bun.shrink — runtime introspection
// Ref: node_modules/bun-types/bun.d.ts#gc, #nanoseconds, #shrink
const runtimeHandler = withAuth<"">(async (req: BunRequest<"">): Promise<Response> => {
  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "status";
  if (action === "gc") {
    const before = process.memoryUsage();
    Bun.gc(true);
    const after = process.memoryUsage();
    return json({
      action: "gc",
      before: { heapUsed: before.heapUsed, heapTotal: before.heapTotal, rss: before.rss },
      after: { heapUsed: after.heapUsed, heapTotal: after.heapTotal, rss: after.rss },
      freed: before.heapUsed - after.heapUsed,
    });
  } else if (action === "shrink") {
    const before = process.memoryUsage();
    Bun.shrink();
    const after = process.memoryUsage();
    return json({
      action: "shrink",
      before: { rss: before.rss, heapTotal: before.heapTotal },
      after: { rss: after.rss, heapTotal: after.heapTotal },
      freed: before.rss - after.rss,
    });
  } else if (action === "nanoseconds") {
    const start = Bun.nanoseconds();
    for (let i = 0; i < 1000; i++) Math.sqrt(i);
    const end = Bun.nanoseconds();
    return json({
      action: "nanoseconds",
      startNs: start,
      endNs: end,
      elapsedNs: end - start,
      elapsedMs: (end - start) / 1_000_000,
      uptimeNs: start,
      note: "Bun.nanoseconds — nanosecond precision timing since process start",
    });
  }
  const mem = process.memoryUsage();
  return json({
    action: "status",
    uptime: process.uptime(),
    uptimeNs: Bun.nanoseconds(),
    bunVersion: Bun.version,
    pid: process.pid,
    memory: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
    },
    gc: "available via ?action=gc",
    shrink: "available via ?action=shrink",
    nanoseconds: "available via ?action=nanoseconds",
  });
});

// Bun.s3 — offsite backup status
// Ref: node_modules/bun-types/docs/runtime/s3.mdx
const s3BackupHandler = withAuth<"">(async (): Promise<Response> => {
  const s3Bucket = process.env.S3_BUCKET;
  if (!s3Bucket) {
    return json({ s3: "not configured", hint: "set S3_BUCKET env var to enable offsite backups" });
  }
  return json({
    s3: "configured",
    bucket: s3Bucket,
    lastBackup: null,
    nextBackup: "daily at 2 AM (via cron)",
  });
});

// --- Credential management (encrypted at rest via AES-GCM) ------------------
// Ref: src/db/credentials.ts, src/utils/secrets.ts

// List credentials for the authenticated agent (passwords omitted)
const listCredentialsHandler = withAuth<"/api/credentials">(async (_req, ctx): Promise<Response> => {
  const creds = await listCredentials(ctx.agentId);
  return json({ credentials: creds, count: creds.length });
});

// Store or update a credential (encrypts before writing to DB)
const upsertCredentialHandler = withCsrf<"/api/credentials">(async (req, ctx): Promise<Response> => {
  // JUSTIFIED: req.json() returns unknown; narrowing to the credential body shape
  const body = (await req.json()) as { site: string; username: string; password: string };
  if (!body.site || !body.username || !body.password) {
    return errorResponse("site, username, and password required", 400);
  }
  const id = await upsertCredential(ctx.agentId, body.site, body.username, body.password);
  await audit({ action: "credential_upsert", resource: body.site, agent_id: ctx.agentId });
  return json({ ok: true, id, site: body.site });
});

// Delete a credential by site
const deleteCredentialHandler = withCsrf<"/api/credentials/:site">(async (req, ctx): Promise<Response> => {
  const site = req.params.site;
  const deleted = await deleteCredential(ctx.agentId, site);
  if (!deleted) return errorResponse("credential not found", 404);
  await audit({ action: "credential_delete", resource: site, agent_id: ctx.agentId });
  return json({ ok: true, deleted: true, site });
});

// --- Self-update via process.execve (v1.3.14) -------------------------------
// Replaces the current process image with a fresh Bun running the same server.
// Ref: bun-v1.3.14 blog — process.execve(execPath, args, env)
//
// IMPORTANT: This is a fire-and-forget operation. execve() replaces the
// process image in-place and never returns on success. The HTTP response
// will NOT be delivered to the client — the connection will be reset as
// the process is replaced. Clients should treat a connection reset after
// calling this endpoint as a successful update (the audit log entry
// persists in the DB before execve is called).
//
// The handler only returns a Response when execve FAILS (e.g. on Windows
// or in a worker thread). On success, the process is replaced and the
// client sees a connection reset.
const selfUpdateHandler = withCsrf<"/api/admin/update">(async (req, ctx): Promise<Response> => {
  // JUSTIFIED: req.json() returns unknown; narrowing to the update options
  const body = (await req.json()) as { upgrade?: boolean };
  await audit({ action: "self_update", resource: "server", agent_id: ctx.agentId });

  // Optionally run `bun upgrade` first to get the latest version
  if (body.upgrade) {
    try {
      const { $ } = await import("bun");
      const output = await $`bun upgrade`.text();
      log("admin", "info", "bun upgrade completed", { output: output.slice(0, 200) });
    } catch (e) {
      return json({ error: "bun upgrade failed", details: String(e) }, 500);
    }
  }

  // Get the current Bun executable path and script path
  const execPath = process.execPath;
  const scriptPath = process.argv[1] ?? "src/server.ts";
  const args = [scriptPath, ...process.argv.slice(2)];

  log("admin", "info", "self-update: preparing for execve", { execPath, scriptPath });

  // Graceful cleanup before execve — stop server, notify workers, close DB.
  // Without this, workers are orphaned and the DB may not be flushed to disk.
  if (prepareForExecveCallback) {
    try {
      await prepareForExecveCallback();
    } catch (e) {
      log("admin", "error", "pre-execve cleanup failed — proceeding anyway", e);
    }
  }

  // Build the new environment — preserve current env, mark that we self-updated
  const env: Record<string, string> = { ...process.env, BUN_SELF_UPDATED: "1" };

  log("admin", "info", "self-update: replacing process via execve (fire-and-forget)", { execPath, scriptPath });

  // execve never returns on success — the process is replaced in-place.
  // The audit log entry above persists in the DB. The client will see a
  // connection reset (not a clean HTTP response) once the new process starts.
  // On failure, execve throws and we return an error response.
  try {
    // JUSTIFIED: process.execve exists in Bun v1.3.14 per the blog but is not
    // in bun-types. It takes (execPath, args, env) and replaces the process.
    // Ref: bun-v1.3.14 blog — process.execve() support
    // JUSTIFIED: double cast via unknown — execve not in bun-types
    (process as unknown as { execve: (path: string, args: string[], env: Record<string, string>) => void }).execve(
      execPath,
      args,
      env,
    );
    // Unreachable on success — execve replaces the process image.
    // If we reach here, execve failed without throwing (shouldn't happen).
    return json({ error: "execve failed — process was not replaced" }, 500);
  } catch (e) {
    // JUSTIFIED: narrowing unknown catch value to access .code property
    const err = e as { code?: string };
    if (err.code === "ERR_WORKER_UNSUPPORTED_OPERATION") {
      return json({ error: "execve not supported in worker threads" }, 400);
    }
    if (err.code === "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM") {
      return json({ error: "execve not supported on this platform (Windows)" }, 400);
    }
    return json({ error: "self-update failed", details: String(e) }, 500);
  }
});

// --- Route exports ---------------------------------------------------------

export const adminRoutes = router({
  "/api/admin/shell": { POST: adminShellHandler },
  "/api/features/toggle": { POST: featureToggleHandler },
  "/api/logs": { GET: logsHandler },
  "/api/processes": { GET: processesHandler },
  "/api/runtime": { GET: runtimeHandler },
  "/api/s3/backup": { GET: s3BackupHandler },
  "/api/credentials": { GET: listCredentialsHandler, POST: upsertCredentialHandler },
  "/api/credentials/:site": { DELETE: deleteCredentialHandler },
  "/api/admin/update": { POST: selfUpdateHandler },
});
