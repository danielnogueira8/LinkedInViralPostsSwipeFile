import { describe, expect, test } from "vitest";

import { normalizeLinkedInProfileUrl as normalizeTracked } from "@/lib/tracked-creators";
import { normalizeProfileUrl as normalizeMcp } from "@/lib/mcp/util";

describe("LinkedIn profile URL normalization", () => {
  test("rejects host-blind lookalikes in both adapters", () => {
    const hostileUrls = [
      "https://example.com/linkedin.com/in/creator",
      "https://linkedin.com.evil.test/in/creator",
      "http://www.linkedin.com/in/creator",
    ];

    for (const url of hostileUrls) {
      expect(normalizeTracked(url)).toBeNull();
      expect(normalizeMcp(url)).toBeNull();
    }
  });

  test("keeps the supported bare-host input shape", () => {
    expect(normalizeTracked("linkedin.com/in/Creator/")).toBe(
      "https://www.linkedin.com/in/creator",
    );
    expect(normalizeMcp("linkedin.com/in/Creator/")).toBe(
      "https://www.linkedin.com/in/creator",
    );
  });
});
