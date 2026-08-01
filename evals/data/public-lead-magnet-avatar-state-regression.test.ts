import { describe, expect, test } from "vitest";
import { shouldRenderPublicLeadMagnetAvatar } from "@/app/lm/[slug]/public-lead-magnet-avatar";

describe("public lead-magnet avatar state", () => {
  test("tries a new avatar URL after the previous URL failed", () => {
    expect(
      shouldRenderPublicLeadMagnetAvatar(
        "https://images.example.com/fresh.jpg",
        "https://images.example.com/expired.jpg",
      ),
    ).toBe(true);
  });

  test("uses the initials fallback only for the URL that failed", () => {
    expect(
      shouldRenderPublicLeadMagnetAvatar(
        "https://images.example.com/expired.jpg",
        "https://images.example.com/expired.jpg",
      ),
    ).toBe(false);
    expect(shouldRenderPublicLeadMagnetAvatar(null, null)).toBe(false);
  });
});
