/**
 * Secrets utility — OS-native credential storage via Bun.secrets.
 *
 * Replaces plaintext .env secrets with OS keychain:
 *   - macOS: Keychain
 *   - Windows: Credential Manager
 *   - Linux: libsecret (GNOME Keyring / KDE Wallet)
 *
 * Ref: node_modules/bun-types/docs/runtime/secrets.mdx
 * Ref: https://bun.com/docs/runtime/secrets
 */

import { secrets } from "bun";

const SERVICE = "bun-dev";

/**
 * Get a secret from OS keychain, falling back to env var if not stored.
 * This allows gradual migration — env vars still work, but secrets
 * take precedence when available.
 */
export async function getSecret(name: string): Promise<string | null> {
  // Try OS keychain first
  try {
    const stored = await secrets.get({ service: SERVICE, name });
    if (stored) return stored;
  } catch {
    // Keychain not available (headless Linux without libsecret, etc.)
    // Fall through to env var
  }
  // Fall back to environment variable
  return process.env[name] ?? null;
}

/**
 * Store a secret in the OS keychain.
 */
export async function setSecret(name: string, value: string): Promise<void> {
  await secrets.set({ service: SERVICE, name, value });
}

/**
 * Delete a secret from the OS keychain.
 */
export async function deleteSecret(name: string): Promise<void> {
  await secrets.delete({ service: SERVICE, name });
}

/**
 * Get the master encryption key for credential encryption.
 * If not in keychain, generates a random one and stores it.
 */
export async function getMasterKey(): Promise<string> {
  let key = await getSecret("MASTER_KEY");
  if (!key) {
    // Generate a secure random key and store it
    key = crypto.randomUUID() + crypto.randomUUID();
    await setSecret("MASTER_KEY", key);
    console.log("[secrets] generated new MASTER_KEY and stored in OS keychain");
  }
  return key;
}
