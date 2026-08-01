import { describe, expect, test } from "vitest";
import {
  shouldRedirectFromWelcome,
  stepAfterAlreadyConnected,
} from "@/app/(app)/welcome/oauth-return-policy";
import { isCurrentVoicePoll } from "@/app/(app)/dashboard/voice/poll-ownership";
import {
  isCurrentKnowledgeRequest,
} from "@/app/(app)/dashboard/knowledge/request-ownership";

describe("workspace surface race regressions", () => {
  test("keeps an onboarded user on the welcome wizard for an OAuth result", () => {
    expect(shouldRedirectFromWelcome(true, "connected")).toBe(false);
    expect(shouldRedirectFromWelcome(true, "connect_failed")).toBe(false);
    expect(shouldRedirectFromWelcome(true, undefined)).toBe(true);
  });

  test("already-connected OAuth advances onboarding instead of leaving the user on step four", () => {
    expect(stepAfterAlreadyConnected(true)).toBe(5);
    expect(stepAfterAlreadyConnected(false)).toBeNull();
  });

  test("a stale voice poll cannot apply after a newer generation owns the row", () => {
    expect(isCurrentVoicePoll(1, 2)).toBe(false);
    expect(isCurrentVoicePoll(2, 2)).toBe(true);
  });

  test("a stale knowledge response cannot replace the current source snapshot", () => {
    expect(isCurrentKnowledgeRequest(3, 4)).toBe(false);
    expect(isCurrentKnowledgeRequest(4, 4)).toBe(true);
  });
});
