import { migrate, write } from "./src/db";

migrate();
const hash = await Bun.password.hash("test123");
const id = await write((db) => {
  const row = db
    .query(
      `INSERT INTO agents (username, password) VALUES (?, ?)
       ON CONFLICT(username) DO UPDATE SET password = excluded.password, updated_at = datetime('now')
       RETURNING id;`,
    )
    // JUSTIFIED: bun:sqlite .get() returns unknown; narrowing to the RETURNING row type
    .get("testagent", hash) as { id: number } | null;
  return row?.id ?? 0;
});
console.log("agent id:", id);
