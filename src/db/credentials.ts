/**
 * Credentials storage — encrypted username/password per agent + site.
 *
 * Uses AES-GCM encryption (via src/utils/secrets.ts) so that plaintext
 * credentials never touch the database file. The master key is stored
 * in the OS keychain (Bun.secrets) and never written to disk.
 *
 * Ref: node_modules/bun-types/docs/runtime/sqlite.mdx
 * Ref: node_modules/bun-types/docs/runtime/secrets.mdx
 */

import { log } from "../utils/log";
import { decrypt, encrypt } from "../utils/secrets";
import { read, write } from "./index";

/** Plaintext credential (after decryption). */
export interface Credential {
  id: number;
  agent_id: number;
  site: string;
  username: string;
  password: string;
  created_at: string;
  updated_at: string;
}

/** Encrypted row from the database. */
class CredentialRow {
  id!: number;
  agent_id!: number;
  site!: string;
  username_enc!: string;
  password_enc!: string;
  created_at!: string;
  updated_at!: string;
}

/**
 * List all credentials for an agent, decrypting usernames and passwords.
 */
export async function listCredentials(agentId: number): Promise<Omit<Credential, "password">[]> {
  const rows = read((db) => {
    return db
      .query(
        "SELECT id, agent_id, site, username_enc, password_enc, created_at, updated_at FROM credentials WHERE agent_id = ? ORDER BY site",
      )
      .as(CredentialRow)
      .all(agentId);
  });
  // Decrypt usernames only — passwords are omitted from list views
  return Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      agent_id: r.agent_id,
      site: r.site,
      username: await decrypt(r.username_enc),
      created_at: r.created_at,
      updated_at: r.updated_at,
    })),
  );
}

/**
 * Get a single credential (including password) by agent + site.
 * Used when a worker needs the actual credentials to log in.
 */
export async function getCredential(agentId: number, site: string): Promise<Credential | null> {
  const row = read((db) => {
    return db
      .query(
        "SELECT id, agent_id, site, username_enc, password_enc, created_at, updated_at FROM credentials WHERE agent_id = ? AND site = ?",
      )
      .as(CredentialRow)
      .get(agentId, site);
  });
  if (!row) return null;
  const [username, password] = await Promise.all([decrypt(row.username_enc), decrypt(row.password_enc)]);
  return {
    id: row.id,
    agent_id: row.agent_id,
    site: row.site,
    username,
    password,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Store or update a credential. Encrypts before writing to the database.
 * If a credential for (agent_id, site) already exists, it's updated.
 */
export async function upsertCredential(
  agentId: number,
  site: string,
  username: string,
  password: string,
): Promise<number> {
  const [usernameEnc, passwordEnc] = await Promise.all([encrypt(username), encrypt(password)]);
  const result = await write((db) => {
    const r = db
      .query(
        `INSERT INTO credentials (agent_id, site, username_enc, password_enc)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(agent_id, site) DO UPDATE SET
         username_enc = excluded.username_enc,
         password_enc = excluded.password_enc,
         updated_at = datetime('now')`,
      )
      .run(agentId, site, usernameEnc, passwordEnc);
    return Number(r.lastInsertRowid);
  });
  log("server", "info", "Credential stored", { agentId, site });
  return result;
}

/**
 * Delete a credential by agent + site.
 */
export async function deleteCredential(agentId: number, site: string): Promise<boolean> {
  const result = await write((db) => {
    const r = db.query("DELETE FROM credentials WHERE agent_id = ? AND site = ?").run(agentId, site);
    return r.changes > 0;
  });
  if (result) {
    log("server", "info", "Credential deleted", { agentId, site });
  }
  return result;
}
