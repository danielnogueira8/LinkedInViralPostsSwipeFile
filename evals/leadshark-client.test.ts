import { describe, test, expect } from "vitest";
import {
  isActivityUrn,
  assertActivityUrn,
  mapLeadSharkError,
} from "@/lib/leadshark";

// ---------------------------------------------------------------------------
// Pure-logic tests for the LeadShark client: the URN guard (the one thing that,
// wrong, ships a broken-but-healthy-looking automation) and the error-kind
// mapping (which decides whether we invalidate the user's key).
// ---------------------------------------------------------------------------

describe("activity URN validation", () => {
  test("accepts a well-formed activity URN", () => {
    expect(isActivityUrn("urn:li:activity:7483415302685257728")).toBe(true);
  });

  test("REJECTS a share URN (the namespace trap)", () => {
    // This is the exact failure mode the plan warns about: a share URN string
    // must never pass, because LeadShark's matcher would silently never bind.
    expect(isActivityUrn("urn:li:share:7483415302685257728")).toBe(false);
  });

  test("rejects ugcPost, bare numbers, empty, and null", () => {
    expect(isActivityUrn("urn:li:ugcPost:7483415302685257728")).toBe(false);
    expect(isActivityUrn("7483415302685257728")).toBe(false);
    expect(isActivityUrn("urn:li:activity:")).toBe(false);
    expect(isActivityUrn("urn:li:activity:abc")).toBe(false);
    expect(isActivityUrn("")).toBe(false);
    expect(isActivityUrn(null)).toBe(false);
    expect(isActivityUrn(undefined)).toBe(false);
  });

  test("assertActivityUrn returns the value on success, throws on a share URN", () => {
    expect(assertActivityUrn("urn:li:activity:12345")).toBe("urn:li:activity:12345");
    expect(() => assertActivityUrn("urn:li:share:12345")).toThrow(/non-activity URN/);
    expect(() => assertActivityUrn(null)).toThrow();
  });
});

describe("error mapping", () => {
  test("401 → unauthorized (invalidate the key)", () => {
    expect(mapLeadSharkError(401, "").kind).toBe("unauthorized");
  });

  test("403 → forbidden (plan / Pro+)", () => {
    expect(mapLeadSharkError(403, "").kind).toBe("forbidden");
  });

  test("429 → rate_limited", () => {
    expect(mapLeadSharkError(429, "").kind).toBe("rate_limited");
  });

  test("5xx → transient (retryable)", () => {
    expect(mapLeadSharkError(500, "").kind).toBe("transient");
    expect(mapLeadSharkError(503, "server error").kind).toBe("transient");
    expect(mapLeadSharkError(0, "").kind).toBe("transient"); // network
  });

  test("a plain 400 → bad_request and surfaces LeadShark's message", () => {
    const e = mapLeadSharkError(400, "keywords must be an array");
    expect(e.kind).toBe("bad_request");
    expect(e.message).toContain("keywords must be an array");
  });

  test("400 about LinkedIn-not-connected is NOT treated as a key problem", () => {
    // The key is fine; LeadShark just has no LinkedIn account. Must not be
    // 'unauthorized' (which would wrongly mark the credential invalid).
    const e = mapLeadSharkError(400, "LinkedIn account is not connected");
    expect(e.kind).toBe("linkedin_not_connected");
    expect(e.kind).not.toBe("unauthorized");
  });

  test("error messages never echo a request/key (they read from the response body only)", () => {
    // Sanity: our mapped copy for auth failures is a fixed string, not a reflection.
    expect(mapLeadSharkError(401, "x-api-key: ls_live_SECRET").message).not.toContain(
      "ls_live_SECRET",
    );
  });
});
