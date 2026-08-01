import { describe, expect, test } from "vitest";

import { extractUrnFromUrl } from "@/lib/linkedin-url";

describe("extractUrnFromUrl host validation", () => {
  test("rejects LinkedIn URN-looking paths on untrusted hosts", () => {
    expect(
      extractUrnFromUrl(
        "https://example.com/feed/update/urn:li:activity:7420000000000000000",
      ),
    ).toBeNull();
    expect(
      extractUrnFromUrl(
        "https://linkedin.com.evil.test/feed/update/urn:li:activity:7420000000000000000",
      ),
    ).toBeNull();
  });
});
