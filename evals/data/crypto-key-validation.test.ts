import { afterEach, describe, expect, test, vi } from "vitest";

describe("credential encryption key validation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  test("rejects invalid base64 characters even when lenient decoding has 32 bytes", async () => {
    const validKey = Buffer.alloc(32, 7).toString("base64");
    vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", `${validKey}!`);

    await expect(import("@/lib/crypto")).rejects.toThrow(
      "CREDENTIAL_ENCRYPTION_KEY is not valid base64",
    );
  });
});
