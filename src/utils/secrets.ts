/**
 * Secrets utility — OS-native credential storage via Bun.secrets
 * + AES-GCM encryption for the credentials table.
 *
 * Replaces plaintext .env secrets with OS keychain:
 *   - macOS: Keychain
 *   - Windows: Credential Manager
 *   - Linux: libsecret (GNOME Keyring / KDE Wallet)
 *
 * The credentials table stores `username_enc` / `password_enc` columns.
 * Values are encrypted with AES-GCM using a master key from the OS keychain.
 * The master key never touches the database or disk.
 *
 * Ref: node_modules/bun-types/docs/runtime/secrets.mdx
 * Ref: https://bun.com/docs/runtime/secrets
 * Ref: https://developer.mozilla.org/en-US/docs/Web/API/AesGcmParams
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

// --- Master key -------------------------------------------------------------

/**
 * Get the master encryption key for credential encryption.
 * If not in keychain, generates a random one and stores it.
 * Falls back to env var MASTER_KEY if keychain is unavailable.
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

// --- AES-GCM encryption -----------------------------------------------------
// Ref: https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/encrypt
//
// Format: base64(iv:ciphertext) — the IV is prepended to the ciphertext
// and extracted on decrypt. This is the standard pattern for AES-GCM.

/** Cached CryptoKey derived from the master key (avoids re-deriving on every call). */
let cachedCryptoKey: CryptoKey | null = null;
let cachedMasterKey: string | null = null;

/**
 * Derive an AES-GCM CryptoKey from the master key using PBKDF2.
 * The key is cached for the process lifetime — re-deriving on every call
 * would be expensive (PBKDF2 with 100k iterations).
 *
 * Ref: https://developer.mozilla.org/en-US/docs/Web/API/Pbkdf2Params
 */
async function getCryptoKey(): Promise<CryptoKey> {
  const masterKey = await getMasterKey();
  if (cachedCryptoKey && cachedMasterKey === masterKey) {
    return cachedCryptoKey;
  }
  cachedMasterKey = masterKey;
  // Derive a 256-bit AES key from the master key via PBKDF2
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(masterKey), "PBKDF2", false, [
    "deriveKey",
  ]);
  cachedCryptoKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: new TextEncoder().encode("bun-dev-credentials-salt"),
      iterations: 100_000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  return cachedCryptoKey;
}

/**
 * Encrypt a plaintext string using AES-GCM.
 * Returns base64(iv:ciphertext) — the IV is prepended for transport.
 */
export async function encrypt(plaintext: string): Promise<string> {
  const key = await getCryptoKey();
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV for AES-GCM
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  // Combine IV + ciphertext into a single buffer, then base64
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypt a base64(iv:ciphertext) string back to plaintext.
 * Throws if the key is wrong or the data is corrupted (AES-GCM authenticates).
 */
export async function decrypt(encrypted: string): Promise<string> {
  const key = await getCryptoKey();
  const combined = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(decrypted);
}
