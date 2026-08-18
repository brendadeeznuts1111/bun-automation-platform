import { beforeAll, expect, test } from "bun:test";
import { migrate, read, write } from "../src/db";
import { deleteCredential, getCredential, listCredentials, upsertCredential } from "../src/db/credentials";
import { decrypt, encrypt, getMasterKey } from "../src/utils/secrets";

// Use unique usernames per test run to avoid conflicts with other test files
// that share the same temp DB. The usernames include a timestamp suffix.
const SUFFIX = `${process.pid}-${Date.now()}`;
const AGENT1_USER = `cred-test-1-${SUFFIX}`;
const AGENT2_USER = `cred-test-2-${SUFFIX}`;
let agent1Id = 0;
let agent2Id = 0;

beforeAll(async () => {
  // DB_PATH is set by tests/setup.ts preload — just ensure schema is migrated
  migrate();
  // Create test agents (foreign key constraint requires them to exist)
  // Use unique usernames to avoid conflicts with other test files
  agent1Id = await write((db) => {
    const r = db.query("INSERT INTO agents (username, password) VALUES (?, 'hash1')").run(AGENT1_USER);
    return Number(r.lastInsertRowid);
  });
  agent2Id = await write((db) => {
    const r = db.query("INSERT INTO agents (username, password) VALUES (?, 'hash2')").run(AGENT2_USER);
    return Number(r.lastInsertRowid);
  });
  // Verify agents are visible
  const check = read((db) => db.query("SELECT id FROM agents WHERE username = ?").get(AGENT1_USER));
  if (!check) throw new Error("test setup failed: agent1 not visible after insert");
});

test("AES-GCM encrypt/decrypt roundtrip", async () => {
  const plaintext = "super-secret-password-123!@#";
  const encrypted = await encrypt(plaintext);
  // Encrypted output should be base64 and different from plaintext
  expect(encrypted).not.toBe(plaintext);
  expect(encrypted.length).toBeGreaterThan(0);
  // Decrypt should recover the original
  const decrypted = await decrypt(encrypted);
  expect(decrypted).toBe(plaintext);
});

test("AES-GCM produces different ciphertexts for same plaintext (random IV)", async () => {
  const plaintext = "same-password";
  const enc1 = await encrypt(plaintext);
  const enc2 = await encrypt(plaintext);
  // Different IVs mean different ciphertexts
  expect(enc1).not.toBe(enc2);
  // Both decrypt to the same plaintext
  expect(await decrypt(enc1)).toBe(plaintext);
  expect(await decrypt(enc2)).toBe(plaintext);
});

test("AES-GCM decrypt fails on tampered ciphertext", async () => {
  const encrypted = await encrypt("secret");
  // Tamper with the ciphertext (flip a byte in the middle)
  const tampered = encrypted.slice(0, -4) + "AAAA";
  await expect(decrypt(tampered)).rejects.toThrow();
});

test("getMasterKey returns a non-empty key", async () => {
  const key = await getMasterKey();
  expect(key).toBeTruthy();
  expect(key.length).toBeGreaterThan(0);
  // Second call should return the same key (cached/stored)
  const key2 = await getMasterKey();
  expect(key2).toBe(key);
});

test("credential CRUD — encrypts at rest, decrypts on read", async () => {
  const agentId = agent1Id;
  const site = "example.com";
  const username = "testuser";
  const password = "testpass123";

  // Store
  const id = await upsertCredential(agentId, site, username, password);
  expect(id).toBeGreaterThan(0);

  // Read back — should decrypt
  const cred = await getCredential(agentId, site);
  expect(cred).not.toBeNull();
  expect(cred!.username).toBe(username);
  expect(cred!.password).toBe(password);
  expect(cred!.site).toBe(site);

  // List — passwords omitted
  const creds = await listCredentials(agentId);
  expect(creds.length).toBeGreaterThan(0);
  const found = creds.find((c) => c.site === site);
  expect(found).toBeDefined();
  expect(found!.username).toBe(username);
  // Password should NOT be in the list response
  // JUSTIFIED: double cast via unknown — accessing password field not in list type
  expect((found as unknown as Record<string, unknown>).password).toBeUndefined();

  // Update
  await upsertCredential(agentId, site, "newuser", "newpass");
  const updated = await getCredential(agentId, site);
  expect(updated!.username).toBe("newuser");
  expect(updated!.password).toBe("newpass");

  // Delete
  const deleted = await deleteCredential(agentId, site);
  expect(deleted).toBe(true);
  const gone = await getCredential(agentId, site);
  expect(gone).toBeNull();

  // Delete again — should return false
  const deletedAgain = await deleteCredential(agentId, site);
  expect(deletedAgain).toBe(false);
});

test("credentials are isolated per agent", async () => {
  await upsertCredential(agent1Id, "site-a.com", "user1", "pass1");
  await upsertCredential(agent2Id, "site-a.com", "user2", "pass2");

  const cred1 = await getCredential(agent1Id, "site-a.com");
  const cred2 = await getCredential(agent2Id, "site-a.com");
  expect(cred1!.username).toBe("user1");
  expect(cred2!.username).toBe("user2");

  // Agent 1 can't see agent 2's credentials
  const agent1Creds = await listCredentials(agent1Id);
  expect(agent1Creds.every((c) => c.agent_id === agent1Id)).toBe(true);
});
