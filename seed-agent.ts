import { migrate, write } from "./src/db";

migrate();
const hash = await Bun.password.hash("test123");
const id = await write((db) => {
  const r = db.query("INSERT INTO agents (username, password) VALUES (?, ?)").run("testagent", hash);
  return Number(r.lastInsertRowid);
});
console.log("agent id:", id);
