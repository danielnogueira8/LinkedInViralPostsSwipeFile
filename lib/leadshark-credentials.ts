// LeadShark credential storage — the ONLY module that touches the encrypted
// columns of integration_credentials (migration 120).
//
// Everything outside this file works with the SAFE projection
// (LeadSharkCredentialSafe): { connected, status, keyHint, lastVerifiedAt }.
// The plaintext key is decrypted at point of use via getDecryptedKey() and is
// never assigned to anything that outlives the request/job.
//
// Isolation is enforced at the app layer: every query carries an explicit
// .eq("workspace_id", workspaceId). We use supabaseAdmin() (service role,
// bypasses RLS) — so RLS is defense-in-depth, and the .eq() is load-bearing.
// Callers pass workspaceId explicitly so this works in both a request (Clerk
// session) and a cron/background-job context (no session).

import { supabaseAdmin } from "@/lib/supabase";
import { encryptSecret, decryptSecret, keyHint } from "@/lib/crypto";

const PROVIDER = "leadshark" as const;

export type CredentialStatus = "active" | "invalid" | "revoked";

// Safe-to-return shape. Deliberately omits ciphertext / iv / auth_tag.
export type LeadSharkCredentialSafe = {
  connected: boolean;
  status: CredentialStatus;
  keyHint: string | null;
  lastVerifiedAt: string | null;
  lastError: string | null;
};

// Columns that carry the secret. Selected ONLY inside getDecryptedKey().
type SecretRow = {
  ciphertext: string;
  iv: string;
  auth_tag: string;
  key_version: number;
  status: CredentialStatus;
};

const SAFE_COLS = "status, key_hint, last_verified_at, last_error";

function throwOnDbError(error: unknown): void {
  if (!error) return;
  if (error instanceof Error) throw error;
  const message =
    typeof error === "object" && error && "message" in error
      ? String((error as { message: unknown }).message)
      : "Database operation failed";
  throw new Error(message, { cause: error });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The safe, UI/API-facing view of the workspace's LeadShark credential.
 * Returns a not-connected shape (never null-throws) when none exists.
 */
export async function getCredentialSafe(
  workspaceId: string,
): Promise<LeadSharkCredentialSafe> {
  const { data, error } = await supabaseAdmin()
    .from("integration_credentials")
    .select(SAFE_COLS)
    .eq("workspace_id", workspaceId)
    .eq("provider", PROVIDER)
    .maybeSingle();
  throwOnDbError(error);

  if (!data) {
    return {
      connected: false,
      status: "revoked",
      keyHint: null,
      lastVerifiedAt: null,
      lastError: null,
    };
  }
  const row = data as {
    status: CredentialStatus;
    key_hint: string | null;
    last_verified_at: string | null;
    last_error: string | null;
  };
  return {
    connected: row.status === "active",
    status: row.status,
    keyHint: row.key_hint,
    lastVerifiedAt: row.last_verified_at,
    lastError: row.last_error,
  };
}

/**
 * Decrypt and return the plaintext API key for server-side use (validation
 * re-checks, the binding job, stats sync). Returns null if there is no active
 * credential. The returned string must NOT be stored — decrypt at each use.
 *
 * Throws only on a genuine decrypt failure (tampering / wrong key), which is a
 * real error the caller should surface, not swallow.
 */
export async function getDecryptedKey(
  workspaceId: string,
): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from("integration_credentials")
    .select("ciphertext, iv, auth_tag, key_version, status")
    .eq("workspace_id", workspaceId)
    .eq("provider", PROVIDER)
    .maybeSingle();
  throwOnDbError(error);
  if (!data) return null;

  const row = data as SecretRow;
  if (row.status !== "active") return null;

  return decryptSecret({
    ciphertext: row.ciphertext,
    iv: row.iv,
    authTag: row.auth_tag,
    keyVersion: row.key_version,
  });
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Encrypt and upsert a validated LeadShark key. Caller MUST have already
 * verified the key against the live API — we never store an unvalidated key
 * (a key that fails at connect fails silently at publish, a far worse place to
 * discover it). Marks the credential active + stamps last_verified_at now.
 *
 * Returns the safe projection for the response — never the key.
 */
export async function storeVerifiedCredential(
  workspaceId: string,
  apiKey: string,
): Promise<LeadSharkCredentialSafe> {
  const box = encryptSecret(apiKey);
  const hint = keyHint(apiKey);
  const now = new Date().toISOString();

  const { error } = await supabaseAdmin()
    .from("integration_credentials")
    .upsert(
      {
        workspace_id: workspaceId,
        provider: PROVIDER,
        ciphertext: box.ciphertext,
        iv: box.iv,
        auth_tag: box.authTag,
        key_version: box.keyVersion,
        key_hint: hint,
        status: "active",
        last_verified_at: now,
        last_error: null,
        updated_at: now,
      },
      { onConflict: "workspace_id,provider" },
    );
  throwOnDbError(error);

  return {
    connected: true,
    status: "active",
    keyHint: hint,
    lastVerifiedAt: now,
    lastError: null,
  };
}

/**
 * Flip a credential to `invalid` (e.g. after a 401 at publish/bind time) and
 * record why. Does NOT delete the ciphertext — the user reconnects by pasting a
 * fresh key, which upserts over it. No-op if there's no row.
 */
export async function markInvalid(
  workspaceId: string,
  reason: string,
): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("integration_credentials")
    .update({
      status: "invalid",
      last_error: reason,
      updated_at: new Date().toISOString(),
    })
    .eq("workspace_id", workspaceId)
    .eq("provider", PROVIDER);
  throwOnDbError(error);
}

/** Stamp a successful verification (used by re-validation paths). No-op if no row. */
export async function markVerified(workspaceId: string): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabaseAdmin()
    .from("integration_credentials")
    .update({ status: "active", last_verified_at: now, last_error: null, updated_at: now })
    .eq("workspace_id", workspaceId)
    .eq("provider", PROVIDER);
  throwOnDbError(error);
}

/**
 * Delete the workspace's LeadShark credential entirely (Disconnect). Hard
 * delete — the whole point of Disconnect is that the ciphertext is gone.
 */
export async function deleteCredential(workspaceId: string): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("integration_credentials")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("provider", PROVIDER);
  throwOnDbError(error);
}
