// Authenticated symmetric encryption for user-supplied secrets at rest.
//
// This is the FIRST user-supplied secret in the app — every provider key today
// (ZERNIO_API_KEY, Anthropic, Apify) is a platform env var. A LeadShark key
// leaked from the DB can send DMs / connection requests from the user's REAL
// LinkedIn account, so we store it encrypted, not plaintext.
//
// AES-256-GCM: authenticated. Any tampering with ciphertext, IV, or auth tag
// makes decrypt() throw rather than silently return garbage — a plain CBC/CTR
// mode would decrypt tampered input to junk without complaint.
//
// Key handling:
//   - CREDENTIAL_ENCRYPTION_KEY is 32 bytes, base64-encoded. Generate with:
//       openssl rand -base64 32
//   - DIFFERENT key per environment. A leaked preview key must never decrypt a
//     production ciphertext.
//   - Losing the key makes every stored credential permanently undecryptable.
//     That is intended — the alternative (a recoverable key) is a weaker secret.
//   - key_version is stamped on every ciphertext so a future rotation is
//     additive: decrypt reads the version, encrypt always writes the current one.
//
// Fail-closed posture mirrors the cron secret at
// app/api/cron/publish-scheduled/route.ts — a missing/malformed key is a
// deploy-time misconfiguration, and we would rather the feature refuse to
// operate than write credentials we can never read back (or, worse, "encrypt"
// under a zero/placeholder key).

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // 96-bit nonce — the GCM standard/recommended size
const CURRENT_KEY_VERSION = 1;

export type EncryptedSecret = {
  ciphertext: string; // base64
  iv: string; // base64
  authTag: string; // base64
  keyVersion: number;
};

// ---------------------------------------------------------------------------
// Key loading — resolved lazily and cached, but VALIDATED eagerly at module
// load so a misconfigured deploy fails fast and loudly instead of at the first
// encrypt() call buried inside a request. `assertKeyConfigured()` runs at the
// bottom of this file.
// ---------------------------------------------------------------------------

let cachedKey: Buffer | null = null;

function loadKey(): Buffer {
  if (cachedKey) return cachedKey;

  const raw = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!raw || raw.trim() === "") {
    throw new Error(
      "CREDENTIAL_ENCRYPTION_KEY is not set. Generate one with `openssl rand -base64 32` " +
        "and add it to the environment (a DIFFERENT value per environment).",
    );
  }

  const normalized = raw.trim();
  // Buffer.from(..., "base64") silently ignores invalid characters. Validate
  // the complete padded base64 shape before decoding so a typo cannot be
  // accepted as a different key just because lenient decoding produced 32
  // bytes.
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      normalized,
    )
  ) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY is not valid base64.");
  }

  let decoded: Buffer;
  try {
    decoded = Buffer.from(normalized, "base64");
  } catch {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY is not valid base64.");
  }

  if (decoded.length !== KEY_BYTES) {
    throw new Error(
      `CREDENTIAL_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes (got ${decoded.length}). ` +
        "Generate a correct key with `openssl rand -base64 32`.",
    );
  }

  cachedKey = decoded;
  return cachedKey;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Encrypt a plaintext secret. Returns the ciphertext plus the parameters needed
 * to decrypt it — all base64. A fresh random IV is generated per call and is
 * never reused across encryptions (nonce reuse under GCM is catastrophic).
 */
export function encryptSecret(plaintext: string): EncryptedSecret {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("encryptSecret: plaintext must be a non-empty string.");
  }
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    keyVersion: CURRENT_KEY_VERSION,
  };
}

/**
 * Decrypt a secret produced by {@link encryptSecret}. Throws if the key is
 * missing, if the ciphertext/IV/tag have been tampered with, or if the stored
 * key_version is one we can no longer decrypt.
 */
export function decryptSecret(parts: EncryptedSecret): string {
  const { ciphertext, iv, authTag, keyVersion } = parts;
  if (keyVersion !== CURRENT_KEY_VERSION) {
    // With only one key version today this is always a corruption/config
    // signal. When rotation lands, this branch selects the historical key.
    throw new Error(
      `Cannot decrypt: unknown key_version ${keyVersion} (current is ${CURRENT_KEY_VERSION}).`,
    );
  }
  const key = loadKey();
  const decipher = createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(authTag, "base64"));
  // decipher.final() throws if the auth tag doesn't verify — this is where
  // tampering is caught. Callers treat any throw as "credential unreadable".
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

/**
 * A display-only, non-reversible hint for a secret — the last 4 chars of a
 * SHA-256 of the plaintext, e.g. "••••3f9a". Safe to store and show in the UI:
 * it identifies WHICH key is connected (so a user can tell if it changed)
 * without revealing any part of the key itself. Never derive this from the raw
 * key substring — that would leak real key bytes.
 */
export function keyHint(plaintext: string): string {
  const digest = createHash("sha256").update(plaintext, "utf8").digest("hex");
  return `••••${digest.slice(-4)}`;
}

// Eager fail-closed validation. Importing this module on a deploy with a
// missing/malformed key throws here, which surfaces the misconfiguration at the
// route/module boundary rather than deep inside a request handler.
function assertKeyConfigured(): void {
  loadKey();
}

assertKeyConfigured();
