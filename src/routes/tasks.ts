// Task CRUD and JSONL export routes.
//
// Ref: https://bun.com/docs/runtime/http/routing

import { read, write } from "../db";
import { audit } from "../db/audit";
import { CountRow, TaskListRow, TaskRow } from "../types/models";
import { log } from "../utils/log";
import { submitTask } from "../workers/pool";
import { router } from "./router";
import { errorResponse, getClientIP, json, withAuth, withCsrf } from "./shared";

// --- Handlers ---------------------------------------------------------------

const listTasksHandler = withAuth<"">((req, ctx) => {
  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
  const status = url.searchParams.get("status");

  // m4: Single parameterized query instead of two different SQL strings.
  // E3: IDOR fix — only list tasks owned by the authenticated agent.
  const tasks = read((db) => {
    return db
      .query(
        `SELECT id, agent_id, url, status, progress, priority, error, created_at, updated_at, completed_at
       FROM tasks WHERE agent_id = ? AND (? IS NULL OR status = ?)
       ORDER BY priority DESC, created_at DESC LIMIT ? OFFSET ?`,
      )
      .as(TaskListRow)
      .all(ctx.agentId, status, status, limit, offset);
  });

  const total = read((db) => {
    const row = db.query("SELECT COUNT(*) as count FROM tasks WHERE agent_id = ?").as(CountRow).get(ctx.agentId);
    return row?.count ?? 0;
  });

  return json({ tasks, total, limit, offset });
});

// Streaming JSONL export of tasks — same query as /tasks but as JSONL lines
// Ref: node_modules/bun-types/docs/runtime/jsonl.mdx
// Ref: node_modules/bun-types/docs/runtime/streams.mdx
const tasksJsonlHandler = withAuth<"">((req, ctx) => {
  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
  const status = url.searchParams.get("status");
  const tasks = read((db) => {
    return db
      .query(
        `SELECT id, agent_id, url, status, progress, priority, error, created_at, updated_at, completed_at
       FROM tasks WHERE agent_id = ? AND (? IS NULL OR status = ?)
       ORDER BY priority DESC, created_at DESC LIMIT ? OFFSET ?`,
      )
      .as(TaskListRow)
      .all(ctx.agentId, status, status, limit, offset);
  });
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const task of tasks) {
        controller.enqueue(encoder.encode(JSON.stringify(task) + "\n"));
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/jsonl" } });
});

const createTaskHandler = withCsrf<"">(async (req, ctx) => {
  try {
    // JUSTIFIED: req.json() returns unknown; narrowing to the task creation body shape
    const body = (await req.json()) as {
      agent_id: number;
      url: string;
      proxy?: string;
      user_agent?: string;
      priority?: number;
    };

    if (!body.url) {
      return errorResponse("url is required", 400);
    }

    // E3: IDOR fix — force agent_id to the authenticated agent's ID.
    const agentId = ctx.agentId;

    try {
      new URL(body.url);
    } catch {
      return errorResponse("invalid url", 400);
    }

    const ip = getClientIP(req);
    const taskId = await write((db) => {
      const result = db
        .query(
          `INSERT INTO tasks (agent_id, url, proxy, user_agent, priority)
         VALUES (?, ?, ?, ?, ?)`,
        )
        .run(agentId, body.url, body.proxy ?? null, body.user_agent ?? null, body.priority ?? 0);
      return Number(result.lastInsertRowid);
    });

    await audit({ agent_id: agentId, action: "task_created", resource: `task:${taskId}`, ip_address: ip });

    // Submit to worker pool (async — don't await)
    // D1: If the worker crashes, mark the task as failed in the DB.
    submitTask(taskId).catch(async (err) => {
      log("server", "error", `task ${taskId} failed`, err);
      try {
        await write((db) => {
          db.query(
            `UPDATE tasks SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ? AND status = 'running'`,
          ).run(err instanceof Error ? err.message : String(err), taskId);
        });
      } catch (dbErr) {
        log("server", "error", `failed to mark task ${taskId} as failed`, dbErr);
      }
    });

    return json({ id: taskId, status: "pending" }, 201);
  } catch {
    return errorResponse("invalid request body", 400);
  }
});

const getTaskHandler = withAuth<"/task/:id">((req, ctx) => {
  const taskId = parseInt(req.params.id, 10);
  // E3: IDOR fix — only return the task if it belongs to the authenticated agent
  const task = read((db) => {
    return db.query("SELECT * FROM tasks WHERE id = ? AND agent_id = ?").as(TaskRow).get(taskId, ctx.agentId);
  });

  if (!task) return errorResponse("task not found", 404);
  return json(task);
});

// --- Route exports ---------------------------------------------------------

export const taskRoutes = router({
  "/tasks": { GET: listTasksHandler },
  "/api/tasks.jsonl": { GET: tasksJsonlHandler },
  "/task": { POST: createTaskHandler },
  "/task/:id": { GET: getTaskHandler },
});
