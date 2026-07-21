import { describe, test, expect, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Unit tests for lib/crypto.ts — the AES-256-GCM secret box behind LeadShark
// (and future third-party) credential storage.
//
// IMPORTANT: lib/crypto.ts fails CLOSED at import time — importing it with a
// missing/malformed CREDENTIAL_ENCRYPTION_KEY throws. So:
//   - The happy-path / tamper suites set a valid key, then `import()` the module
//     dynamically (after the env is in place).
//   - The fail-closed suite `import()`s in a child scope with the env removed /
//     corrupted and asserts the throw. Each uses `vi.resetModules()` semantics
//     via a fresh dynamic import path + query bust so the module-load side effect
//     re-runs per case.
// ---------------------------------------------------------------------------

const VALID_KEY = randomBytes(32).toString("base64");

// Load the module under a specific env. Node caches modules by resolved URL, so
// we bust the cache with a unique query string to force the module-load
// validation to re-run for each fail-closed case.
async function loadCryptoWith(
  keyValue: string | undefined,
): Promise<typeof import("@/lib/crypto")> {
  const prev = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (keyValue === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
  else process.env.CREDENTIAL_ENCRYPTION_KEY = keyValue;
  try {
    const mod = (await import(
      /* @vite-ignore */ `@/lib/crypto?bust=${randomBytes(6).toString("hex")}`
    )) as typeof import("@/lib/crypto");
    return mod;
  } finally {
    if (prev === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    else process.env.CREDENTIAL_ENCRYPTION_KEY = prev;
  }
}

describe("crypto round-trip", () => {
  let crypto: typeof import("@/lib/crypto");

  beforeAll(async () => {
    crypto = await loadCryptoWith(VALID_KEY);
  });

  test("encrypt → decrypt returns the original plaintext", () => {
    const secret = "ls_live_abc123_a-real-looking-leadshark-key";
    const box = crypto.encryptSecret(secret);
    expect(crypto.decryptSecret(box)).toBe(secret);
  });

  test("round-trips unicode and long strings", () => {
    const secret = "kéy-with-émojis-🔐-and-길이-" + "x".repeat(2000);
    expect(crypto.decryptSecret(crypto.encryptSecret(secret))).toBe(secret);
  });

  test("ciphertext is not the plaintext and uses a fresh IV each call", () => {
    const secret = "same-input-twice";
    const a = crypto.encryptSecret(secret);
    const b = crypto.encryptSecret(secret);
    // Different IVs → different ciphertext for identical input (no nonce reuse).
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    // Ciphertext (base64) never contains the raw plaintext.
    expect(Buffer.from(a.ciphertext, "base64").toString("utf8")).not.toContain(
      secret,
    );
    // Both still decrypt to the same secret.
    expect(crypto.decryptSecret(a)).toBe(secret);
    expect(crypto.decryptSecret(b)).toBe(secret);
  });

  test("stamps the current key_version", () => {
    expect(crypto.encryptSecret("x").keyVersion).toBe(1);
  });

  test("encryptSecret rejects empty input", () => {
    expect(() => crypto.encryptSecret("")).toThrow();
  });
});

describe("crypto tamper detection", () => {
  let crypto: typeof import("@/lib/crypto");

  beforeAll(async () => {
    crypto = await loadCryptoWith(VALID_KEY);
  });

  function flipOneBase64Char(b64: string): string {
    // Replace the last non-padding char with a different one, preserving length.
    const i = b64.replace(/=+$/, "").length - 1;
    const c = b64[i];
    const swap = c === "A" ? "B" : "A";
    return b64.slice(0, i) + swap + b64.slice(i + 1);
  }

  test("tampered ciphertext throws (auth tag fails)", () => {
    const box = crypto.encryptSecret("deliver-me-intact");
    const tampered = { ...box, ciphertext: flipOneBase64Char(box.ciphertext) };
    expect(() => crypto.decryptSecret(tampered)).toThrow();
  });

  test("tampered auth tag throws", () => {
    const box = crypto.encryptSecret("deliver-me-intact");
    const tampered = { ...box, authTag: flipOneBase64Char(box.authTag) };
    expect(() => crypto.decryptSecret(tampered)).toThrow();
  });

  test("tampered IV throws", () => {
    const box = crypto.encryptSecret("deliver-me-intact");
    const tampered = { ...box, iv: flipOneBase64Char(box.iv) };
    expect(() => crypto.decryptSecret(tampered)).toThrow();
  });

  test("unknown key_version throws rather than silently mis-decrypting", () => {
    const box = crypto.encryptSecret("x");
    expect(() => crypto.decryptSecret({ ...box, keyVersion: 99 })).toThrow(
      /key_version/,
    );
  });

  test("a DIFFERENT key cannot decrypt (cross-environment isolation)", async () => {
    const box = crypto.encryptSecret("prod-only-secret");
    const otherEnvCrypto = await loadCryptoWith(randomBytes(32).toString("base64"));
    expect(() => otherEnvCrypto.decryptSecret(box)).toThrow();
  });
});

describe("keyHint", () => {
  let crypto: typeof import("@/lib/crypto");

  beforeAll(async () => {
    crypto = await loadCryptoWith(VALID_KEY);
  });

  test("is masked, fixed-shape, and reveals no raw key bytes", () => {
    const key = "ls_live_SUPERSECRET_do_not_leak";
    const hint = crypto.keyHint(key);
    expect(hint).toMatch(/^••••[0-9a-f]{4}$/);
    // The hint is a hash tail, so it must NOT be a substring of the real key.
    expect(key).not.toContain(hint.replace("••••", ""));
  });

  test("is stable for the same input and differs across inputs", () => {
    expect(crypto.keyHint("abc")).toBe(crypto.keyHint("abc"));
    expect(crypto.keyHint("abc")).not.toBe(crypto.keyHint("abd"));
  });
});

describe("crypto fails closed on misconfiguration", () => {
  test("missing key throws at module load", async () => {
    await expect(loadCryptoWith(undefined)).rejects.toThrow(
      /CREDENTIAL_ENCRYPTION_KEY is not set/,
    );
  });

  test("empty key throws at module load", async () => {
    await expect(loadCryptoWith("   ")).rejects.toThrow(
      /CREDENTIAL_ENCRYPTION_KEY is not set/,
    );
  });

  test("wrong-length key throws at module load", async () => {
    // 16 bytes, not 32.
    await expect(
      loadCryptoWith(randomBytes(16).toString("base64")),
    ).rejects.toThrow(/32 bytes/);
  });
});
